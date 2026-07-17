import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  acquireWorkspaceLease,
  WorkspaceLeaseUnavailableError,
} from "./workspace-lease";

describe("live Codex workspace lease", () => {
  it("allows only one workspace-write worker until the lease is released", async () => {
    const workspace = `/tmp/odeu-workspace-${randomUUID()}`;
    const leaseRoot = await mkdtemp(join(tmpdir(), "odeu-lease-root-"));
    const first = await acquireWorkspaceLease(workspace, leaseRoot);

    await expect(acquireWorkspaceLease(workspace, leaseRoot)).rejects.toBeInstanceOf(
      WorkspaceLeaseUnavailableError,
    );
    await first.release();

    const next = await acquireWorkspaceLease(workspace, leaseRoot);
    await next.release();
    await rm(leaseRoot, { recursive: true, force: true });
  });
});
