import { describe, expect, it } from "vitest";

import {
  AgentRunFailureSchema,
  AgentRunSuccessSchema,
  CodexReportedClosureSchema,
  CodexReportedResultSchema,
} from "./schema";

const blockedReport = {
  outcome: "blocked" as const,
  claimedEffects: [],
  claimedArtifacts: [],
  claimedChecks: [],
  unresolved: ["A user decision is required before changing the artifact."],
  completionClaim: {
    claimedDone: false,
    criteriaClaimedSatisfied: [false],
  },
  candidateReconciliationSummary: "Keep the run blocked until the decision arrives.",
};

const blockedRun = {
  runId: "run-1",
  briefId: "brief-1",
  sourceRevisionIdUsed: "rev-1",
  artifactBaseRefUsed: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  workerThreadId: "thread-1",
  workerItemIds: [],
  events: [
    {
      sequence: 0,
      status: "blocked" as const,
      at: "2026-07-17T00:00:00.000Z",
      label: "Worker blocked",
      detail: "A decision is required.",
    },
  ],
  report: blockedReport,
  sdkObservations: { fileChanges: [], commands: [] },
};

describe("Codex blocked result boundary", () => {
  it("accepts blocked as a worker result but never as a closure report", () => {
    expect(CodexReportedResultSchema.parse(blockedReport)).toEqual(blockedReport);
    expect(CodexReportedClosureSchema.safeParse(blockedReport).success).toBe(false);
  });

  it("represents a blocked run as a resumable non-closure failure", () => {
    const response = AgentRunFailureSchema.parse({
      ok: false,
      runtime: {
        requestedMode: "live",
        effectiveMode: "live",
        status: "blocked",
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
      },
      error: {
        code: "worker_blocked",
        message: "The worker needs a user decision.",
        issues: [],
      },
      briefPreserved: true,
      resumable: true,
      resumeSupported: false,
      blockedRun,
    });

    expect(response.runtime.status).toBe("blocked");
    expect(response.resumable).toBe(true);
    expect(response.resumeSupported).toBe(false);
    expect(response.blockedRun?.report.outcome).toBe("blocked");
    expect(response).not.toHaveProperty("closure");
  });

  it("rejects any successful response that pairs blocked with a closure", () => {
    const invalid = {
      ok: true,
      runtime: {
        requestedMode: "live",
        effectiveMode: "live",
        status: "blocked",
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
      },
      events: [
        {
          sequence: 0,
          status: "blocked",
          at: "2026-07-17T00:00:00.000Z",
          label: "Worker blocked",
          detail: "A decision is required.",
        },
      ],
      closure: {
        runId: "run-1",
        briefId: "brief-1",
        sourceRevisionIdUsed: "rev-1",
        artifactBaseRefUsed: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workerThreadId: "thread-1",
        workerItemIds: [],
        report: blockedReport,
        sdkObservations: { fileChanges: [], commands: [] },
      },
    };

    expect(AgentRunSuccessSchema.safeParse(invalid).success).toBe(false);
  });
});
