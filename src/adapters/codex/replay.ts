import { createHash } from "node:crypto";

import {
  HOME_MOVE_REGISTERED_SEMANTIC_BRIEF_DIGESTS,
  HOME_MOVE_REPLAY_IDENTITY,
} from "@/adapters/replay-evidence/bundle";

import { assertCodexRequestMode } from "./mode";
import type { AgentBrief, AgentRunRequest, AgentRunSuccess } from "./schema";

const REPLAY_START = "2026-07-16T09:12:00.000Z";
const REGISTERED_SEMANTIC_BRIEF_DIGESTS = new Set<string>(
  Object.values(HOME_MOVE_REGISTERED_SEMANTIC_BRIEF_DIGESTS),
);

export class CodexReplayNotApplicableError extends Error {
  constructor() {
    super(
      "The bundled Codex fixture replay applies to the registered home-move brief only; no matching replay exists for this brief.",
    );
    this.name = "CodexReplayNotApplicableError";
  }
}

function sorted<T>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}

/**
 * Fixture applicability is bound to authored meaning, not ledger-generated
 * identity. Run, brief, context, check, revision, and artifact IDs may all be
 * freshly compiled without turning an unrelated brief into fixture evidence.
 */
export function semanticReplayBriefDigest(brief: AgentBrief): string {
  const sharedMeaningById = new Map(
    brief.context.shared.map((item) => [
      item.id,
      { kind: item.kind, label: item.label, summary: item.summary },
    ]),
  );
  const semanticBrief = {
    ...(brief.delegationProfileId === null
      ? {}
      : { delegationProfileId: brief.delegationProfileId }),
    goal: brief.goal,
    doneMeans: sorted(brief.doneMeans),
    environment: brief.environment,
    agentProfile: brief.agentProfile,
    context: {
      shared: sorted([...sharedMeaningById.values()]),
      relations: sorted(
        brief.context.relations.map((relation) => ({
          kind: relation.kind,
          from: sharedMeaningById.get(relation.fromId) ?? null,
          to: sharedMeaningById.get(relation.toId) ?? null,
          label: relation.label,
        })),
      ),
      omittedCount: brief.context.omittedCount,
    },
    unknowns: sorted(brief.unknowns),
    constraints: sorted(brief.constraints),
    actions: {
      allowed: sorted(brief.actions.allowed),
      denied: sorted(brief.actions.denied),
      confirmationRequired: sorted(brief.actions.confirmationRequired),
    },
    evidenceContract: {
      requiredChecks: sorted(
        brief.evidenceContract.requiredChecks.map((check) => ({
          label: check.label,
          kind: check.kind,
          command: check.command,
          blocking: check.blocking,
        })),
      ),
      expectedArtifacts: sorted(brief.evidenceContract.expectedArtifacts),
      blockIntegration: brief.evidenceContract.blockIntegration,
    },
    escalationPath: brief.escalationPath,
  };

  return `sha256:${createHash("sha256").update(JSON.stringify(semanticBrief)).digest("hex")}`;
}

function isRegisteredHomeMoveBrief(request: AgentRunRequest): boolean {
  return REGISTERED_SEMANTIC_BRIEF_DIGESTS.has(
    semanticReplayBriefDigest(request.brief),
  );
}

export function runCodexReplay(request: AgentRunRequest): AgentRunSuccess {
  assertCodexRequestMode(request, "replay");
  if (!isRegisteredHomeMoveBrief(request)) {
    throw new CodexReplayNotApplicableError();
  }

  const { brief, runId } = request;
  const evidence = brief.evidenceContract.requiredChecks.map((requirement) => ({
    checkId: requirement.checkId,
    label: requirement.label,
    status: "passed" as const,
    detail: requirement.command
      ? `Fixture evidence records a successful run of ${requirement.command}.`
      : "Fixture evidence records a successful focused verification.",
    reference: `replay://${HOME_MOVE_REPLAY_IDENTITY}/checks/${requirement.checkId}`,
  }));

  return {
    ok: true,
    runtime: {
      requestedMode: "replay",
      effectiveMode: "replay",
      status: "replayed",
      provider: "codex",
      replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
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
      runId,
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
            reference: `replay://${HOME_MOVE_REPLAY_IDENTITY}/artifacts/moving-cost-comparison`,
          },
        ],
        claimedChecks: evidence,
        failures: [],
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
      artifactCandidate: null,
    },
  };
}
