import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export class WorkspaceLeaseUnavailableError extends Error {
  constructor(readonly workspace: string) {
    super(
      `The live Codex workspace ${workspace} already has an active or unreleased execution lease.`,
    );
    this.name = "WorkspaceLeaseUnavailableError";
  }
}

export interface WorkspaceLease {
  release(): Promise<void>;
}

/**
 * Serializes workspace-write workers across the host. A crash intentionally
 * leaves the marker behind so a human must inspect the worktree before reuse.
 */
export async function acquireWorkspaceLease(
  workspace: string,
  leaseRoot: string,
  acquiredAt = new Date(),
): Promise<WorkspaceLease> {
  const directory = resolve(leaseRoot, "odeu-execution-leases");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = createHash("sha256").update(workspace).digest("hex");
  const path = resolve(directory, `${identity}.lock`);

  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ workspace, pid: process.pid, acquiredAt: acquiredAt.toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    if (handle) await handle.close();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceLeaseUnavailableError(workspace);
    }
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(path);
    },
  };
}
