import { worldstateStateFromLedgerDocument } from "@/adapters/storage";

import { executionBriefDigest } from "./integrity";
import type { AgentRunRequest } from "./schema";

export class LiveRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveRunStateError";
  }
}

/** Re-reduces the execution host's current ledger inside the run-claim guard. */
export function assertCurrentRunIsQueued(
  ledgerDocument: unknown,
  request: AgentRunRequest,
): void {
  const authorization = request.authorization;
  if (!authorization) {
    throw new LiveRunStateError("The live request has no run authorization.");
  }

  const state = worldstateStateFromLedgerDocument(ledgerDocument);
  const runProjection = state.operational.runs[authorization.runId];
  if (!runProjection) {
    throw new LiveRunStateError(
      `Run ${authorization.runId} is absent from the current execution ledger.`,
    );
  }
  const run = runProjection.run;
  const brief = state.operational.briefs[run.briefId];
  if (
    runProjection.status !== "queued" ||
    run.mode !== "live" ||
    !brief ||
    run.briefId !== request.brief.briefId ||
    run.baseRevisionId !== request.brief.sourceRevisionId ||
    run.artifactBaseRef !== request.brief.artifactBaseRef ||
    state.canonical.head.id !== request.brief.sourceRevisionId ||
    authorization.briefDigest !== executionBriefDigest(request.brief)
  ) {
    throw new LiveRunStateError(
      `Run ${authorization.runId} is no longer a queued live run with the authorized revision, brief, and artifact base.`,
    );
  }
}
