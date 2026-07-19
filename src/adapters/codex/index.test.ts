import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { codexFailure, runCodexAdapter } from "./index";
import {
  finalizeLiveCodexWorkspaceLease,
  isolatedEnvironment,
  isolatedPreflightGitEnvironment,
  isolatedWorkerShellEnvironment,
  LiveCodexBlockedError,
  LiveCodexDeadlineExceededError,
  observeExactDirectTargetCommit,
  runPreflightGit,
  unsafeIgnoredWorkspaceEntries,
  withLiveCodexDeadline,
} from "./live";

const execFile = promisify(execFileCallback);
const originalMode = process.env.ODEU_CODEX_MODE;

async function createCommittedGitWorkspace(prefix: string) {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  await execFile("git", ["-C", workspace, "init", "--quiet"]);
  await writeFile(join(workspace, "tracked.txt"), "seed\n");
  await execFile("git", ["-C", workspace, "add", "tracked.txt"]);
  await execFile("git", [
    "-C",
    workspace,
    "-c",
    "user.name=ODEU Test",
    "-c",
    "user.email=odeu@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "seed",
  ]);
  const head = (
    await execFile("git", ["-C", workspace, "rev-parse", "HEAD"])
  ).stdout.trim();
  return { workspace, head };
}

afterEach(() => {
  if (originalMode === undefined) delete process.env.ODEU_CODEX_MODE;
  else process.env.ODEU_CODEX_MODE = originalMode;
});

describe("codexFailure", () => {
  it("refuses to select an adapter whose mode differs from the immutable request", async () => {
    process.env.ODEU_CODEX_MODE = "replay";
    const fixture = createPrivateProjectionFixture({
      executionMode: "live",
      artifactBaseRef: `git:${"a".repeat(40)}`,
    });
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      fixture.ids.run,
      "live",
      "request-live-against-replay",
    );

    await expect(runCodexAdapter(request)).rejects.toThrow(
      "replay Codex adapter cannot execute a live run request",
    );
    expect(codexFailure(await runCodexAdapter(request).catch((error) => error))).toMatchObject({
      runtime: { requestedMode: "replay", effectiveMode: null },
      error: { code: "mode_mismatch" },
    });
  });

  it("maps a worker block to a resumable non-closure response", () => {
    process.env.ODEU_CODEX_MODE = "live";

    const failure = codexFailure(
      new LiveCodexBlockedError({
        runId: "run-live-1",
        briefId: "brief-live-1",
        sourceRevisionIdUsed: "rev-1",
        artifactBaseRefUsed: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workerThreadId: "thread-live-1",
        workerItemIds: [],
        events: [
          {
            sequence: 0,
            status: "blocked",
            at: "2026-07-17T00:00:00.000Z",
            label: "Worker blocked",
            detail: "A decision is required.",
          },
        ],
        report: {
          outcome: "blocked",
          claimedEffects: [],
          claimedArtifacts: [],
          claimedChecks: [],
          failures: [],
          unresolved: ["Choose whether deposits count as costs."],
          completionClaim: {
            claimedDone: false,
            criteriaClaimedSatisfied: [false],
          },
          candidateReconciliationSummary: "Keep the run blocked.",
        },
        sdkObservations: { fileChanges: [], commands: [] },
        artifactCandidate: null,
      }),
    );

    expect(failure).toMatchObject({
      ok: false,
      runtime: { effectiveMode: "live", status: "blocked" },
      error: { code: "worker_blocked" },
      briefPreserved: true,
      resumable: true,
      resumeSupported: false,
      blockedRun: { workerThreadId: "thread-live-1" },
    });
    expect(failure).not.toHaveProperty("closure");
  });

  it("aborts an over-deadline live turn and exposes a typed terminal failure", async () => {
    let observedSignal: AbortSignal | undefined;
    const operation = withLiveCodexDeadline(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      5,
    );

    await expect(operation).rejects.toMatchObject({
      name: "LiveCodexDeadlineExceededError",
      timeoutMs: 5,
    });
    expect(observedSignal?.aborted).toBe(true);

    await expect(
      withLiveCodexDeadline(async () => undefined, 2_147_483_648),
    ).rejects.toMatchObject({
      name: "LiveCodexConfigurationError",
    });

    const lease = {
      release: vi.fn(async () => undefined),
      retain: vi.fn(async () => undefined),
    };
    await finalizeLiveCodexWorkspaceLease(
      lease,
      new LiveCodexDeadlineExceededError(5),
    );
    expect(lease.retain).toHaveBeenCalledOnce();
    expect(lease.release).not.toHaveBeenCalled();

    const ordinaryLease = {
      release: vi.fn(async () => undefined),
      retain: vi.fn(async () => undefined),
    };
    await finalizeLiveCodexWorkspaceLease(ordinaryLease, new Error("failed"));
    expect(ordinaryLease.release).toHaveBeenCalledOnce();
    expect(ordinaryLease.retain).not.toHaveBeenCalled();

    process.env.ODEU_CODEX_MODE = "live";
    expect(codexFailure(new LiveCodexDeadlineExceededError(5))).toMatchObject({
      ok: false,
      runtime: { effectiveMode: "live", status: "failed" },
      error: { code: "worker_timed_out" },
      briefPreserved: true,
      resumable: false,
      blockedRun: null,
    });
  });

  it("rejects every ignored workspace root, including local dependency trees", () => {
    expect(
      unsafeIgnoredWorkspaceEntries(
        [
          "!! node_modules/",
          "!! .working/",
          "!! worldstate.db",
          "!! debug.log",
          "!! .next/",
        ].join("\n"),
      ),
    ).toEqual([
      "node_modules/",
      ".working/",
      "worldstate.db",
      "debug.log",
      ".next/",
    ]);
  });

  it("does not inherit server credentials into worker or preflight Git commands", () => {
    const priorEnvironment = Object.fromEntries(
      [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ODEU_CODEX_AUTH_SECRET",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
      ].map((name) => [name, process.env[name]]),
    );
    process.env.OPENAI_API_KEY = "server-openai-secret";
    process.env.CODEX_API_KEY = "server-codex-secret";
    process.env.ODEU_CODEX_AUTH_SECRET = "server-run-authority-secret";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
    process.env.GIT_CONFIG_VALUE_0 = "/tmp/untrusted-fsmonitor";
    process.env.GIT_CONFIG_GLOBAL = "/tmp/untrusted-global-config";
    process.env.GIT_CONFIG_SYSTEM = "/tmp/untrusted-system-config";
    try {
      const environment = isolatedEnvironment("/private/codex-home");
      const policy = isolatedWorkerShellEnvironment("/private/codex-home");
      const gitEnvironment = isolatedPreflightGitEnvironment();

      expect(environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(environment).not.toHaveProperty("CODEX_API_KEY");
      expect(policy).toMatchObject({
        inherit: "none",
        set: {
          HOME: "/private/codex-home",
          CODEX_HOME: "/private/codex-home",
        },
      });
      expect(policy.set).not.toHaveProperty("OPENAI_API_KEY");
      expect(policy.set).not.toHaveProperty("CODEX_API_KEY");
      expect(gitEnvironment).toMatchObject({
        NODE_ENV: process.env.NODE_ENV ?? "production",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL:
          process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_ALLOW_PROTOCOL: "",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(Object.keys(gitEnvironment).sort()).toEqual(
        [
          "NODE_ENV",
          "PATH",
          "LANG",
          "LC_ALL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_CONFIG_GLOBAL",
          "GIT_ALLOW_PROTOCOL",
          "GIT_NO_LAZY_FETCH",
          "GIT_NO_REPLACE_OBJECTS",
          "GIT_OPTIONAL_LOCKS",
          "GIT_TERMINAL_PROMPT",
          ...["TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].filter(
            (name) => Boolean(process.env[name]),
          ),
        ].sort(),
      );
      expect(gitEnvironment).not.toHaveProperty("OPENAI_API_KEY");
      expect(gitEnvironment).not.toHaveProperty("CODEX_API_KEY");
      expect(gitEnvironment).not.toHaveProperty("ODEU_CODEX_AUTH_SECRET");
      expect(gitEnvironment).not.toHaveProperty("GIT_CONFIG_COUNT");
      expect(gitEnvironment).not.toHaveProperty("GIT_CONFIG_KEY_0");
      expect(gitEnvironment).not.toHaveProperty("GIT_CONFIG_VALUE_0");
      expect(gitEnvironment).not.toHaveProperty("GIT_CONFIG_SYSTEM");
    } finally {
      for (const [name, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("does not execute a repository-configured fsmonitor during Git preflight", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "odeu-live-git-"));
    const marker = join(workspace, "fsmonitor-invoked");
    const hook = join(workspace, "fsmonitor-probe.sh");
    try {
      await execFile("git", ["-C", workspace, "init", "--quiet"]);
      await writeFile(join(workspace, "tracked.txt"), "seed\n");
      await execFile("git", ["-C", workspace, "add", "tracked.txt"]);
      await writeFile(
        hook,
        [
          "#!/bin/sh",
          `printf 'invoked\\n' > ${JSON.stringify(marker)}`,
          "printf 'token\\0/\\0'",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "core.fsmonitorHookVersion",
        "2",
      ]);
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "core.fsmonitor",
        hook,
      ]);

      await expect(
        runPreflightGit(workspace, ["config", "--get", "core.fsmonitor"]),
      ).resolves.toBe("false");
      await expect(
        runPreflightGit(workspace, ["config", "--get", "core.hooksPath"]),
      ).resolves.toBe(process.platform === "win32" ? "NUL" : "/dev/null");
      await expect(
        runPreflightGit(workspace, [
          "config",
          "--get-all",
          "credential.helper",
        ]),
      ).resolves.toBe("");

      await execFile("git", ["-C", workspace, "status", "--porcelain=v1"]);
      await expect(readFile(marker, "utf8")).resolves.toBe("invoked\n");
      await rm(marker);

      await runPreflightGit(workspace, ["status", "--porcelain=v1"]);

      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed before a repository-configured clean filter can execute", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "odeu-live-filter-"));
    const marker = join(workspace, "filter-invoked");
    const filter = join(workspace, "filter-probe.sh");
    try {
      await execFile("git", ["-C", workspace, "init", "--quiet"]);
      await writeFile(join(workspace, "tracked.txt"), "seed\n");
      await writeFile(
        join(workspace, ".gitattributes"),
        "tracked.txt filter=odeu-probe\n",
      );
      await execFile("git", [
        "-C",
        workspace,
        "add",
        ".gitattributes",
        "tracked.txt",
      ]);
      await execFile("git", [
        "-C",
        workspace,
        "-c",
        "user.name=ODEU Test",
        "-c",
        "user.email=odeu@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "seed",
      ]);
      await writeFile(
        filter,
        [
          "#!/bin/sh",
          `printf 'invoked\\n' > ${JSON.stringify(marker)}`,
          "cat",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "filter.odeu-probe.clean",
        `sh ${JSON.stringify(filter)}`,
      ]);
      await writeFile(join(workspace, "tracked.txt"), "changed\n");

      await execFile("git", ["-C", workspace, "diff", "--", "tracked.txt"]);
      await expect(readFile(marker, "utf8")).resolves.toBe("invoked\n");
      await rm(marker);

      await expect(
        runPreflightGit(workspace, ["status", "--porcelain=v1"]),
      ).rejects.toMatchObject({
        name: "LiveCodexConfigurationError",
        message:
          "Live Codex Git preflight refuses repository/worktree configuration that can include external files, execute filters, or enable repository-controlled object fetching.",
      });
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed on repository-configured partial-clone fetching", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "odeu-live-promisor-"));
    try {
      await execFile("git", ["-C", workspace, "init", "--quiet"]);
      await writeFile(join(workspace, "tracked.txt"), "seed\n");
      await execFile("git", ["-C", workspace, "add", "tracked.txt"]);
      await execFile("git", [
        "-C",
        workspace,
        "-c",
        "user.name=ODEU Test",
        "-c",
        "user.email=odeu@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "seed",
      ]);
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "remote.origin.promisor",
        "true",
      ]);
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "remote.origin.partialCloneFilter",
        "blob:none",
      ]);

      await expect(
        runPreflightGit(workspace, ["rev-parse", "HEAD"]),
      ).rejects.toMatchObject({
        name: "LiveCodexConfigurationError",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed on a repository-configured uploadPack command", async () => {
    const { workspace } =
      await createCommittedGitWorkspace("odeu-live-upload-pack-");
    try {
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "remote.origin.uploadPack",
        "untrusted-upload-pack",
      ]);

      await expect(
        runPreflightGit(workspace, ["rev-parse", "HEAD"]),
      ).rejects.toMatchObject({
        name: "LiveCodexConfigurationError",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not reject a non-executable filter.required setting", async () => {
    const { workspace, head } =
      await createCommittedGitWorkspace("odeu-live-filter-required-");
    try {
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "filter.odeu-probe.required",
        "true",
      ]);

      await expect(
        runPreflightGit(workspace, ["rev-parse", "HEAD"]),
      ).resolves.toBe(head);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a local include.path without opening the included config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "odeu-live-include-"));
    const includedConfig = join(workspace, "malformed-included-config");
    try {
      await execFile("git", ["-C", workspace, "init", "--quiet"]);
      await writeFile(includedConfig, "[malformed\n");
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "--local",
        "include.path",
        includedConfig,
      ]);

      await expect(
        runPreflightGit(workspace, ["rev-parse", "--git-dir"]),
      ).rejects.toMatchObject({
        name: "LiveCodexConfigurationError",
        message:
          "Live Codex Git preflight refuses repository/worktree configuration that can include external files, execute filters, or enable repository-controlled object fetching.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an includeIf path from worktree configuration", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "odeu-live-worktree-include-"),
    );
    const includedConfig = join(workspace, "malformed-included-config");
    try {
      await execFile("git", ["-C", workspace, "init", "--quiet"]);
      await writeFile(includedConfig, "[malformed\n");
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "extensions.worktreeConfig",
        "true",
      ]);
      await execFile("git", [
        "-C",
        workspace,
        "config",
        "--worktree",
        `includeIf.gitdir:${join(workspace, ".git")}.path`,
        includedConfig,
      ]);

      await expect(
        runPreflightGit(workspace, ["rev-parse", "--git-dir"]),
      ).rejects.toMatchObject({
        name: "LiveCodexConfigurationError",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an index gitlink before invoking status", async () => {
    const { workspace, head } =
      await createCommittedGitWorkspace("odeu-live-gitlink-");
    try {
      await execFile("git", [
        "-C",
        workspace,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},nested-repository`,
      ]);

      await expect(
        runPreflightGit(workspace, ["status", "--porcelain=v1"]),
      ).rejects.toMatchObject({
        name: "LiveCodexConfigurationError",
        message: "Live Codex Git preflight refuses index gitlinks and submodules.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts only a raw direct target ref equal to HEAD", async () => {
    const { workspace, head } =
      await createCommittedGitWorkspace("odeu-live-direct-target-");
    const targetRef = "refs/heads/promotion-target";
    try {
      await execFile("git", [
        "-C",
        workspace,
        "update-ref",
        targetRef,
        head,
      ]);

      await expect(
        observeExactDirectTargetCommit(workspace, targetRef),
      ).resolves.toBe(head);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects symbolic and annotated promotion targets without peeling", async () => {
    const { workspace, head } =
      await createCommittedGitWorkspace("odeu-live-indirect-target-");
    const currentRef = (
      await execFile("git", ["-C", workspace, "symbolic-ref", "HEAD"])
    ).stdout.trim();
    try {
      const symbolicTarget = "refs/heads/symbolic-target";
      await execFile("git", [
        "-C",
        workspace,
        "symbolic-ref",
        symbolicTarget,
        currentRef,
      ]);
      await expect(
        observeExactDirectTargetCommit(workspace, symbolicTarget),
      ).rejects.toMatchObject({
        name: "LiveCodexPreflightError",
        code: "artifact_base_mismatch",
      });

      await execFile("git", [
        "-C",
        workspace,
        "-c",
        "user.name=ODEU Test",
        "-c",
        "user.email=odeu@example.invalid",
        "tag",
        "--annotate",
        "annotated-target",
        "--message",
        "promotion target",
        head,
      ]);
      await expect(
        observeExactDirectTargetCommit(
          workspace,
          "refs/tags/annotated-target",
        ),
      ).rejects.toMatchObject({
        name: "LiveCodexPreflightError",
        code: "artifact_base_mismatch",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects target-ref drift when the sealing invariant is re-observed", async () => {
    const { workspace, head } =
      await createCommittedGitWorkspace("odeu-live-target-race-");
    const targetRef = "refs/heads/promotion-target";
    try {
      await execFile("git", [
        "-C",
        workspace,
        "update-ref",
        targetRef,
        head,
      ]);
      await expect(
        observeExactDirectTargetCommit(workspace, targetRef),
      ).resolves.toBe(head);

      const tree = (
        await execFile("git", ["-C", workspace, "rev-parse", "HEAD^{tree}"])
      ).stdout.trim();
      const driftedCommit = (
        await execFile("git", [
          "-C",
          workspace,
          "-c",
          "user.name=ODEU Test",
          "-c",
          "user.email=odeu@example.invalid",
          "commit-tree",
          tree,
          "-p",
          head,
          "-m",
          "drifted target",
        ])
      ).stdout.trim();
      await execFile("git", [
        "-C",
        workspace,
        "update-ref",
        targetRef,
        driftedCommit,
        head,
      ]);

      await expect(
        observeExactDirectTargetCommit(workspace, targetRef, head),
      ).rejects.toMatchObject({
        name: "LiveCodexPreflightError",
        code: "artifact_base_mismatch",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
