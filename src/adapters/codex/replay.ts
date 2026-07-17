import type { AgentRunRequest, AgentRunSuccess } from "./schema";
import { executionBriefDigest } from "./integrity";

const REPLAY_IDENTITY = "home-move-fixture-replay-v0";
const REPLAY_START = "2026-07-16T09:12:00.000Z";
const REPLAY_RUN_ID = "fixture-run-home-move-v0";
const REGISTERED_BRIEF_DIGEST =
  "sha256:d76166af0d9a93f9a4b8673583b7e168540f464af72ed1e6d1f6ad421d245e5e";

export class CodexReplayNotApplicableError extends Error {
  constructor() {
    super(
      "The bundled Codex fixture replay applies to the registered home-move brief only; no matching replay exists for this brief.",
    );
    this.name = "CodexReplayNotApplicableError";
  }
}

function isRegisteredHomeMoveBrief(request: AgentRunRequest): boolean {
  return executionBriefDigest(request.brief) === REGISTERED_BRIEF_DIGEST;
}

export function runCodexReplay(request: AgentRunRequest): AgentRunSuccess {
  if (!isRegisteredHomeMoveBrief(request)) {
    throw new CodexReplayNotApplicableError();
  }

  const { brief } = request;
  const evidence = brief.evidenceContract.requiredChecks.map((requirement) => ({
    checkId: requirement.checkId,
    label: requirement.label,
    status: "passed" as const,
    detail: requirement.command
      ? `Fixture evidence records a successful run of ${requirement.command}.`
      : "Fixture evidence records a successful focused verification.",
    reference: `replay://${REPLAY_IDENTITY}/checks/${requirement.checkId}`,
  }));

  return {
    ok: true,
    runtime: {
      requestedMode: "replay",
      effectiveMode: "replay",
      status: "replayed",
      provider: "codex",
      replayIdentity: REPLAY_IDENTITY,
      replayKind: "fixture",
    },
    events: [
      {
        sequence: 0,
        status: "queued",
        at: REPLAY_START,
        label: "Brief queued",
        detail: "The bundled demo fixture entered the bounded Codex replay adapter.",
      },
      {
        sequence: 1,
        status: "received",
        at: "2026-07-16T09:12:01.000Z",
        label: "Brief received",
        detail: "The fixture represents receipt of the immutable projection and repo boundary.",
      },
      {
        sequence: 2,
        status: "working",
        at: "2026-07-16T09:12:04.000Z",
        label: "Working",
        detail: "The fixture presents the bounded artifact change and its focused checks.",
      },
      {
        sequence: 3,
        status: "returned",
        at: "2026-07-16T09:12:18.000Z",
        label: "Result returned",
        detail: "A closure witness was staged for human reconciliation; it has not changed canonical worldstate.",
      },
    ],
    closure: {
      runId: REPLAY_RUN_ID,
      briefId: brief.briefId,
      sourceRevisionIdUsed: brief.sourceRevisionId,
      artifactBaseRefUsed: brief.artifactBaseRef,
      workerThreadId: null,
      workerItemIds: [],
      report: {
        outcome: "returned",
        claimedEffects: [
          "The fixture stages a moving-cost comparison surface inside the scoped demo artifact.",
          "The fixture contains no publishing or external side effect.",
        ],
        claimedArtifacts: [
          {
            path: "demo/moving-costs.html",
            kind: "updated",
            summary: "A quote comparison form with editable provider totals.",
            reference: `replay://${REPLAY_IDENTITY}/artifacts/moving-cost-comparison`,
          },
        ],
        claimedChecks: evidence,
        unresolved: [
          "Confirm whether deposits should be counted as costs or recoverable cash requirements.",
        ],
        completionClaim: {
          claimedDone: true,
          criteriaClaimedSatisfied: brief.doneMeans.map(() => true),
        },
        candidateReconciliationSummary:
          "Record the comparison artifact and focused checks as a staged implementation result; preserve the deposit question as open.",
      },
      sdkObservations: { fileChanges: [], commands: [] },
    },
  };
}
