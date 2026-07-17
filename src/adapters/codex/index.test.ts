import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { codexFailure } from "./index";
import {
  LiveCodexBlockedError,
  unsafeIgnoredWorkspaceEntries,
} from "./live";

const originalMode = process.env.ODEU_CODEX_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.ODEU_CODEX_MODE;
  else process.env.ODEU_CODEX_MODE = originalMode;
});

describe("codexFailure", () => {
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
          unresolved: ["Choose whether deposits count as costs."],
          completionClaim: {
            claimedDone: false,
            criteriaClaimedSatisfied: [false],
          },
          candidateReconciliationSummary: "Keep the run blocked.",
        },
        sdkObservations: { fileChanges: [], commands: [] },
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
});
