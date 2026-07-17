import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimQueuedRunAuthorization,
  RunAuthorizationConsumedError,
  RunClaimBusyError,
  withUnclaimedRunMutation,
} from "./consumption";
import type { RunAuthorization } from "./schema";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function claimRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "odeu-codex-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

const authorization: RunAuthorization = {
  runId: "run-live-001",
  mode: "live",
  requestId: "request-live-001",
  nonce: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-16T09:00:00.000Z",
  expiresAt: "2026-07-16T09:05:00.000Z",
  briefDigest: `sha256:${"a".repeat(64)}`,
  baseRevisionId: "rev-001",
  artifactBaseRef: `git:${"b".repeat(40)}`,
  capability: "c".repeat(64),
};

describe("live run dispatch claim", () => {
  it("checks queued state and atomically refuses any second run-scoped claim", async () => {
    const directory = await claimRoot();
    const assertQueued = vi.fn(async () => undefined);

    await claimQueuedRunAuthorization(directory, authorization, assertQueued);
    await expect(
      claimQueuedRunAuthorization(directory, authorization, assertQueued),
    ).rejects.toBeInstanceOf(RunAuthorizationConsumedError);
    await expect(
      claimQueuedRunAuthorization(
        directory,
        {
          ...authorization,
          requestId: "request-live-002",
          nonce: "00000000-0000-4000-8000-000000000002",
          capability: "d".repeat(64),
        },
        assertQueued,
      ),
    ).rejects.toBeInstanceOf(RunAuthorizationConsumedError);
    expect(assertQueued).toHaveBeenCalledTimes(1);
  });

  it("makes cancellation/status mutation unavailable after dispatch linearizes", async () => {
    const directory = await claimRoot();
    const mutation = vi.fn(async () => "cancelled");

    await claimQueuedRunAuthorization(directory, authorization, async () => undefined);
    await expect(
      withUnclaimedRunMutation(directory, authorization.runId, mutation),
    ).rejects.toBeInstanceOf(RunAuthorizationConsumedError);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("fails a competing dispatch closed while a cancellation mutation owns the guard", async () => {
    const directory = await claimRoot();
    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = withUnclaimedRunMutation(
      directory,
      authorization.runId,
      async () => {
        mutationStarted();
        await release;
      },
    );
    await started;

    await expect(
      claimQueuedRunAuthorization(directory, authorization, async () => undefined),
    ).rejects.toBeInstanceOf(RunClaimBusyError);
    releaseMutation();
    await mutation;
  });

  it("fails cancellation closed while dispatch owns the guard, then reports the claim", async () => {
    const directory = await claimRoot();
    let releaseCheck!: () => void;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      checkStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    const claim = claimQueuedRunAuthorization(directory, authorization, async () => {
      checkStarted();
      await release;
    });
    await started;

    await expect(
      withUnclaimedRunMutation(directory, authorization.runId, async () => undefined),
    ).rejects.toBeInstanceOf(RunClaimBusyError);
    releaseCheck();
    await claim;
    await expect(
      withUnclaimedRunMutation(directory, authorization.runId, async () => undefined),
    ).rejects.toBeInstanceOf(RunAuthorizationConsumedError);
  });
});
