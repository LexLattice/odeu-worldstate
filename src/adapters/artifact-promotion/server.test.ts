import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsLinkTestHooks = vi.hoisted(() => ({
  beforeLink: null as
    | null
    | ((
        source: string,
        destination: string,
        install: () => Promise<void>,
      ) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      const [source, destination] = args;
      const hook = fsLinkTestHooks.beforeLink;
      if (
        hook &&
        typeof source === "string" &&
        typeof destination === "string"
      ) {
        await hook(source, destination, () => actual.link(...args));
      }
      return actual.link(...args);
    },
  };
});

vi.mock("server-only", () => ({}));

import {
  ARTIFACT_PROMOTION_REPOSITORY_LOCK,
  ArtifactPromotionBoundaryError,
  getArtifactPromotionStatus as getArtifactPromotionStatusBoundary,
  promoteArtifactCandidate as promoteArtifactCandidateBoundary,
  sealLiveWorkspaceCandidate,
  verifyArtifactCandidateReceipt,
  type ArtifactPromotionAuthorityBinding,
  type GetArtifactPromotionStatusInput,
  type PromoteArtifactCandidateInput,
} from "./server";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const SIGNING_SECRET = "artifact-receipt-test-secret-000000000000000000000000";
const SIGNING = { keyId: "artifact-key-v1", secret: SIGNING_SECRET } as const;
const SEALED_AT = "2026-07-18T12:00:00.000Z";
const TARGET_REF = "refs/heads/authoritative";
const TEST_PROMOTION_AUTHORITY: ArtifactPromotionAuthorityBinding = {
  projectId: "project-home-move-test",
  semanticHeadRevisionId: "rev-live-001",
  authorizedEventId: "event-artifact-promotion-authorized-test",
  authorizedAt: "2026-07-18T12:04:00.000Z",
  ledgerVersion: {
    headRevisionId: "rev-live-001",
    eventCount: 42,
    eventLogFingerprint: "fnv1a64:0123456789abcdef",
  },
  ledgerPrefixDigest: `sha256:${"9".repeat(64)}`,
};

function promoteArtifactCandidate(
  input: Omit<PromoteArtifactCandidateInput, "authority"> & {
    readonly authority?: ArtifactPromotionAuthorityBinding;
  },
) {
  return promoteArtifactCandidateBoundary({
    ...input,
    authority: input.authority ?? TEST_PROMOTION_AUTHORITY,
  });
}

function getArtifactPromotionStatus(
  input: Omit<GetArtifactPromotionStatusInput, "authority"> & {
    readonly authority?: ArtifactPromotionAuthorityBinding;
  },
) {
  return getArtifactPromotionStatusBoundary({
    ...input,
    authority: input.authority ?? TEST_PROMOTION_AUTHORITY,
  });
}

afterEach(async () => {
  fsLinkTestHooks.beforeLink = null;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout.trim();
}

interface TestRepository {
  readonly root: string;
  readonly repository: string;
  readonly authoritativeRepository: string;
  readonly store: string;
  readonly baseCommit: string;
}

async function createRepository(): Promise<TestRepository> {
  // The production boundary requires POSIX private-mode enforcement; keep the
  // fixture on the Linux filesystem instead of a WSL-mounted Windows temp dir.
  const root = await mkdtemp(join("/tmp", "odeu-artifact-promotion-"));
  temporaryDirectories.push(root);
  const seed = join(root, "seed");
  const authoritativeRepository = join(root, "authoritative.git");
  const repository = join(root, "workspace");
  const store = join(root, "receipts");
  await mkdir(seed, { recursive: true });
  await git(seed, "init", "--initial-branch=worker");
  await git(seed, "config", "user.name", "ODEU Test");
  await git(seed, "config", "user.email", "odeu-test@example.invalid");
  await writeFile(join(seed, ".gitignore"), "ignored.log\n", "utf8");
  await writeFile(join(seed, "alpha.txt"), "alpha v1\n", "utf8");
  await writeFile(join(seed, "deleted.txt"), "delete me\n", "utf8");
  await git(seed, "add", ".gitignore", "alpha.txt", "deleted.txt");
  await git(seed, "commit", "-m", "base");
  const baseCommit = await git(seed, "rev-parse", "HEAD");

  await mkdir(authoritativeRepository);
  await git(
    authoritativeRepository,
    "init",
    "--bare",
    "--initial-branch=worker",
  );
  await git(seed, "remote", "add", "authority", authoritativeRepository);
  await git(
    seed,
    "push",
    "authority",
    `${baseCommit}:refs/heads/worker`,
    `${baseCommit}:${TARGET_REF}`,
  );
  await git(authoritativeRepository, "worktree", "add", repository, "worker");
  await git(repository, "config", "user.name", "ODEU Test");
  await git(repository, "config", "user.email", "odeu-test@example.invalid");
  return { root, repository, authoritativeRepository, store, baseCommit };
}

function sealInput(fixture: TestRepository, targetRef = TARGET_REF) {
  return {
    workspace: fixture.repository,
    repositoryId: "repository-home-move",
    targetRef,
    expectedBaseCommit: fixture.baseCommit,
    runId: "run-live-001",
    briefId: "brief-live-001",
    baseRevisionId: "rev-live-001",
    sealedAt: SEALED_AT,
    candidateStoreDirectory: fixture.store,
    signing: SIGNING,
  } as const;
}

async function createReviewableChanges(fixture: TestRepository): Promise<void> {
  await writeFile(join(fixture.repository, "alpha.txt"), "alpha v2\n", "utf8");
  await writeFile(
    join(fixture.repository, "binary.dat"),
    Buffer.from([0, 1, 2, 3, 255, 10]),
  );
  await unlink(join(fixture.repository, "deleted.txt"));
}

describe("live Git artifact candidate sealing", () => {
  it("seals an exact deterministic tree through an alternate index and retains a signed candidate ref", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);

    const first = await sealLiveWorkspaceCandidate(sealInput(fixture));
    const second = await sealLiveWorkspaceCandidate(sealInput(fixture));

    expect(second.receipt).toEqual(first.receipt);
    expect(second.receiptPath).toBe(first.receiptPath);
    expect(first.receipt.metadata.git.baseCommit).toBe(fixture.baseCommit);
    expect(first.receipt.metadata.git.candidateTree).not.toBe(
      first.receipt.metadata.git.baseTree,
    );
    expect(first.receipt.metadata.patch.digest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(first.receipt.metadata.patch.byteLength).toBeGreaterThan(0);
    expect(first.receipt.metadata.manifest.entries).toEqual([
      expect.objectContaining({ path: "alpha.txt", status: "modified" }),
      expect.objectContaining({ path: "binary.dat", status: "added" }),
      expect.objectContaining({ path: "deleted.txt", status: "deleted" }),
    ]);
    expect(
      await git(fixture.repository, "diff", "--cached", "--name-only"),
    ).toBe("");
    expect(
      await git(
        fixture.repository,
        "rev-parse",
        `${first.receipt.metadata.candidateRef}^{commit}`,
      ),
    ).toBe(first.receipt.metadata.git.candidateCommit);
    expect(
      await git(
        fixture.repository,
        "rev-parse",
        `${first.receipt.metadata.git.candidateCommit}^`,
      ),
    ).toBe(fixture.baseCommit);
    expect(
      verifyArtifactCandidateReceipt(first.receipt, {
        [SIGNING.keyId]: SIGNING_SECRET,
      }),
    ).toEqual(first.receipt);
    expect(JSON.parse(await readFile(first.receiptPath, "utf8"))).toEqual(
      first.receipt,
    );
  }, 20_000);

  it("atomically creates or adopts one complete receipt under concurrent sealing", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        sealLiveWorkspaceCandidate(sealInput(fixture)),
      ),
    );

    expect(
      results.every((result) => result.receiptPath === results[0]?.receiptPath),
    ).toBe(true);
    expect(
      results.every(
        (result) =>
          result.receipt.metadata.candidateId ===
          results[0]?.receipt.metadata.candidateId,
      ),
    ).toBe(true);
    expect(JSON.parse(await readFile(results[0]!.receiptPath, "utf8"))).toEqual(
      results[0]!.receipt,
    );
    expect(
      (await readdir(join(fixture.store, "candidates"))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  }, 20_000);

  it("rejects an annotated-tag candidate ref instead of adopting its peeled commit", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
    await git(
      fixture.repository,
      "tag",
      "-a",
      "candidate-indirection",
      "-m",
      "candidate indirection",
      sealed.receipt.metadata.git.candidateCommit,
    );
    const tagObject = await git(
      fixture.repository,
      "rev-parse",
      "refs/tags/candidate-indirection",
    );
    await git(
      fixture.authoritativeRepository,
      "update-ref",
      "--no-deref",
      sealed.receipt.metadata.candidateRef,
      tagObject,
      sealed.receipt.metadata.git.candidateCommit,
    );
    expect(
      await git(
        fixture.authoritativeRepository,
        "rev-parse",
        `${sealed.receipt.metadata.candidateRef}^{commit}`,
      ),
    ).toBe(sealed.receipt.metadata.git.candidateCommit);

    await expect(
      sealLiveWorkspaceCandidate(sealInput(fixture)),
    ).rejects.toMatchObject({ code: "candidate_conflict" });
    await expect(
      promoteArtifactCandidate({
        repository: fixture.authoritativeRepository,
        repositoryId: "repository-home-move",
        targetRef: TARGET_REF,
        expectedBaseCommit: fixture.baseCommit,
        candidate: sealed.receipt,
        signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
        statusStoreDirectory: fixture.store,
        attemptedAt: "2026-07-18T12:05:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(fixture.baseCommit);
  });

  it("returns a typed no_changes error for an exact base tree", async () => {
    const fixture = await createRepository();

    await expect(
      sealLiveWorkspaceCandidate(sealInput(fixture)),
    ).rejects.toMatchObject({
      name: "ArtifactCandidateSealError",
      code: "no_changes",
    });
  });

  it("rejects ignored content, unsafe names, symlinks, submodules, and oversized patches", async () => {
    const ignored = await createRepository();
    await writeFile(
      join(ignored.repository, "ignored.log"),
      "private\n",
      "utf8",
    );
    await expect(
      sealLiveWorkspaceCandidate(sealInput(ignored)),
    ).rejects.toMatchObject({
      code: "ignored_content",
    });

    const unsafe = await createRepository();
    await writeFile(
      join(unsafe.repository, "unsafe\nname.txt"),
      "unsafe\n",
      "utf8",
    );
    await expect(
      sealLiveWorkspaceCandidate(sealInput(unsafe)),
    ).rejects.toMatchObject({
      code: "unsafe_path",
    });

    const linked = await createRepository();
    await symlink("alpha.txt", join(linked.repository, "linked.txt"));
    await expect(
      sealLiveWorkspaceCandidate(sealInput(linked)),
    ).rejects.toMatchObject({
      code: "unsupported_mode",
    });

    const submodule = await createRepository();
    const nested = join(submodule.repository, "nested-repository");
    await mkdir(nested);
    await git(nested, "init", "--initial-branch=main");
    await git(nested, "config", "user.name", "Nested Test");
    await git(nested, "config", "user.email", "nested@example.invalid");
    await writeFile(join(nested, "nested.txt"), "nested\n", "utf8");
    await git(nested, "add", "nested.txt");
    await git(nested, "commit", "-m", "nested");
    await expect(
      sealLiveWorkspaceCandidate(sealInput(submodule)),
    ).rejects.toMatchObject({
      code: "unsupported_mode",
    });

    const oversized = await createRepository();
    await writeFile(join(oversized.repository, "alpha.txt"), "x".repeat(8_192));
    await expect(
      sealLiveWorkspaceCandidate({
        ...sealInput(oversized),
        limits: { maxPatchBytes: 128 },
      }),
    ).rejects.toMatchObject({ code: "evidence_oversized" });
  }, 30_000);

  it("rejects stale authorized HEAD and tampered signed metadata", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));

    await expect(
      sealLiveWorkspaceCandidate({
        ...sealInput(fixture),
        expectedBaseCommit: "0".repeat(fixture.baseCommit.length),
      }),
    ).rejects.toMatchObject({ code: "base_mismatch" });

    const tampered = {
      ...sealed.receipt,
      metadata: {
        ...sealed.receipt.metadata,
        targetRef: "refs/heads/other",
      },
    };
    expect(() =>
      verifyArtifactCandidateReceipt(tampered, {
        [SIGNING.keyId]: SIGNING_SECRET,
      }),
    ).toThrow(ArtifactPromotionBoundaryError);
  });

  it("ignores Git replacement refs while deriving the sealed base and candidate", async () => {
    const fixture = await createRepository();
    const originalBaseTree = await git(
      fixture.repository,
      "rev-parse",
      `${fixture.baseCommit}^{tree}`,
    );
    await writeFile(
      join(fixture.repository, "alpha.txt"),
      "replacement tree\n",
    );
    await git(fixture.repository, "add", "alpha.txt");
    await git(fixture.repository, "commit", "-m", "replacement object");
    const replacementCommit = await git(
      fixture.repository,
      "rev-parse",
      "HEAD",
    );
    await git(fixture.repository, "reset", "--hard", fixture.baseCommit);
    await git(
      fixture.repository,
      "replace",
      fixture.baseCommit,
      replacementCommit,
    );
    await createReviewableChanges(fixture);

    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));

    expect(sealed.receipt.metadata.git.baseTree).toBe(originalBaseTree);
    expect(sealed.receipt.metadata.manifest.entries).toEqual([
      expect.objectContaining({ path: "alpha.txt", status: "modified" }),
      expect.objectContaining({ path: "binary.dat", status: "added" }),
      expect.objectContaining({ path: "deleted.txt", status: "deleted" }),
    ]);
  });
});

describe("authoritative Git artifact promotion", () => {
  it("atomically promotes the exact signed candidate and adopts an identical retry", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
    const input = {
      repository: fixture.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: TARGET_REF,
      expectedBaseCommit: fixture.baseCommit,
      candidate: sealed.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: fixture.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    } as const;

    await expect(
      getArtifactPromotionStatus({
        candidate: sealed.receipt,
        signingSecrets: input.signingSecrets,
        statusStoreDirectory: fixture.store,
      }),
    ).resolves.toMatchObject({ state: "absent" });

    const [first, concurrent] = await Promise.all([
      promoteArtifactCandidate(input),
      promoteArtifactCandidate({
        ...input,
        attemptedAt: "2026-07-18T12:05:01.000Z",
      }),
    ]);
    const retry = await promoteArtifactCandidate({
      ...input,
      attemptedAt: "2026-07-18T12:06:00.000Z",
    });

    expect(first.receipt.outcome).toBe("promoted");
    expect(["cas_updated", "already_promoted"]).toContain(
      first.receipt.detailCode,
    );
    expect(first.receipt.observedRefAfter).toBe(
      sealed.receipt.metadata.git.candidateCommit,
    );
    expect(concurrent).toEqual(first);
    expect(retry).toEqual(first);
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(sealed.receipt.metadata.git.candidateCommit);
    expect(JSON.parse(await readFile(first.receiptPath, "utf8"))).toEqual(
      first.receipt,
    );
    const authorityPath = join(
      fixture.store,
      "promotions",
      `${first.receipt.promotionId.slice("artifact-promotion:sha256:".length)}.authority.json`,
    );
    expect(JSON.parse(await readFile(authorityPath, "utf8"))).toMatchObject({
      kind: "odeu.git-artifact-promotion-authority-intent",
      promotionId: first.receipt.promotionId,
      projectId: TEST_PROMOTION_AUTHORITY.projectId,
      semanticHeadRevisionId: TEST_PROMOTION_AUTHORITY.semanticHeadRevisionId,
      authorizedEventId: TEST_PROMOTION_AUTHORITY.authorizedEventId,
      ledgerVersion: TEST_PROMOTION_AUTHORITY.ledgerVersion,
      ledgerPrefixDigest: TEST_PROMOTION_AUTHORITY.ledgerPrefixDigest,
      signature: { algorithm: "hmac-sha256", keyId: SIGNING.keyId },
    });
    const conflictingAuthority = {
      ...TEST_PROMOTION_AUTHORITY,
      authorizedEventId: "event-different-promotion-authority",
      ledgerVersion: {
        ...TEST_PROMOTION_AUTHORITY.ledgerVersion,
        eventCount: TEST_PROMOTION_AUTHORITY.ledgerVersion.eventCount + 1,
      },
    };
    await expect(
      promoteArtifactCandidate({
        ...input,
        authority: conflictingAuthority,
        attemptedAt: "2026-07-18T12:07:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPromotionBoundaryError",
      code: "status_conflict",
    });
    await expect(
      getArtifactPromotionStatus({
        candidate: sealed.receipt,
        signingSecrets: input.signingSecrets,
        statusStoreDirectory: fixture.store,
        authority: conflictingAuthority,
      }),
    ).rejects.toMatchObject({ code: "status_conflict" });
    await expect(
      getArtifactPromotionStatus({
        candidate: sealed.receipt,
        signingSecrets: input.signingSecrets,
        statusStoreDirectory: fixture.store,
      }),
    ).resolves.toMatchObject({
      state: "completed",
      receipt: first.receipt,
    });
    await unlink(first.receiptPath);
    await expect(
      getArtifactPromotionStatus({
        candidate: sealed.receipt,
        signingSecrets: input.signingSecrets,
        statusStoreDirectory: fixture.store,
      }),
    ).resolves.toMatchObject({ state: "attempt_only" });
    await git(
      fixture.authoritativeRepository,
      "update-ref",
      TARGET_REF,
      fixture.baseCommit,
      sealed.receipt.metadata.git.candidateCommit,
    );
    const abaRecovery = await promoteArtifactCandidate({
      ...input,
      attemptedAt: "2026-07-18T12:08:00.000Z",
    });
    expect(abaRecovery.receipt).toMatchObject({
      outcome: "outcome_unknown",
      detailCode: "status_recovery_conflict",
      observedRefBefore: fixture.baseCommit,
      observedRefAfter: fixture.baseCommit,
    });
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(fixture.baseCommit);
    const promotionDigest = first.receipt.promotionId.slice(
      "artifact-promotion:sha256:".length,
    );
    const continuityPaths = [
      authorityPath,
      join(fixture.store, "promotions", `${promotionDigest}.attempt.json`),
      join(fixture.store, "promotions", `${promotionDigest}.status.json`),
    ];
    for (const continuityPath of continuityPaths) {
      const original = await readFile(continuityPath, "utf8");
      const changed = JSON.parse(original) as {
        signature: { keyId: string };
      };
      changed.signature.keyId = "artifact-key-alias";
      await writeFile(continuityPath, `${JSON.stringify(changed)}\n`, "utf8");
      await expect(
        getArtifactPromotionStatus({
          candidate: sealed.receipt,
          signingSecrets: {
            [SIGNING.keyId]: SIGNING_SECRET,
            "artifact-key-alias": SIGNING_SECRET,
          },
          statusStoreDirectory: fixture.store,
        }),
      ).rejects.toMatchObject({ code: "status_conflict" });
      await writeFile(continuityPath, original, "utf8");
    }
  }, 20_000);

  it("never CASes after a concurrent writer wins the attempt create-only race", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
    let injected = false;
    fsLinkTestHooks.beforeLink = async (_source, destination, install) => {
      if (!destination.endsWith(".attempt.json")) return;
      fsLinkTestHooks.beforeLink = null;
      injected = true;
      await install();
    };

    const result = await promoteArtifactCandidate({
      repository: fixture.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: TARGET_REF,
      expectedBaseCommit: fixture.baseCommit,
      candidate: sealed.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: fixture.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    });

    expect(injected).toBe(true);
    expect(result.receipt).toMatchObject({
      outcome: "outcome_unknown",
      detailCode: "status_recovery_conflict",
      observedRefBefore: fixture.baseCommit,
      observedRefAfter: fixture.baseCommit,
    });
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(fixture.baseCommit);
  });

  it("never treats an annotated-tag target as the candidate during retry recovery", async () => {
    const fixture = await createRepository();
    const targetRef = "refs/artifacts/authoritative";
    await git(
      fixture.authoritativeRepository,
      "update-ref",
      targetRef,
      fixture.baseCommit,
    );
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(
      sealInput(fixture, targetRef),
    );
    const input = {
      repository: fixture.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef,
      expectedBaseCommit: fixture.baseCommit,
      candidate: sealed.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: fixture.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    } as const;
    const promoted = await promoteArtifactCandidate(input);
    await unlink(promoted.receiptPath);
    await git(
      fixture.repository,
      "tag",
      "-a",
      "target-indirection",
      "-m",
      "target indirection",
      sealed.receipt.metadata.git.candidateCommit,
    );
    const tagObject = await git(
      fixture.repository,
      "rev-parse",
      "refs/tags/target-indirection",
    );
    await git(
      fixture.authoritativeRepository,
      "update-ref",
      "--no-deref",
      targetRef,
      tagObject,
      sealed.receipt.metadata.git.candidateCommit,
    );
    expect(
      await git(
        fixture.authoritativeRepository,
        "rev-parse",
        `${targetRef}^{commit}`,
      ),
    ).toBe(sealed.receipt.metadata.git.candidateCommit);

    await expect(
      promoteArtifactCandidate({
        ...input,
        attemptedAt: "2026-07-18T12:06:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", targetRef),
    ).toBe(tagObject);
    await expect(
      getArtifactPromotionStatus({
        candidate: sealed.receipt,
        signingSecrets: input.signingSecrets,
        statusStoreDirectory: fixture.store,
      }),
    ).resolves.toMatchObject({ state: "attempt_only" });
  }, 20_000);

  it("fails stale without rebasing when a competing target commit wins", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
    const baseTree = await git(
      fixture.repository,
      "rev-parse",
      `${fixture.baseCommit}^{tree}`,
    );
    const competing = await git(
      fixture.repository,
      "commit-tree",
      baseTree,
      "-p",
      fixture.baseCommit,
      "-m",
      "competing",
    );
    await git(
      fixture.authoritativeRepository,
      "update-ref",
      TARGET_REF,
      competing,
      fixture.baseCommit,
    );

    const result = await promoteArtifactCandidate({
      repository: fixture.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: TARGET_REF,
      expectedBaseCommit: fixture.baseCommit,
      candidate: sealed.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: fixture.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    });

    expect(result.receipt).toMatchObject({
      outcome: "stale",
      detailCode: "target_ref_mismatch",
      observedRefBefore: competing,
      observedRefAfter: competing,
    });
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(competing);
  });

  it("fails closed for a checked-out target or missing retained candidate ref", async () => {
    const checkedOut = await createRepository();
    await createReviewableChanges(checkedOut);
    const branch = await git(checkedOut.repository, "symbolic-ref", "HEAD");
    const sealedOnCheckedOut = await sealLiveWorkspaceCandidate(
      sealInput(checkedOut, branch),
    );
    const checkedOutResult = await promoteArtifactCandidate({
      repository: checkedOut.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: branch,
      expectedBaseCommit: checkedOut.baseCommit,
      candidate: sealedOnCheckedOut.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: checkedOut.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    });
    expect(checkedOutResult.receipt).toMatchObject({
      outcome: "failed",
      detailCode: "target_ref_checked_out",
    });
    expect(
      await git(checkedOut.authoritativeRepository, "rev-parse", branch),
    ).toBe(checkedOut.baseCommit);

    const missing = await createRepository();
    await createReviewableChanges(missing);
    const sealedMissing = await sealLiveWorkspaceCandidate(sealInput(missing));
    await git(
      missing.repository,
      "update-ref",
      "-d",
      sealedMissing.receipt.metadata.candidateRef,
    );
    const missingResult = await promoteArtifactCandidate({
      repository: missing.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: TARGET_REF,
      expectedBaseCommit: missing.baseCommit,
      candidate: sealedMissing.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: missing.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    });
    expect(missingResult.receipt).toMatchObject({
      outcome: "failed",
      detailCode: "candidate_verification_failed",
      detail:
        "The retained non-authoritative candidate ref no longer names the signed commit.",
    });
    expect(JSON.stringify(missingResult.receipt)).not.toContain(missing.root);
    expect(
      await git(missing.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(missing.baseCommit);
  }, 20_000);

  it("requires the exact bare repository root before creating a promotion attempt", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));

    await expect(
      promoteArtifactCandidate({
        repository: fixture.repository,
        repositoryId: "repository-home-move",
        targetRef: TARGET_REF,
        expectedBaseCommit: fixture.baseCommit,
        candidate: sealed.receipt,
        signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
        statusStoreDirectory: fixture.store,
        attemptedAt: "2026-07-18T12:05:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "ArtifactPromotionBoundaryError",
      code: "invalid_configuration",
    });
    await expect(
      getArtifactPromotionStatus({
        candidate: sealed.receipt,
        signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
        statusStoreDirectory: fixture.store,
      }),
    ).resolves.toMatchObject({ state: "absent" });
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(fixture.baseCommit);
  });

  it("fails closed on malformed or symlinked final-name journal claims", async () => {
    for (const kind of ["malformed", "symlink"] as const) {
      const fixture = await createRepository();
      await createReviewableChanges(fixture);
      const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
      fsLinkTestHooks.beforeLink = async (_source, destination) => {
        if (!destination.endsWith(".authority.json")) return;
        fsLinkTestHooks.beforeLink = null;
        if (kind === "malformed") {
          await writeFile(destination, "{\n", { mode: 0o600 });
        } else {
          await symlink("/dev/null", destination);
        }
      };

      await expect(
        promoteArtifactCandidate({
          repository: fixture.authoritativeRepository,
          repositoryId: "repository-home-move",
          targetRef: TARGET_REF,
          expectedBaseCommit: fixture.baseCommit,
          candidate: sealed.receipt,
          signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
          statusStoreDirectory: fixture.store,
          attemptedAt: "2026-07-18T12:05:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "status_conflict" });
      expect(
        await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
      ).toBe(fixture.baseCommit);
      expect(
        (await readdir(join(fixture.store, "promotions"))).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);
    }
  }, 20_000);

  it("rejects symbolic authority refs and symlinked private journal components", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
    const input = {
      repository: fixture.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: TARGET_REF,
      expectedBaseCommit: fixture.baseCommit,
      candidate: sealed.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: fixture.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    } as const;

    await git(
      fixture.authoritativeRepository,
      "symbolic-ref",
      TARGET_REF,
      "refs/heads/worker",
    );
    await expect(promoteArtifactCandidate(input)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    await git(
      fixture.authoritativeRepository,
      "symbolic-ref",
      "--delete",
      TARGET_REF,
    );
    await git(
      fixture.authoritativeRepository,
      "update-ref",
      TARGET_REF,
      fixture.baseCommit,
    );
    await git(
      fixture.authoritativeRepository,
      "symbolic-ref",
      sealed.receipt.metadata.candidateRef,
      TARGET_REF,
    );
    await expect(promoteArtifactCandidate(input)).rejects.toMatchObject({
      code: "binding_mismatch",
    });

    const journalFixture = await createRepository();
    await createReviewableChanges(journalFixture);
    const journalCandidate = await sealLiveWorkspaceCandidate(
      sealInput(journalFixture),
    );
    const redirectedJournal = join(journalFixture.root, "redirected-journal");
    await mkdir(redirectedJournal, { mode: 0o700 });
    await symlink(
      redirectedJournal,
      join(journalFixture.store, "promotions"),
      "dir",
    );
    await expect(
      promoteArtifactCandidate({
        repository: journalFixture.authoritativeRepository,
        repositoryId: "repository-home-move",
        targetRef: TARGET_REF,
        expectedBaseCommit: journalFixture.baseCommit,
        candidate: journalCandidate.receipt,
        signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
        statusStoreDirectory: journalFixture.store,
        attemptedAt: "2026-07-18T12:05:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(
      await git(
        journalFixture.authoritativeRepository,
        "rev-parse",
        TARGET_REF,
      ),
    ).toBe(journalFixture.baseCommit);
  }, 30_000);

  it("rechecks bare authority after acquiring the repository-wide promotion lock", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
    const lockPath = join(
      fixture.authoritativeRepository,
      ARTIFACT_PROMOTION_REPOSITORY_LOCK,
    );
    await mkdir(lockPath);
    let settled = false;
    const promotion = promoteArtifactCandidate({
      repository: fixture.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: TARGET_REF,
      expectedBaseCommit: fixture.baseCommit,
      candidate: sealed.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: fixture.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
    expect(settled).toBe(false);
    await git(fixture.authoritativeRepository, "config", "core.bare", "false");
    await rmdir(lockPath);

    await expect(promotion).rejects.toMatchObject({
      name: "ArtifactPromotionBoundaryError",
      code: "invalid_configuration",
    });
    expect(
      await git(fixture.authoritativeRepository, "rev-parse", TARGET_REF),
    ).toBe(fixture.baseCommit);
  });

  it("ignores replacement refs while verifying and promoting the signed commit", async () => {
    const fixture = await createRepository();
    await createReviewableChanges(fixture);
    const sealed = await sealLiveWorkspaceCandidate(sealInput(fixture));
    await git(
      fixture.repository,
      "replace",
      sealed.receipt.metadata.git.candidateCommit,
      fixture.baseCommit,
    );

    const result = await promoteArtifactCandidate({
      repository: fixture.authoritativeRepository,
      repositoryId: "repository-home-move",
      targetRef: TARGET_REF,
      expectedBaseCommit: fixture.baseCommit,
      candidate: sealed.receipt,
      signingSecrets: { [SIGNING.keyId]: SIGNING_SECRET },
      statusStoreDirectory: fixture.store,
      attemptedAt: "2026-07-18T12:05:00.000Z",
    });

    expect(result.receipt).toMatchObject({
      outcome: "promoted",
      observedRefAfter: sealed.receipt.metadata.git.candidateCommit,
    });
  });
});
