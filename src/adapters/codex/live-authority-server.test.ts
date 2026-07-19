import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sealLiveWorkspaceCandidate } from "@/adapters/artifact-promotion/server";
import type { ArtifactCandidateReceipt } from "@/adapters/artifact-promotion/schema";
import {
  parseWorldstateLedgerDocument,
  worldstateLedgerDocument,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";
import {
  appendLedgerEvent,
  RevisionRecordSchema,
  runAuthorizedEvent,
  type LedgerEvent,
  type WorldstateLedger,
} from "@/domain";
import { createLiveWorkerClosureFixture } from "@/fixtures";

import {
  authorizeAndPublishLiveRun,
  dispatchAuthorizedLiveRequest,
  getAgentRuntimeCapability,
  getLiveRunStatus,
  LiveAuthorityServerError,
  verifyPrivateCompletedLiveCandidate,
} from "./live-authority-server";
import {
  AgentRunFailureSchema,
  AgentRunSuccessSchema,
  type AgentRunRequest,
  type AgentRunResponse,
} from "./schema";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

interface PreparedFixture {
  readonly root: string;
  readonly workspace: string;
  readonly ledgerFile: string;
  readonly head: string;
  readonly document: WorldstateLedgerDocument;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runId: string;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function queuedLiveDocument(artifactBaseRef: string): {
  readonly document: WorldstateLedgerDocument;
  readonly runId: string;
} {
  const fixture = createLiveWorkerClosureFixture();
  const authorizationIndex = fixture.ledger.events.findIndex(
    (event) => event.type === "run.authorized",
  );
  if (authorizationIndex < 0)
    throw new Error("Expected an authorized live run fixture.");
  const events = structuredClone(
    fixture.ledger.events.slice(0, authorizationIndex + 1),
  ).map((event): LedgerEvent => {
    if (event.type === "brief.compiled") {
      return {
        ...event,
        payload: {
          brief: { ...event.payload.brief, artifactBaseRef },
        },
      };
    }
    if (event.type === "run.authorized") {
      return {
        ...event,
        payload: {
          run: { ...event.payload.run, artifactBaseRef },
        },
      };
    }
    return event;
  });
  return {
    runId: fixture.ids.run,
    document: worldstateLedgerDocument({
      ledger: { ...fixture.ledger, events },
      projectLabel: "Live authority test",
      updatedAt: "2026-07-18T12:00:00.000Z",
    }),
  };
}

async function git(workspace: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", workspace, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function preparedFixture(): Promise<PreparedFixture> {
  // WSL may map os.tmpdir() to a Windows filesystem that cannot enforce the
  // private POSIX owner/mode contract required by the candidate store.
  const root = await mkdtemp("/tmp/odeu-live-authority-");
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const ledgerDirectory = join(root, "ledger");
  const ledgerFile = join(ledgerDirectory, "worldstate.json");
  await Promise.all([
    mkdir(workspace),
    mkdir(codexHome),
    mkdir(ledgerDirectory),
  ]);
  await git(workspace, "init");
  await git(workspace, "config", "user.name", "ODEU Test");
  await git(workspace, "config", "user.email", "odeu@example.invalid");
  await writeFile(join(workspace, "README.md"), "prepared\n", "utf8");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-m", "prepared fixture");
  const head = await git(workspace, "rev-parse", "HEAD");
  const targetRef = await git(workspace, "symbolic-ref", "HEAD");
  const queued = queuedLiveDocument(`git:${head}`);
  await writeFile(ledgerFile, "{}\n", { encoding: "utf8", mode: 0o600 });
  return {
    root,
    workspace,
    ledgerFile,
    head,
    document: queued.document,
    runId: queued.runId,
    env: {
      PATH: process.env.PATH,
      ODEU_CODEX_MODE: "live",
      ODEU_CODEX_WORKSPACE: workspace,
      ODEU_CODEX_HOME: codexHome,
      ODEU_CODEX_LEDGER_FILE: ledgerFile,
      ODEU_CODEX_AUTH_SECRET: "test-live-authority-secret",
      ODEU_CODEX_REPOSITORY_ID: "repository-live-authority-test",
      ODEU_CODEX_PROMOTION_TARGET_REF: targetRef,
      ODEU_CODEX_CANDIDATE_STORE: join(root, "candidate-store"),
      ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID: "artifact-key-test",
      ODEU_CODEX_ARTIFACT_SIGNING_SECRET:
        "artifact-signing-secret-at-least-32-bytes",
      CODEX_API_KEY: "test-api-key",
      ODEU_CODEX_ALLOW_PRIMARY_WORKTREE: "true",
    },
  };
}

function requestInput(
  fixture: PreparedFixture,
  requestId = "request-live-authority",
) {
  return {
    document: fixture.document,
    runId: fixture.runId,
    requestId,
  };
}

function additionalQueuedLiveDocument(fixture: PreparedFixture): {
  readonly document: WorldstateLedgerDocument;
  readonly runId: string;
} {
  const originalAuthorization = fixture.document.events.find(
    (event) => event.type === "run.authorized",
  );
  if (!originalAuthorization) {
    throw new Error("Expected an existing queued live authorization.");
  }
  const runId = `${fixture.runId}-second`;
  const ledger: WorldstateLedger = {
    projectId: fixture.document.projectId,
    genesisRevision: RevisionRecordSchema.parse(
      fixture.document.metadata.genesisRevision,
    ),
    events: fixture.document.events,
  };
  const withSecondRun = appendLedgerEvent(
    ledger,
    runAuthorizedEvent({
      eventId: "event-authorize-second-live-run",
      commandId: "command-authorize-second-live-run",
      occurredAt: "2026-07-18T12:00:01.000Z",
      actor: originalAuthorization.actor,
      payload: {
        run: { ...originalAuthorization.payload.run, id: runId },
      },
    }),
  ).ledger;
  return {
    runId,
    document: worldstateLedgerDocument({
      ledger: withSecondRun,
      projectLabel: "Live authority test with second run",
      updatedAt: "2026-07-18T12:00:01.000Z",
    }),
  };
}

function typedFailure(): AgentRunResponse {
  return AgentRunFailureSchema.parse({
    ok: false,
    runtime: {
      requestedMode: "live",
      effectiveMode: "live",
      status: "failed",
      provider: "codex",
      replayIdentity: null,
      replayKind: null,
    },
    error: {
      code: "worker_failed",
      message: "The test worker returned a typed failure.",
      issues: [],
    },
    briefPreserved: true,
    resumable: false,
    resumeSupported: false,
    blockedRun: null,
  });
}

async function sealedCandidate(
  fixture: PreparedFixture,
  request: AgentRunRequest,
): Promise<ArtifactCandidateReceipt> {
  await writeFile(
    join(fixture.workspace, "README.md"),
    "candidate result\n",
    "utf8",
  );
  return (
    await sealLiveWorkspaceCandidate({
      workspace: fixture.workspace,
      repositoryId: fixture.env.ODEU_CODEX_REPOSITORY_ID!,
      targetRef: fixture.env.ODEU_CODEX_PROMOTION_TARGET_REF!,
      expectedBaseCommit: fixture.head,
      runId: request.runId,
      briefId: request.brief.briefId,
      baseRevisionId: request.brief.sourceRevisionId,
      sealedAt: "2026-07-18T12:02:00.000Z",
      candidateStoreDirectory: fixture.env.ODEU_CODEX_CANDIDATE_STORE!,
      signing: {
        keyId: fixture.env.ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID!,
        secret: fixture.env.ODEU_CODEX_ARTIFACT_SIGNING_SECRET!,
      },
    })
  ).receipt;
}

function returnedResponse(
  request: AgentRunRequest,
  candidate: ArtifactCandidateReceipt,
): AgentRunResponse {
  return AgentRunSuccessSchema.parse({
    ok: true,
    runtime: {
      requestedMode: "live",
      effectiveMode: "live",
      status: "returned",
      provider: "codex",
      replayIdentity: null,
      replayKind: null,
    },
    events: [
      {
        sequence: 0,
        status: "queued",
        at: "2026-07-18T12:01:00.000Z",
        label: "Queued",
        detail: "Queued privately.",
      },
      {
        sequence: 1,
        status: "received",
        at: "2026-07-18T12:01:10.000Z",
        label: "Received",
        detail: "Received privately.",
      },
      {
        sequence: 2,
        status: "working",
        at: "2026-07-18T12:01:20.000Z",
        label: "Working",
        detail: "Working privately.",
      },
      {
        sequence: 3,
        status: "returned",
        at: "2026-07-18T12:02:00.000Z",
        label: "Returned",
        detail: "Returned exact candidate.",
      },
    ],
    closure: {
      runId: request.runId,
      briefId: request.brief.briefId,
      sourceRevisionIdUsed: request.brief.sourceRevisionId,
      artifactBaseRefUsed: request.brief.artifactBaseRef,
      workerThreadId: "thread-private-returned",
      workerItemIds: [],
      report: {
        outcome: "returned",
        claimedEffects: ["Changed the declared artifact."],
        claimedArtifacts: [],
        claimedChecks: [],
        failures: [],
        unresolved: [],
        completionClaim: {
          claimedDone: true,
          criteriaClaimedSatisfied: request.brief.doneMeans.map(() => true),
        },
        candidateReconciliationSummary: "Review the exact private candidate.",
      },
      sdkObservations: { fileChanges: [], commands: [] },
      artifactCandidate: candidate,
    },
  });
}

describe("live browser-to-server authority handoff", () => {
  it("accepts the prepared linked-worktree topology used for live execution", async () => {
    const fixture = await preparedFixture();
    const linkedWorkspace = join(fixture.root, "linked-workspace");
    await git(
      fixture.workspace,
      "worktree",
      "add",
      "--detach",
      linkedWorkspace,
      fixture.head,
    );
    const linkedFixture: PreparedFixture = {
      ...fixture,
      workspace: linkedWorkspace,
      env: {
        ...fixture.env,
        ODEU_CODEX_WORKSPACE: linkedWorkspace,
        ODEU_CODEX_ALLOW_PRIMARY_WORKTREE: undefined,
      },
    };

    await expect(
      getAgentRuntimeCapability({ env: linkedFixture.env }),
    ).resolves.toMatchObject({
      effectiveMode: "live",
      status: "available",
      artifactBaseRef: `git:${fixture.head}`,
    });
    await expect(
      authorizeAndPublishLiveRun(requestInput(linkedFixture), {
        env: linkedFixture.env,
      }),
    ).resolves.toMatchObject({
      runId: fixture.runId,
    });
  });

  it("runs Git probes without server secrets or configured fsmonitor helpers", async () => {
    const fixture = await preparedFixture();
    const fsmonitorMarker = join(fixture.root, "fsmonitor-invoked");
    const fsmonitor = join(fixture.root, "malicious-fsmonitor.sh");
    await writeFile(
      fsmonitor,
      `#!/bin/sh\nprintf 'invoked\\n' > ${shellQuote(fsmonitorMarker)}\nexit 1\n`,
      "utf8",
    );
    await chmod(fsmonitor, 0o700);
    await git(fixture.workspace, "config", "core.fsmonitor", fsmonitor);

    const wrapperDirectory = join(fixture.root, "git-wrapper");
    const probeEnvironmentLog = join(fixture.root, "git-probe-environment");
    await mkdir(wrapperDirectory);
    const originalPath = process.env.PATH ?? "/usr/bin:/bin";
    const wrappedPath = `${wrapperDirectory}:${originalPath}`;
    const wrapper = join(wrapperDirectory, "git");
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        `{ printf 'OPENAI_API_KEY=%s\\n' "\${OPENAI_API_KEY-<unset>}";`,
        `  printf 'CODEX_API_KEY=%s\\n' "\${CODEX_API_KEY-<unset>}";`,
        `  printf 'ODEU_CODEX_AUTH_SECRET=%s\\n' "\${ODEU_CODEX_AUTH_SECRET-<unset>}";`,
        `  printf 'ODEU_CODEX_ARTIFACT_SIGNING_SECRET=%s\\n' "\${ODEU_CODEX_ARTIFACT_SIGNING_SECRET-<unset>}";`,
        `  printf 'GIT_CONFIG_NOSYSTEM=%s\\n' "\${GIT_CONFIG_NOSYSTEM-<unset>}";`,
        `  printf 'GIT_CONFIG_GLOBAL=%s\\n' "\${GIT_CONFIG_GLOBAL-<unset>}";`,
        `  printf 'GIT_OPTIONAL_LOCKS=%s\\n' "\${GIT_OPTIONAL_LOCKS-<unset>}";`,
        `  printf 'GIT_ALLOW_PROTOCOL=%s\\n' "\${GIT_ALLOW_PROTOCOL-<unset>}";`,
        `  printf 'GIT_PROTOCOL_FROM_USER=%s\\n' "\${GIT_PROTOCOL_FROM_USER-<unset>}";`,
        `  printf 'GIT_NO_LAZY_FETCH=%s\\n' "\${GIT_NO_LAZY_FETCH-<unset>}";`,
        `  printf 'ARGS=%s\\n' "$*"; } >> ${shellQuote(probeEnvironmentLog)}`,
        `PATH=${shellQuote(originalPath)} exec git "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(wrapper, 0o700);

    vi.stubEnv("PATH", wrappedPath);
    vi.stubEnv("OPENAI_API_KEY", "process-openai-provider-secret");
    vi.stubEnv("CODEX_API_KEY", "process-codex-provider-secret");
    vi.stubEnv("ODEU_CODEX_AUTH_SECRET", "process-live-authority-secret");
    vi.stubEnv(
      "ODEU_CODEX_ARTIFACT_SIGNING_SECRET",
      "process-artifact-signing-secret",
    );

    await expect(
      getAgentRuntimeCapability({
        env: { ...fixture.env, PATH: wrappedPath },
      }),
    ).resolves.toMatchObject({
      effectiveMode: "live",
      status: "available",
    });

    const captured = await readFile(probeEnvironmentLog, "utf8");
    expect(captured).toContain("OPENAI_API_KEY=<unset>");
    expect(captured).toContain("CODEX_API_KEY=<unset>");
    expect(captured).toContain("ODEU_CODEX_AUTH_SECRET=<unset>");
    expect(captured).toContain(
      "ODEU_CODEX_ARTIFACT_SIGNING_SECRET=<unset>",
    );
    expect(captured).not.toContain("process-openai-provider-secret");
    expect(captured).not.toContain("process-codex-provider-secret");
    expect(captured).not.toContain("process-live-authority-secret");
    expect(captured).not.toContain("process-artifact-signing-secret");
    expect(captured).toContain("GIT_CONFIG_NOSYSTEM=1");
    const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    expect(captured).toContain(`GIT_CONFIG_GLOBAL=${gitNullDevice}`);
    expect(captured).toContain("GIT_OPTIONAL_LOCKS=0");
    expect(captured).toContain("GIT_ALLOW_PROTOCOL=");
    expect(captured).toContain("GIT_PROTOCOL_FROM_USER=0");
    expect(captured).toContain("GIT_NO_LAZY_FETCH=1");
    expect(captured).toContain("-c core.fsmonitor=false");
    expect(captured).toContain(`-c core.hooksPath=${gitNullDevice}`);
    const [firstGitProbe] = captured
      .split("\n")
      .filter((line) => line.startsWith("ARGS="));
    expect(firstGitProbe).toContain("ARGS=config --file ");
    expect(firstGitProbe).toContain(" --no-includes --null --name-only --list");
    expect(firstGitProbe).not.toContain(" -C ");
    await expect(access(fsmonitorMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    "include.path",
    "includeIf.gitdir:/definitely-not-the-live-workspace/.path",
  ] as const)(
    "rejects a repository-controlled %s directive before other Git probes",
    async (configKey) => {
      const fixture = await preparedFixture();
      const includedConfig = join(fixture.root, "malformed-included-config");
      await writeFile(includedConfig, "[malformed\n", "utf8");
      await git(
        fixture.workspace,
        "config",
        "--local",
        configKey,
        includedConfig,
      );

      const options = { env: fixture.env };
      await expect(getAgentRuntimeCapability(options)).resolves.toMatchObject({
        effectiveMode: "live",
        status: "unavailable",
      });
      await expect(
        authorizeAndPublishLiveRun(requestInput(fixture), options),
      ).rejects.toMatchObject({
        code: "workspace_not_ready",
        cause: { message: "repository-controlled Git helper is not allowed" },
      });
    },
  );

  it("rejects an active worktree include without opening its malformed target", async () => {
    const fixture = await preparedFixture();
    const includedConfig = join(
      fixture.root,
      "malformed-worktree-included-config",
    );
    await writeFile(includedConfig, "[malformed\n", "utf8");
    await git(fixture.workspace, "config", "extensions.worktreeConfig", "true");
    await git(
      fixture.workspace,
      "config",
      "--worktree",
      "include.path",
      includedConfig,
    );

    const options = { env: fixture.env };
    await expect(getAgentRuntimeCapability(options)).resolves.toMatchObject({
      effectiveMode: "live",
      status: "unavailable",
    });
    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), options),
    ).rejects.toMatchObject({
      code: "workspace_not_ready",
      cause: { message: "repository-controlled Git helper is not allowed" },
    });
  });

  it.each(["clean", "smudge", "process"] as const)(
    "rejects a repository-controlled %s filter before Git can execute it",
    async (filterKind) => {
      const fixture = await preparedFixture();
      const marker = join(fixture.root, `${filterKind}-filter-invoked`);
      const filter = join(fixture.root, `${filterKind}-filter.sh`);
      await writeFile(
        filter,
        [
          "#!/bin/sh",
          `printf 'invoked\\n' > ${shellQuote(marker)}`,
          "cat",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(filter, 0o700);
      if (filterKind === "clean") {
        await writeFile(
          join(fixture.workspace, ".gitattributes"),
          "README.md filter=untrusted\n",
          "utf8",
        );
        await git(fixture.workspace, "add", ".gitattributes");
        await git(
          fixture.workspace,
          "commit",
          "-m",
          "add untrusted filter attribute",
        );
      }
      await git(
        fixture.workspace,
        "config",
        `filter.untrusted.${filterKind}`,
        filter,
      );

      const options = { env: fixture.env };
      await expect(getAgentRuntimeCapability(options)).resolves.toMatchObject({
        effectiveMode: "live",
        status: "unavailable",
      });
      await expect(
        authorizeAndPublishLiveRun(requestInput(fixture), options),
      ).rejects.toMatchObject({ code: "workspace_not_ready" });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects repository-controlled partial-clone helpers before resolving objects", async () => {
    const fixture = await preparedFixture();
    const marker = join(fixture.root, "partial-clone-helper-invoked");
    const uploadPack = join(fixture.root, "untrusted-upload-pack.sh");
    await writeFile(
      uploadPack,
      [
        "#!/bin/sh",
        `printf 'invoked\\n' > ${shellQuote(marker)}`,
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(uploadPack, 0o700);
    await git(fixture.workspace, "config", "remote.untrusted.promisor", "true");
    await git(
      fixture.workspace,
      "config",
      "remote.untrusted.partialclonefilter",
      "blob:none",
    );
    await git(
      fixture.workspace,
      "config",
      "remote.untrusted.uploadpack",
      uploadPack,
    );
    await git(
      fixture.workspace,
      "config",
      "remote.untrusted.url",
      fixture.workspace,
    );

    const options = { env: fixture.env };
    await expect(getAgentRuntimeCapability(options)).resolves.toMatchObject({
      effectiveMode: "live",
      status: "unavailable",
    });
    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), options),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an initialized submodule before status can execute its filter", async () => {
    const fixture = await preparedFixture();
    const submoduleSource = join(fixture.root, "submodule-source");
    await mkdir(submoduleSource);
    await git(submoduleSource, "init");
    await git(submoduleSource, "config", "user.name", "ODEU Test");
    await git(
      submoduleSource,
      "config",
      "user.email",
      "odeu@example.invalid",
    );
    await writeFile(
      join(submoduleSource, ".gitattributes"),
      "tracked.txt filter=untrusted\n",
      "utf8",
    );
    await writeFile(join(submoduleSource, "tracked.txt"), "seed\n", "utf8");
    await git(submoduleSource, "add", ".gitattributes", "tracked.txt");
    await git(submoduleSource, "commit", "-m", "submodule seed");

    const submodulePath = "vendor/submodule";
    await git(
      fixture.workspace,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleSource,
      submodulePath,
    );
    await git(fixture.workspace, "commit", "-m", "add initialized submodule");

    const marker = join(fixture.root, "submodule-filter-invoked");
    const filter = join(fixture.root, "submodule-filter.sh");
    await writeFile(
      filter,
      [
        "#!/bin/sh",
        `printf 'invoked\\n' > ${shellQuote(marker)}`,
        "cat",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(filter, 0o700);
    const initializedSubmodule = join(fixture.workspace, submodulePath);
    await git(
      initializedSubmodule,
      "config",
      "filter.untrusted.clean",
      filter,
    );
    await writeFile(
      join(initializedSubmodule, "tracked.txt"),
      "dirty submodule content\n",
      "utf8",
    );

    const options = { env: fixture.env };
    await expect(getAgentRuntimeCapability(options)).resolves.toMatchObject({
      effectiveMode: "live",
      status: "unavailable",
    });
    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), options),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the promotion target to be a direct commit ref", async () => {
    const annotatedFixture = await preparedFixture();
    await git(
      annotatedFixture.workspace,
      "tag",
      "-a",
      "promotion-annotated",
      "-m",
      "annotated promotion target",
    );
    const annotatedOptions = {
      env: {
        ...annotatedFixture.env,
        ODEU_CODEX_PROMOTION_TARGET_REF: "refs/tags/promotion-annotated",
      },
    };
    await expect(
      getAgentRuntimeCapability(annotatedOptions),
    ).resolves.toMatchObject({ effectiveMode: "live", status: "unavailable" });
    await expect(
      authorizeAndPublishLiveRun(
        requestInput(annotatedFixture),
        annotatedOptions,
      ),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });

    const symbolicFixture = await preparedFixture();
    const directTarget = symbolicFixture.env.ODEU_CODEX_PROMOTION_TARGET_REF!;
    await git(
      symbolicFixture.workspace,
      "symbolic-ref",
      "refs/heads/promotion-symbolic",
      directTarget,
    );
    const symbolicOptions = {
      env: {
        ...symbolicFixture.env,
        ODEU_CODEX_PROMOTION_TARGET_REF: "refs/heads/promotion-symbolic",
      },
    };
    await expect(
      getAgentRuntimeCapability(symbolicOptions),
    ).resolves.toMatchObject({ effectiveMode: "live", status: "unavailable" });
    await expect(
      authorizeAndPublishLiveRun(
        requestInput(symbolicFixture),
        symbolicOptions,
      ),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });
  });

  it("reports only a safe capability and atomically publishes an exact queued run intent", async () => {
    const fixture = await preparedFixture();
    const options = {
      env: fixture.env,
      now: () => new Date("2026-07-18T12:01:00.000Z"),
      nonce: () => "00000000-0000-4000-8000-000000000099",
    };

    const capability = await getAgentRuntimeCapability(options);
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );

    expect(capability).toEqual({
      requestedMode: "live",
      effectiveMode: "live",
      status: "available",
      artifactBaseRef: `git:${fixture.head}`,
      reason: null,
    });
    expect(JSON.stringify(capability)).not.toContain(fixture.root);
    expect(JSON.stringify(capability)).not.toContain(
      "test-live-authority-secret",
    );
    expect(request).toMatchObject({
      runId: fixture.runId,
      requestId: "request-live-authority",
      mode: "live",
      brief: { artifactBaseRef: `git:${fixture.head}` },
      authorization: {
        nonce: "00000000-0000-4000-8000-000000000099",
        issuedAt: "2026-07-18T12:01:00.000Z",
      },
    });
    expect(
      parseWorldstateLedgerDocument(
        JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
      ),
    ).toEqual(fixture.document);
    await expect(
      getLiveRunStatus(
        { runId: fixture.runId, requestId: "request-live-authority" },
        options,
      ),
    ).resolves.toEqual({ status: "not_started", response: null });

    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), options),
    ).resolves.toEqual(request);
    await expect(
      authorizeAndPublishLiveRun(
        requestInput(fixture, "request-live-authority-other"),
        options,
      ),
    ).rejects.toMatchObject({ code: "authorization_conflict" });
  });

  it("refuses a dirty workspace and an artifact base that differs from its actual HEAD", async () => {
    const dirtyFixture = await preparedFixture();
    await writeFile(
      join(dirtyFixture.workspace, "untracked.txt"),
      "dirty\n",
      "utf8",
    );

    await expect(
      authorizeAndPublishLiveRun(requestInput(dirtyFixture), {
        env: dirtyFixture.env,
      }),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });

    const mismatchFixture = await preparedFixture();
    const mismatch = queuedLiveDocument(`git:${"a".repeat(40)}`);
    await expect(
      authorizeAndPublishLiveRun(
        {
          document: mismatch.document,
          runId: mismatch.runId,
          requestId: "request-base-mismatch",
        },
        { env: mismatchFixture.env },
      ),
    ).rejects.toMatchObject({ code: "artifact_base_mismatch" });
  });

  it("rejects a symlinked authoritative ledger without modifying its target", async () => {
    const fixture = await preparedFixture();
    const target = join(fixture.root, "ledger-target.json");
    await writeFile(target, "target remains exact\n", "utf8");
    await unlink(fixture.ledgerFile);
    await symlink(target, fixture.ledgerFile, "file");

    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), { env: fixture.env }),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });
    await expect(readFile(target, "utf8")).resolves.toBe(
      "target remains exact\n",
    );
  });

  it("stores the exact typed response before return and makes retries read-only", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const response = typedFailure();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      markStarted();
      await wait;
      return response;
    });
    const dispatch = dispatchAuthorizedLiveRequest(request, execute, options);
    await started;

    await expect(
      getLiveRunStatus(
        { runId: request.runId, requestId: request.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "in_progress", response: null });
    release();
    await expect(dispatch).resolves.toEqual(response);
    await expect(
      getLiveRunStatus(
        { runId: request.runId, requestId: request.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "completed", response });

    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).resolves.toEqual(response);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("verifies a signed candidate only when the private completed response returned it exactly", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const candidate = await sealedCandidate(fixture, request);
    const response = returnedResponse(request, candidate);
    await dispatchAuthorizedLiveRequest(request, async () => response, options);

    await expect(
      verifyPrivateCompletedLiveCandidate(candidate, options),
    ).resolves.toMatchObject({
      candidate,
      request,
      response,
    });

    if (!response.ok) throw new Error("Expected returned response fixture.");
    expect(
      AgentRunSuccessSchema.safeParse({
        ...response,
        runtime: { ...response.runtime, status: "failed" },
        events: response.events.map((event, index) =>
          index === response.events.length - 1
            ? { ...event, status: "failed" }
            : event,
        ),
        closure: {
          ...response.closure,
          report: { ...response.closure.report, outcome: "failed" },
          artifactCandidate: candidate,
        },
      }).success,
    ).toBe(false);
  });

  it("serializes shared-ledger execution and retains immutable provenance across later runs", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const second = additionalQueuedLiveDocument(fixture);
    const firstRequest = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const secondRequest = await authorizeAndPublishLiveRun(
      {
        document: second.document,
        runId: second.runId,
        requestId: "request-second-live-run",
      },
      options,
    );

    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), options),
    ).resolves.toEqual(firstRequest);
    expect(
      parseWorldstateLedgerDocument(
        JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
      ),
    ).toEqual(second.document);

    const candidate = await sealedCandidate(fixture, firstRequest);
    const firstResponse = returnedResponse(firstRequest, candidate);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstDispatch = dispatchAuthorizedLiveRequest(
      firstRequest,
      async () => {
        expect(
          parseWorldstateLedgerDocument(
            JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
          ),
        ).toEqual(fixture.document);
        markFirstStarted();
        await firstWait;
        return firstResponse;
      },
      options,
    );
    await firstStarted;

    const executeSecond = vi.fn(async () => typedFailure());
    await expect(
      dispatchAuthorizedLiveRequest(secondRequest, executeSecond, options),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(executeSecond).not.toHaveBeenCalled();
    await expect(
      getLiveRunStatus(
        { runId: secondRequest.runId, requestId: secondRequest.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "not_started", response: null });

    releaseFirst();
    await expect(firstDispatch).resolves.toEqual(firstResponse);
    await expect(
      dispatchAuthorizedLiveRequest(secondRequest, executeSecond, options),
    ).resolves.toEqual(typedFailure());
    expect(executeSecond).toHaveBeenCalledOnce();
    expect(
      parseWorldstateLedgerDocument(
        JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
      ),
    ).toEqual(second.document);

    await expect(
      verifyPrivateCompletedLiveCandidate(candidate, options),
    ).resolves.toMatchObject({
      candidate,
      request: firstRequest,
      response: firstResponse,
    });
  });

  it("rejects a signed candidate when the private completed response failed without returning it", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const candidate = await sealedCandidate(fixture, request);
    await dispatchAuthorizedLiveRequest(
      request,
      async () => typedFailure(),
      options,
    );

    await expect(
      verifyPrivateCompletedLiveCandidate(candidate, options),
    ).rejects.toMatchObject({ code: "candidate_not_recorded" });
  });

  it("never repeats an execution whose durable start has no typed response", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const execute = vi.fn(async (): Promise<AgentRunResponse> => {
      throw new Error("simulated worker process loss");
    });

    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).rejects.toThrow("simulated worker process loss");
    await expect(
      getLiveRunStatus(
        { runId: request.runId, requestId: request.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "outcome_unknown", response: null });
    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).rejects.toBeInstanceOf(LiveAuthorityServerError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("treats a run claim without a response as outcome unknown", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const identity = createHash("sha256").update(request.runId).digest("hex");
    const claimDirectory = join(fixture.root, "ledger", "odeu-run-claims");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(
      join(claimDirectory, `${identity}.claimed.json`),
      "{}\n",
      "utf8",
    );
    const execute = vi.fn(async () => typedFailure());

    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(execute).not.toHaveBeenCalled();
  });
});
