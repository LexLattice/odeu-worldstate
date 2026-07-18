import { randomUUID } from "node:crypto";

import {
  authorizationMatches,
  executionBriefDigest,
  signRunAuthorization,
} from "@/adapters/codex/integrity";
import {
  AgentRunRequestSchema,
  type AgentRunRequest,
} from "@/adapters/codex/schema";
import type { WorldstateState } from "@/domain";

import { domainBriefToCodexRunRequest } from "./domain-brief-to-codex";

/**
 * Compiles a server-verifiable capability only from a run already present in
 * the reduced operational ledger. It fails closed when either worldstate or
 * artifact binding differs from the compiled brief.
 */
export function authorizedCodexRunRequest(input: {
  state: WorldstateState;
  runId: string;
  requestId: string;
  secret: string;
  now?: Date;
  nonce?: string;
  authorizationTtlMs?: number;
}): AgentRunRequest {
  const runProjection = input.state.operational.runs[input.runId];
  if (!runProjection) {
    throw new Error(`Run ${input.runId} is not authorized in the operational ledger.`);
  }
  const run = runProjection.run;
  if (run.mode !== "live") {
    throw new Error(`Run ${run.id} is ${run.mode}; only a live run can receive live execution authority.`);
  }
  if (runProjection.status !== "queued") {
    throw new Error(
      `Run ${run.id} cannot be dispatched from ${runProjection.status}; a live authorization is single-use and requires queued state.`,
    );
  }
  const brief = input.state.operational.briefs[run.briefId];
  if (!brief) {
    throw new Error(`Authorized run ${run.id} references missing brief ${run.briefId}.`);
  }
  if (brief.executionMode !== "live") {
    throw new Error(
      `Brief ${brief.id} is bound to ${brief.executionMode}; it cannot receive live execution authority.`,
    );
  }
  if (
    run.baseRevisionId !== brief.baseRevisionId ||
    run.artifactBaseRef !== brief.artifactBaseRef
  ) {
    throw new Error("The authorized run and immutable brief bindings disagree.");
  }
  if (input.state.canonical.head.id !== run.baseRevisionId) {
    throw new Error(
      `Run ${run.id} is stale: it targets ${run.baseRevisionId}, while current head is ${input.state.canonical.head.id}.`,
    );
  }

  const request = domainBriefToCodexRunRequest(
    brief,
    run.id,
    "live",
    input.requestId,
  );
  const now = input.now ?? new Date();
  const ttl = input.authorizationTtlMs ?? 5 * 60 * 1_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 10 * 60 * 1_000) {
    throw new Error("Live run authorization TTL must be between one second and ten minutes.");
  }
  const authorizationInput = {
    runId: run.id,
    mode: "live" as const,
    requestId: input.requestId,
    nonce: input.nonce ?? randomUUID(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    briefDigest: executionBriefDigest(request.brief),
    baseRevisionId: run.baseRevisionId,
    artifactBaseRef: run.artifactBaseRef,
  };
  const capability = signRunAuthorization(authorizationInput, input.secret);
  if (!authorizationMatches(authorizationInput, capability, input.secret)) {
    throw new Error("Failed to compile the run authorization capability.");
  }

  return AgentRunRequestSchema.parse({
    ...request,
    authorization: { ...authorizationInput, capability },
  });
}
