import { z } from "zod";

import {
  LiveEvidenceRequestSchema,
  LiveEvidenceResponseSchema,
  type LiveEvidenceRequest,
  type LiveEvidenceResponse,
  type LiveEvidenceSuccess,
} from "@/adapters/live-evidence";
import {
  evidenceValidationEvent,
  fingerprint,
  sourceCapturedEvent,
  stableStringify,
  unexpectedDelegationProfileChangePaths,
  type Actor,
  type AgentBrief,
  type AgentRun,
  type ClosureWitness,
  type LedgerEventOf,
  type SourceRecord,
  type WorldstateState,
} from "@/domain";
import {
  codexRunExchangeSourceId,
  parseCodexRunExchangeSource,
  type CodexRunExchange,
} from "@/integration/codex-run-evidence";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

export const INDEPENDENT_LIVE_VALIDATOR_ACTOR = {
  id: "actor-independent-live-candidate-validator",
  kind: "system",
  label: "Independent live candidate verifier",
} as const satisfies Actor;

export const LiveEvidenceValidationAttemptSchema = z
  .object({
    kind: z.literal("odeu.live-evidence-validation-attempt"),
    version: z.literal(1),
    request: LiveEvidenceRequestSchema,
  })
  .strict();

export const LiveEvidenceValidationExchangeSchema = z
  .object({
    kind: z.literal("odeu.live-evidence-validation-exchange"),
    version: z.literal(1),
    request: LiveEvidenceRequestSchema,
    response: LiveEvidenceResponseSchema,
  })
  .strict();

export type LiveEvidenceValidationAttempt = z.infer<
  typeof LiveEvidenceValidationAttemptSchema
>;
export type LiveEvidenceValidationExchange = z.infer<
  typeof LiveEvidenceValidationExchangeSchema
>;

export class LiveEvidenceValidationCoherenceError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Live evidence validation is incoherent: ${issues.join("; ")}`);
    this.name = "LiveEvidenceValidationCoherenceError";
  }
}

export class LiveEvidenceValidationAuthorityError extends Error {
  constructor(readonly actor: Actor) {
    super(
      "Live evidence artifacts require the independent live-candidate system validator.",
    );
    this.name = "LiveEvidenceValidationAuthorityError";
  }
}

export function liveEvidenceValidationAttemptSourceId(
  validationRequestId: string,
): string {
  return `source-live-evidence-attempt:${validationRequestId}`;
}

export function liveEvidenceValidationExchangeSourceId(
  validationRequestId: string,
): string {
  return `source-live-evidence-exchange:${validationRequestId}`;
}

function assertValidator(actor: Actor): void {
  if (
    actor.id !== INDEPENDENT_LIVE_VALIDATOR_ACTOR.id ||
    actor.kind !== INDEPENDENT_LIVE_VALIDATOR_ACTOR.kind
  ) {
    throw new LiveEvidenceValidationAuthorityError(actor);
  }
}

function evidenceSourceEvent(input: {
  readonly artifact:
    | LiveEvidenceValidationAttempt
    | LiveEvidenceValidationExchange;
  readonly sourceId: string;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  assertValidator(input.actor);
  return sourceCapturedEvent({
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
    payload: {
      source: {
        id: input.sourceId,
        kind: "system",
        content: stableStringify(input.artifact),
        visibility: "shared",
        integrity: {
          algorithm: "fnv1a64",
          digest: fingerprint(input.artifact),
        },
      },
    },
  });
}

function equalIssue(
  issues: string[],
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (actual !== expected) {
    issues.push(`${label} must equal ${String(expected)}`);
  }
}

function expectedCandidateBinding(request: LiveEvidenceRequest) {
  const { metadata, signature } = request.candidateReceipt;
  return {
    candidateId: metadata.candidateId,
    candidateRef: metadata.candidateRef,
    repositoryId: metadata.repositoryId,
    targetRef: metadata.targetRef,
    baseCommit: metadata.git.baseCommit,
    candidateCommit: metadata.git.candidateCommit,
    candidateTree: metadata.git.candidateTree,
    manifestDigest: metadata.manifest.digest,
    patchDigest: metadata.patch.digest,
    receiptKeyId: signature.keyId,
  };
}

/**
 * Compiles the independent verifier request only from one returned live run,
 * its normalized closure, and the exact durable Codex exchange that contains
 * the signed staged-candidate receipt.
 */
export function compileLiveEvidenceRequest(input: {
  readonly validationRequestId: string;
  readonly validationId: string;
  readonly run: AgentRun;
  readonly brief: AgentBrief;
  readonly closure: ClosureWitness;
  readonly codexExchange: CodexRunExchange;
}): LiveEvidenceRequest {
  const { run, brief, closure, codexExchange } = input;
  const issues: string[] = [];
  if (brief.delegationProfileId === null) {
    issues.push(
      "The live brief has no registered delegation profile for candidate validation.",
    );
  }
  equalIssue(issues, "run.mode", run.mode, "live");
  equalIssue(issues, "brief.executionMode", brief.executionMode, "live");
  equalIssue(issues, "run.briefId", run.briefId, brief.id);
  equalIssue(issues, "run.baseRevisionId", run.baseRevisionId, brief.baseRevisionId);
  equalIssue(issues, "run.artifactBaseRef", run.artifactBaseRef, brief.artifactBaseRef);
  equalIssue(issues, "closure.runId", closure.runId, run.id);
  equalIssue(issues, "closure.briefId", closure.briefId, brief.id);
  equalIssue(issues, "closure.baseRevisionId", closure.baseRevisionId, run.baseRevisionId);
  equalIssue(issues, "closure.artifactBaseRef", closure.artifactBaseRef, run.artifactBaseRef);
  equalIssue(issues, "closure.mode", closure.mode, "live");
  equalIssue(issues, "closure.outcome", closure.outcome, "returned");
  equalIssue(issues, "exchange.request.runId", codexExchange.request.runId, run.id);
  equalIssue(issues, "exchange.request.mode", codexExchange.request.mode, "live");
  equalIssue(
    issues,
    "exchange.request.briefId",
    codexExchange.request.brief.briefId,
    brief.id,
  );
  equalIssue(
    issues,
    "exchange.request.sourceRevisionId",
    codexExchange.request.brief.sourceRevisionId,
    run.baseRevisionId,
  );
  equalIssue(
    issues,
    "exchange.request.artifactBaseRef",
    codexExchange.request.brief.artifactBaseRef,
    run.artifactBaseRef,
  );
  if (codexExchange.request.authorization === null) {
    issues.push("The exact live Codex exchange has no server-issued authorization.");
  }
  try {
    const expectedRequest = domainBriefToCodexRunRequest(
      brief,
      run.id,
      "live",
      codexExchange.request.requestId,
    );
    if (
      stableStringify(codexExchange.request.brief) !==
      stableStringify(expectedRequest.brief)
    ) {
      issues.push(
        "The exact live Codex exchange does not contain the immutable domain brief projection.",
      );
    }
  } catch (error) {
    issues.push(
      error instanceof Error && error.message.trim()
        ? error.message
        : "The immutable domain brief cannot reproduce the live Codex request.",
    );
  }

  const response = codexExchange.response;
  if (!response.ok) {
    issues.push("The exact live Codex exchange did not return a closure witness.");
  } else {
    equalIssue(issues, "response.runtime.effectiveMode", response.runtime.effectiveMode, "live");
    equalIssue(issues, "response.runtime.status", response.runtime.status, "returned");
    equalIssue(issues, "response.runtime.replayIdentity", response.runtime.replayIdentity, null);
    equalIssue(issues, "response.runtime.replayKind", response.runtime.replayKind, null);
    equalIssue(issues, "response.closure.runId", response.closure.runId, run.id);
    equalIssue(issues, "response.closure.briefId", response.closure.briefId, brief.id);
    equalIssue(
      issues,
      "response.closure.sourceRevisionIdUsed",
      response.closure.sourceRevisionIdUsed,
      run.baseRevisionId,
    );
    equalIssue(
      issues,
      "response.closure.artifactBaseRefUsed",
      response.closure.artifactBaseRefUsed,
      run.artifactBaseRef,
    );
    equalIssue(issues, "response.closure.outcome", response.closure.report.outcome, "returned");
    if (!response.closure.artifactCandidate) {
      issues.push("The returned live Codex exchange has no signed staged candidate receipt.");
    }
  }
  if (issues.length > 0) throw new LiveEvidenceValidationCoherenceError(issues);
  if (!response.ok || !response.closure.artifactCandidate) {
    throw new LiveEvidenceValidationCoherenceError([
      "A returned live response with a staged candidate is required.",
    ]);
  }

  const candidateReceipt = response.closure.artifactCandidate;
  const candidate = candidateReceipt.metadata;
  const artifactBaseCommit = run.artifactBaseRef.match(
    /^git:([0-9a-f]{40}|[0-9a-f]{64})$/,
  )?.[1];
  equalIssue(issues, "candidate.runId", candidate.runId, run.id);
  equalIssue(issues, "candidate.briefId", candidate.briefId, brief.id);
  equalIssue(
    issues,
    "candidate.baseRevisionId",
    candidate.baseRevisionId,
    run.baseRevisionId,
  );
  equalIssue(issues, "candidate.git.baseCommit", candidate.git.baseCommit, artifactBaseCommit);
  equalIssue(
    issues,
    "closure.artifactCandidateId",
    closure.artifactCandidateId,
    candidate.candidateId,
  );
  equalIssue(
    issues,
    "closure.artifactCandidateCommit",
    closure.artifactCandidateCommit,
    candidate.git.candidateCommit,
  );
  const unexpectedChangedPaths = brief.delegationProfileId
    ? unexpectedDelegationProfileChangePaths(
        brief.delegationProfileId,
        candidate.manifest.entries.map((entry) => entry.path),
      )
    : [];
  if (!brief.delegationProfileId) {
    issues.push(
      "The live brief has no registered delegation profile for candidate validation.",
    );
  } else if (unexpectedChangedPaths.length > 0) {
    issues.push(
      `The signed staged candidate changes paths outside the exact ${brief.delegationProfileId} allowed-change envelope: ${unexpectedChangedPaths.join(", ")}.`,
    );
  }
  for (const expectedArtifact of brief.expectedArtifacts) {
    const changed = candidate.manifest.entries.some(
      (entry) => entry.path === expectedArtifact && entry.status !== "deleted",
    );
    if (!changed) {
      issues.push(
        `The signed staged candidate does not contain expected artifact ${expectedArtifact}.`,
      );
    }
  }
  const exactExchangeSourceId = codexRunExchangeSourceId(
    codexExchange.request.requestId,
  );
  if (!closure.evidenceRefs.includes(exactExchangeSourceId)) {
    issues.push(
      "The staged closure is not grounded in the exact live Codex exchange selected for validation.",
    );
  }
  if (issues.length > 0) throw new LiveEvidenceValidationCoherenceError(issues);

  return LiveEvidenceRequestSchema.parse({
    validationRequestId: input.validationRequestId,
    validationId: input.validationId,
    closureId: closure.id,
    runId: run.id,
    briefId: brief.id,
    baseRevisionId: run.baseRevisionId,
    artifactBaseRef: run.artifactBaseRef,
    exchangeSourceId: exactExchangeSourceId,
    artifactCandidateId: candidate.candidateId,
    artifactCandidateCommit: candidate.git.candidateCommit,
    mode: "live",
    evidenceRequirements: brief.evidenceContract.requirements.map(
      (requirement) => ({
        requirementId: requirement.id,
        label: requirement.label,
        kind: requirement.kind,
        command: requirement.command ?? null,
        required: requirement.required,
      }),
    ),
    expectedArtifacts: brief.expectedArtifacts,
    candidateReceipt,
  });
}

export function liveEvidenceValidationAttemptSourceEvent(input: {
  readonly request: LiveEvidenceRequest;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const artifact = LiveEvidenceValidationAttemptSchema.parse({
    kind: "odeu.live-evidence-validation-attempt",
    version: 1,
    request: input.request,
  });
  return evidenceSourceEvent({
    artifact,
    sourceId: liveEvidenceValidationAttemptSourceId(
      artifact.request.validationRequestId,
    ),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

export function assertLiveEvidenceResponseMatchesRequest(input: {
  readonly request: LiveEvidenceRequest;
  readonly response: LiveEvidenceResponse;
}): asserts input is {
  readonly request: LiveEvidenceRequest;
  readonly response: LiveEvidenceSuccess;
} {
  const request = LiveEvidenceRequestSchema.parse(input.request);
  const response = LiveEvidenceResponseSchema.parse(input.response);
  if (!response.ok) {
    throw new LiveEvidenceValidationCoherenceError([
      `${response.error.code}: ${response.error.message}`,
    ]);
  }
  const issues: string[] = [];
  const bindingKeys = [
    "validationRequestId",
    "validationId",
    "closureId",
    "runId",
    "briefId",
    "baseRevisionId",
    "artifactBaseRef",
    "exchangeSourceId",
    "artifactCandidateId",
    "artifactCandidateCommit",
  ] as const;
  for (const key of bindingKeys) {
    equalIssue(issues, `response.bindings.${key}`, response.bindings[key], request[key]);
  }
  if (
    stableStringify(response.candidate) !==
    stableStringify(expectedCandidateBinding(request))
  ) {
    issues.push(
      "response.candidate must exactly match the signed staged-candidate receipt",
    );
  }

  const declared = new Map(
    request.evidenceRequirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  const observed = new Set<string>();
  for (const observation of response.observations) {
    const requirement = declared.get(observation.requirementId);
    observed.add(observation.requirementId);
    if (!requirement) {
      issues.push(
        `response observation ${observation.requirementId} is not declared by the brief`,
      );
      continue;
    }
    if (requirement.kind === "artifact") {
      if (observation.execution !== null) {
        issues.push(
          `artifact requirement ${requirement.requirementId} cannot be satisfied by execution evidence`,
        );
      }
      if (observation.result === "passed" && observation.artifact === null) {
        issues.push(
          `passing artifact requirement ${requirement.requirementId} must carry artifact evidence`,
        );
      }
      if (observation.artifact !== null) {
        const entry = request.candidateReceipt.metadata.manifest.entries.find(
          (candidate) => candidate.path === observation.artifact?.path,
        );
        if (
          !request.expectedArtifacts.includes(observation.artifact.path) ||
          !entry ||
          entry.status === "deleted" ||
          entry.newBlob !== observation.artifact.blob
        ) {
          issues.push(
            `artifact requirement ${requirement.requirementId} must observe the exact declared candidate blob`,
          );
        }
      }
      continue;
    }
    if (requirement.kind === "test") {
      if (observation.artifact !== null) {
        issues.push(
          `test requirement ${requirement.requirementId} cannot be satisfied by artifact evidence`,
        );
      }
      if (observation.result === "passed" && observation.execution === null) {
        issues.push(
          `passing test requirement ${requirement.requirementId} must carry execution evidence`,
        );
      }
      if (
        observation.execution !== null &&
        observation.execution.declaredCommand !== requirement.command
      ) {
        issues.push(
          `test requirement ${requirement.requirementId} execution must match its declared command`,
        );
      }
      continue;
    }
    if (observation.result === "passed") {
      issues.push(
        `unsupported requirement ${requirement.requirementId} cannot receive a passing live observation`,
      );
    }
  }
  for (const requirement of request.evidenceRequirements) {
    if (!observed.has(requirement.requirementId)) {
      issues.push(
        `response is missing declared requirement ${requirement.requirementId}`,
      );
    }
  }
  if (issues.length > 0) throw new LiveEvidenceValidationCoherenceError(issues);
}

export function liveEvidenceValidationExchangeSourceEvent(input: {
  readonly request: LiveEvidenceRequest;
  readonly response: LiveEvidenceResponse;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const request = LiveEvidenceRequestSchema.parse(input.request);
  const response = LiveEvidenceResponseSchema.parse(input.response);
  const artifact = LiveEvidenceValidationExchangeSchema.parse({
    kind: "odeu.live-evidence-validation-exchange",
    version: 1,
    request,
    response,
  });
  return evidenceSourceEvent({
    artifact,
    sourceId: liveEvidenceValidationExchangeSourceId(
      request.validationRequestId,
    ),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

function parseArtifact<T>(
  source: SourceRecord,
  schema: z.ZodType<T>,
  expectedId: (artifact: T) => string,
): T | null {
  let artifact: T;
  try {
    artifact = schema.parse(JSON.parse(source.content));
  } catch {
    return null;
  }
  if (
    source.kind !== "system" ||
    source.visibility !== "shared" ||
    source.id !== expectedId(artifact) ||
    source.integrity?.algorithm !== "fnv1a64" ||
    source.integrity.digest !== fingerprint(artifact)
  ) {
    return null;
  }
  return artifact;
}

export function parseLiveEvidenceValidationAttemptSource(
  source: SourceRecord,
): LiveEvidenceValidationAttempt | null {
  return parseArtifact(
    source,
    LiveEvidenceValidationAttemptSchema,
    (attempt) =>
      liveEvidenceValidationAttemptSourceId(
        attempt.request.validationRequestId,
      ),
  );
}

export function parseLiveEvidenceValidationExchangeSource(
  source: SourceRecord,
): LiveEvidenceValidationExchange | null {
  return parseArtifact(
    source,
    LiveEvidenceValidationExchangeSchema,
    (exchange) =>
      liveEvidenceValidationExchangeSourceId(
        exchange.request.validationRequestId,
      ),
  );
}

export function liveEvidenceValidationRecordedEvent(input: {
  readonly state: WorldstateState;
  readonly request: LiveEvidenceRequest;
  readonly response: LiveEvidenceResponse;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"evidence.validation_recorded"> {
  assertValidator(input.actor);
  assertLiveEvidenceResponseMatchesRequest({
    request: input.request,
    response: input.response,
  });
  const response = input.response;
  if (!response.ok) {
    throw new LiveEvidenceValidationCoherenceError([
      "Only a completed verifier response can be normalized.",
    ]);
  }

  const closure = input.state.operational.closures[input.request.closureId];
  const runProjection = input.state.operational.runs[input.request.runId];
  const brief = input.state.operational.briefs[input.request.briefId];
  const issues: string[] = [];
  if (!closure) issues.push(`Closure ${input.request.closureId} is missing.`);
  if (!runProjection) issues.push(`Run ${input.request.runId} is missing.`);
  if (!brief) issues.push(`Brief ${input.request.briefId} is missing.`);
  if (closure) {
    equalIssue(issues, "closure.runId", closure.runId, input.request.runId);
    equalIssue(issues, "closure.briefId", closure.briefId, input.request.briefId);
    equalIssue(issues, "closure.baseRevisionId", closure.baseRevisionId, input.request.baseRevisionId);
    equalIssue(issues, "closure.artifactBaseRef", closure.artifactBaseRef, input.request.artifactBaseRef);
    equalIssue(issues, "closure.artifactCandidateId", closure.artifactCandidateId, input.request.artifactCandidateId);
    equalIssue(issues, "closure.artifactCandidateCommit", closure.artifactCandidateCommit, input.request.artifactCandidateCommit);
    equalIssue(issues, "closure.mode", closure.mode, "live");
  }
  if (runProjection) {
    equalIssue(issues, "run.briefId", runProjection.run.briefId, input.request.briefId);
    equalIssue(issues, "run.baseRevisionId", runProjection.run.baseRevisionId, input.request.baseRevisionId);
    equalIssue(issues, "run.artifactBaseRef", runProjection.run.artifactBaseRef, input.request.artifactBaseRef);
    equalIssue(issues, "run.mode", runProjection.run.mode, "live");
  }
  if (brief) {
    equalIssue(issues, "brief.baseRevisionId", brief.baseRevisionId, input.request.baseRevisionId);
    equalIssue(issues, "brief.artifactBaseRef", brief.artifactBaseRef, input.request.artifactBaseRef);
    equalIssue(issues, "brief.executionMode", brief.executionMode, "live");
  }

  const codexExchangeSource =
    input.state.operational.sources[input.request.exchangeSourceId];
  const durableCodexExchange = codexExchangeSource
    ? parseCodexRunExchangeSource(codexExchangeSource)
    : null;
  if (!durableCodexExchange) {
    issues.push(
      "The exact live Codex exchange selected by the validation request is not durable or intact.",
    );
  } else if (closure && runProjection && brief) {
    try {
      const recompiled = compileLiveEvidenceRequest({
        validationRequestId: input.request.validationRequestId,
        validationId: input.request.validationId,
        run: runProjection.run,
        brief,
        closure,
        codexExchange: durableCodexExchange,
      });
      if (stableStringify(recompiled) !== stableStringify(input.request)) {
        issues.push(
          "The live validation request does not exactly recompile from the durable Codex exchange and current domain records.",
        );
      }
    } catch (error) {
      issues.push(
        error instanceof Error && error.message.trim()
          ? error.message
          : "The durable live Codex exchange cannot recompile the validation request.",
      );
    }
  }

  const attemptSource = input.state.operational.sources[
    liveEvidenceValidationAttemptSourceId(input.request.validationRequestId)
  ];
  const exchangeSource = input.state.operational.sources[
    liveEvidenceValidationExchangeSourceId(input.request.validationRequestId)
  ];
  const durableAttempt = attemptSource
    ? parseLiveEvidenceValidationAttemptSource(attemptSource)
    : null;
  if (
    !durableAttempt ||
    stableStringify(durableAttempt.request) !== stableStringify(input.request)
  ) {
    issues.push(
      "The exact live-evidence validation attempt is not durable or does not match the request.",
    );
  }
  const durableExchange = exchangeSource
    ? parseLiveEvidenceValidationExchangeSource(exchangeSource)
    : null;
  if (
    !durableExchange ||
    stableStringify(durableExchange.request) !== stableStringify(input.request) ||
    stableStringify(durableExchange.response) !== stableStringify(input.response)
  ) {
    issues.push(
      "The durable live-evidence verifier exchange does not exactly match the normalized request and response.",
    );
  }
  if (issues.length > 0) throw new LiveEvidenceValidationCoherenceError(issues);
  if (!brief) {
    throw new LiveEvidenceValidationCoherenceError(["Brief is unavailable."]);
  }

  const freshness =
    input.state.canonical.head.id === input.request.baseRevisionId
      ? "current"
      : "stale";
  const observed = new Map(
    response.observations.map((observation) => [
      observation.requirementId,
      observation,
    ]),
  );
  const evidenceSourceId = liveEvidenceValidationExchangeSourceId(
    input.request.validationRequestId,
  );

  return evidenceValidationEvent({
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
    payload: {
      validation: {
        id: input.request.validationId,
        closureId: input.request.closureId,
        briefId: input.request.briefId,
        baseRevisionId: input.request.baseRevisionId,
        evidenceSourceId,
        validator: input.actor,
        observedAt: response.observedAt,
        observations: brief.evidenceContract.requirements.map((requirement) => {
          const observation = observed.get(requirement.id);
          return {
            requirementId: requirement.id,
            result: observation?.result ?? "missing",
            freshness,
            evidenceRefs: observation
              ? Array.from(new Set([evidenceSourceId, observation.evidenceRef]))
              : [evidenceSourceId],
          };
        }),
      },
    },
  });
}
