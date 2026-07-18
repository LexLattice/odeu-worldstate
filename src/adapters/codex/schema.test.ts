import { describe, expect, it } from "vitest";

import {
  AgentRunRequestSchema,
  AgentRunFailureSchema,
  AgentRunSuccessSchema,
  CodexReportedClosureSchema,
  CodexReportedResultSchema,
} from "./schema";
import { testBrief } from "./test-fixture";

const blockedReport = {
  outcome: "blocked" as const,
  claimedEffects: [],
  claimedArtifacts: [],
  claimedChecks: [],
  failures: [],
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

  it("retains explicit failure detail on terminal worker reports", () => {
    const report = CodexReportedClosureSchema.parse({
      ...blockedReport,
      outcome: "failed",
      failures: ["The focused calculation test exited with code 1."],
    });

    expect(report.failures).toEqual([
      "The focused calculation test exited with code 1.",
    ]);
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

  it("never permits a blocked run to carry a staged artifact candidate", () => {
    expect(
      AgentRunFailureSchema.safeParse({
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
        blockedRun: { ...blockedRun, artifactCandidate: { forged: true } },
      }).success,
    ).toBe(false);
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

describe("Codex run identity and mode boundary", () => {
  const authorization = {
    runId: "run-live-1",
    mode: "live" as const,
    requestId: "request-live-1",
    nonce: "00000000-0000-4000-8000-000000000001",
    issuedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-17T00:05:00.000Z",
    briefDigest: `sha256:${"a".repeat(64)}`,
    baseRevisionId: testBrief.sourceRevisionId,
    artifactBaseRef: testBrief.artifactBaseRef,
    capability: "b".repeat(64),
  };

  it("requires explicit run identity and mode", () => {
    expect(
      AgentRunRequestSchema.parse({
        runId: "run-replay-1",
        mode: "replay",
        requestId: "request-replay-1",
        brief: testBrief,
        authorization: null,
      }),
    ).toMatchObject({ runId: "run-replay-1", mode: "replay" });

    expect(
      AgentRunRequestSchema.safeParse({
        requestId: "request-replay-1",
        brief: testBrief,
        authorization: null,
      }).success,
    ).toBe(false);
  });

  it("rejects authorization bound to another run or replay mode", () => {
    expect(
      AgentRunRequestSchema.safeParse({
        runId: "run-other",
        mode: "live",
        requestId: authorization.requestId,
        brief: testBrief,
        authorization,
      }).success,
    ).toBe(false);
    expect(
      AgentRunRequestSchema.safeParse({
        runId: authorization.runId,
        mode: "replay",
        requestId: authorization.requestId,
        brief: testBrief,
        authorization,
      }).success,
    ).toBe(false);
  });

  it("rejects live authority bound to another request, revision, or artifact base", () => {
    for (const mismatchedAuthorization of [
      { ...authorization, requestId: "request-other" },
      { ...authorization, baseRevisionId: "revision-other" },
      { ...authorization, artifactBaseRef: "git:other-base" },
    ]) {
      expect(
        AgentRunRequestSchema.safeParse({
          runId: authorization.runId,
          mode: "live",
          requestId: authorization.requestId,
          brief: testBrief,
          authorization: mismatchedAuthorization,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects success artifacts whose effective mode differs from requested mode", () => {
    const validReplay = {
      ok: true as const,
      runtime: {
        requestedMode: "replay" as const,
        effectiveMode: "replay" as const,
        status: "replayed" as const,
        provider: "codex" as const,
        replayIdentity: "fixture-1",
        replayKind: "fixture" as const,
      },
      events: [
        {
          sequence: 0,
          status: "returned" as const,
          at: "2026-07-17T00:00:00.000Z",
          label: "Returned",
          detail: "The fixture returned a witness.",
        },
      ],
      closure: {
        runId: "run-replay-1",
        briefId: testBrief.briefId,
        sourceRevisionIdUsed: testBrief.sourceRevisionId,
        artifactBaseRefUsed: testBrief.artifactBaseRef,
        workerThreadId: null,
        workerItemIds: [],
        report: {
          outcome: "returned" as const,
          claimedEffects: [],
          claimedArtifacts: [],
          claimedChecks: [],
          failures: [],
          unresolved: [],
          completionClaim: {
            claimedDone: true,
            criteriaClaimedSatisfied: testBrief.doneMeans.map(() => true),
          },
          candidateReconciliationSummary: "Stage the fixture witness.",
        },
        sdkObservations: { fileChanges: [], commands: [] },
      },
    };

    expect(AgentRunSuccessSchema.safeParse(validReplay).success).toBe(true);
    expect(
      AgentRunSuccessSchema.safeParse({
        ...validReplay,
        runtime: { ...validReplay.runtime, effectiveMode: "live" },
      }).success,
    ).toBe(false);
  });
});
