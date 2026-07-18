import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { codexFailure, runCodexAdapter } from "./index";
import {
  isolatedEnvironment,
  isolatedWorkerShellEnvironment,
  LiveCodexBlockedError,
  unsafeIgnoredWorkspaceEntries,
} from "./live";

const originalMode = process.env.ODEU_CODEX_MODE;

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

  it("does not inherit server credentials into worker commands", () => {
    const priorOpenAi = process.env.OPENAI_API_KEY;
    const priorCodex = process.env.CODEX_API_KEY;
    process.env.OPENAI_API_KEY = "server-openai-secret";
    process.env.CODEX_API_KEY = "server-codex-secret";
    try {
      const environment = isolatedEnvironment("/private/codex-home");
      const policy = isolatedWorkerShellEnvironment("/private/codex-home");

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
    } finally {
      if (priorOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorOpenAi;
      if (priorCodex === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = priorCodex;
    }
  });
});
