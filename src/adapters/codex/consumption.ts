import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import type { RunAuthorization } from "./schema";

export class RunAuthorizationConsumedError extends Error {
  constructor(readonly runId: string) {
    super(`Live run authorization ${runId} has already been consumed.`);
    this.name = "RunAuthorizationConsumedError";
  }
}

export class RunClaimBusyError extends Error {
  constructor(readonly runId: string) {
    super(
      `Live run ${runId} already has an in-progress dispatch or status mutation.`,
    );
    this.name = "RunClaimBusyError";
  }
}

type RunClaimPaths = {
  readonly directory: string;
  readonly claimPath: string;
  readonly guardPath: string;
};

function runClaimPaths(claimRoot: string, runId: string): RunClaimPaths {
  const identity = createHash("sha256").update(runId).digest("hex");
  const directory = resolve(
    /* turbopackIgnore: true */ claimRoot,
    "odeu-run-claims",
  );
  return {
    directory,
    claimPath: resolve(
      /* turbopackIgnore: true */ directory,
      `${identity}.claimed.json`,
    ),
    guardPath: resolve(
      /* turbopackIgnore: true */ directory,
      `${identity}.guard`,
    ),
  };
}

async function withRunGuard<T>(
  claimRoot: string,
  runId: string,
  operation: (claimPath: string) => Promise<T>,
): Promise<T> {
  const paths = runClaimPaths(claimRoot, runId);
  await mkdir(/* turbopackIgnore: true */ paths.directory, {
    recursive: true,
    mode: 0o700,
  });

  let guard;
  try {
    guard = await open(
      /* turbopackIgnore: true */ paths.guardPath,
      "wx",
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RunClaimBusyError(runId);
    }
    throw error;
  }

  try {
    await guard.writeFile(
      `${JSON.stringify({ runId, acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await guard.sync();
    return await operation(paths.claimPath);
  } finally {
    await guard.close();
    // A process crash intentionally leaves the guard behind and fails closed;
    // operators must investigate the unknown outcome before clearing it.
    await unlink(/* turbopackIgnore: true */ paths.guardPath);
  }
}

async function assertRunUnclaimed(claimPath: string, runId: string): Promise<void> {
  let handle;
  try {
    handle = await open(/* turbopackIgnore: true */ claimPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await handle.close();
  throw new RunAuthorizationConsumedError(runId);
}

/**
 * Re-reduces the authoritative ledger and claims the queued run while holding
 * the same per-run guard used by pre-dispatch cancellation/status writers. The
 * claim file is the dispatch linearization point: after it is created, a lawful
 * pre-dispatch cancellation or competing dispatch cannot proceed.
 */
export async function claimQueuedRunAuthorization(
  claimRoot: string,
  authorization: RunAuthorization,
  assertQueued: () => Promise<void>,
  claimedAt = new Date(),
): Promise<void> {
  await withRunGuard(claimRoot, authorization.runId, async (claimPath) => {
    await assertRunUnclaimed(claimPath, authorization.runId);
    await assertQueued();

    let claim;
    try {
      claim = await open(/* turbopackIgnore: true */ claimPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RunAuthorizationConsumedError(authorization.runId);
      }
      throw error;
    }

    try {
      await claim.writeFile(
        `${JSON.stringify({
          runId: authorization.runId,
          requestId: authorization.requestId,
          nonce: authorization.nonce,
          capabilityDigest: createHash("sha256")
            .update(authorization.capability)
            .digest("hex"),
          claimedAt: claimedAt.toISOString(),
        })}\n`,
        "utf8",
      );
      await claim.sync();
    } finally {
      await claim.close();
    }
  });
}

/**
 * Mandatory boundary for any authoritative pre-dispatch cancellation or
 * lifecycle mutation of a live run. The supplied mutation must commit its ledger
 * change before it returns. A successful dispatch claim makes the mutation
 * unavailable.
 */
export async function withUnclaimedRunMutation<T>(
  claimRoot: string,
  runId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  return withRunGuard(claimRoot, runId, async (claimPath) => {
    await assertRunUnclaimed(claimPath, runId);
    return mutation();
  });
}
