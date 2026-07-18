import { z } from "zod";

import {
  ReplayEvidenceRequestSchema,
  ReplayEvidenceResponseSchema,
  type ReplayEvidenceRequest,
  type ReplayEvidenceResponse,
  type ReplayEvidenceSuccess,
} from "@/adapters/replay-evidence";
import { semanticReplayBriefDigest } from "@/adapters/codex/replay";
import {
  evidenceValidationEvent,
  fingerprint,
  sourceCapturedEvent,
  stableStringify,
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

export const INDEPENDENT_REPLAY_VALIDATOR_ACTOR = {
  id: "actor-independent-replay-validator",
  kind: "system",
  label: "Independent replay verifier",
} as const satisfies Actor;

export const ReplayEvidenceValidationAttemptSchema = z
  .object({
    kind: z.literal("odeu.replay-evidence-validation-attempt"),
    version: z.literal(1),
    request: ReplayEvidenceRequestSchema,
  })
  .strict();

export const ReplayEvidenceValidationExchangeSchema = z
  .object({
    kind: z.literal("odeu.replay-evidence-validation-exchange"),
    version: z.literal(1),
    request: ReplayEvidenceRequestSchema,
    response: ReplayEvidenceResponseSchema,
  })
  .strict();

export type ReplayEvidenceValidationAttempt = z.infer<
  typeof ReplayEvidenceValidationAttemptSchema
>;
export type ReplayEvidenceValidationExchange = z.infer<
  typeof ReplayEvidenceValidationExchangeSchema
>;

export class ReplayEvidenceValidationCoherenceError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Replay evidence validation is incoherent: ${issues.join("; ")}`);
    this.name = "ReplayEvidenceValidationCoherenceError";
  }
}

export class ReplayEvidenceValidationAuthorityError extends Error {
  constructor(readonly actor: Actor) {
    super("Replay evidence artifacts require the independent system validator.");
    this.name = "ReplayEvidenceValidationAuthorityError";
  }
}

export function replayEvidenceValidationAttemptSourceId(
  validationRequestId: string,
): string {
  return `source-replay-evidence-attempt:${validationRequestId}`;
}

export function replayEvidenceValidationExchangeSourceId(
  validationRequestId: string,
): string {
  return `source-replay-evidence-exchange:${validationRequestId}`;
}

function assertValidator(actor: Actor): void {
  if (
    actor.id !== INDEPENDENT_REPLAY_VALIDATOR_ACTOR.id ||
    actor.kind !== INDEPENDENT_REPLAY_VALIDATOR_ACTOR.kind
  ) {
    throw new ReplayEvidenceValidationAuthorityError(actor);
  }
}

function evidenceSourceEvent(input: {
  readonly artifact:
    | ReplayEvidenceValidationAttempt
    | ReplayEvidenceValidationExchange;
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

export function compileReplayEvidenceRequest(input: {
  readonly validationRequestId: string;
  readonly validationId: string;
  readonly run: AgentRun;
  readonly brief: AgentBrief;
  readonly closure: ClosureWitness;
  readonly codexExchange: CodexRunExchange;
}): ReplayEvidenceRequest {
  const { run, brief, closure, codexExchange } = input;
  const issues: string[] = [];
  equalIssue(issues, "run.briefId", run.briefId, brief.id);
  equalIssue(issues, "run.baseRevisionId", run.baseRevisionId, brief.baseRevisionId);
  equalIssue(issues, "run.artifactBaseRef", run.artifactBaseRef, brief.artifactBaseRef);
  equalIssue(issues, "closure.runId", closure.runId, run.id);
  equalIssue(issues, "closure.briefId", closure.briefId, brief.id);
  equalIssue(issues, "closure.baseRevisionId", closure.baseRevisionId, run.baseRevisionId);
  equalIssue(issues, "closure.artifactBaseRef", closure.artifactBaseRef, run.artifactBaseRef);
  equalIssue(issues, "closure.mode", closure.mode, "replay");
  equalIssue(issues, "closure.outcome", closure.outcome, "returned");
  equalIssue(issues, "exchange.request.runId", codexExchange.request.runId, run.id);
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

  const response = codexExchange.response;
  if (!response.ok) {
    issues.push("The exact Codex exchange did not return a closure witness.");
  } else {
    equalIssue(issues, "response.runtime.effectiveMode", response.runtime.effectiveMode, "replay");
    equalIssue(issues, "response.runtime.status", response.runtime.status, "replayed");
    equalIssue(issues, "response.runtime.replayKind", response.runtime.replayKind, "fixture");
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
    if (!response.runtime.replayIdentity) {
      issues.push("The exact replay response has no replay identity.");
    }
  }
  if (issues.length > 0) throw new ReplayEvidenceValidationCoherenceError(issues);
  if (!response.ok || !response.runtime.replayIdentity) {
    throw new ReplayEvidenceValidationCoherenceError([
      "A successful identified replay response is required.",
    ]);
  }
  const exactExchangeSourceId = codexRunExchangeSourceId(
    codexExchange.request.requestId,
  );
  if (!closure.evidenceRefs.includes(exactExchangeSourceId)) {
    throw new ReplayEvidenceValidationCoherenceError([
      "The staged closure is not grounded in the exact Codex exchange selected for validation.",
    ]);
  }

  return ReplayEvidenceRequestSchema.parse({
    validationRequestId: input.validationRequestId,
    validationId: input.validationId,
    closureId: closure.id,
    runId: run.id,
    briefId: brief.id,
    baseRevisionId: run.baseRevisionId,
    artifactBaseRef: run.artifactBaseRef,
    replayIdentity: response.runtime.replayIdentity,
    semanticBriefDigest: semanticReplayBriefDigest(codexExchange.request.brief),
    exchangeSourceId: exactExchangeSourceId,
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
  });
}

export function replayEvidenceValidationAttemptSourceEvent(input: {
  readonly request: ReplayEvidenceRequest;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const artifact = ReplayEvidenceValidationAttemptSchema.parse({
    kind: "odeu.replay-evidence-validation-attempt",
    version: 1,
    request: input.request,
  });
  return evidenceSourceEvent({
    artifact,
    sourceId: replayEvidenceValidationAttemptSourceId(
      artifact.request.validationRequestId,
    ),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

export function assertReplayEvidenceResponseMatchesRequest(input: {
  readonly request: ReplayEvidenceRequest;
  readonly response: ReplayEvidenceResponse;
}): asserts input is {
  readonly request: ReplayEvidenceRequest;
  readonly response: ReplayEvidenceSuccess;
} {
  const request = ReplayEvidenceRequestSchema.parse(input.request);
  const response = ReplayEvidenceResponseSchema.parse(input.response);
  if (!response.ok) {
    throw new ReplayEvidenceValidationCoherenceError([
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
    "replayIdentity",
    "semanticBriefDigest",
    "exchangeSourceId",
  ] as const;
  for (const key of bindingKeys) {
    equalIssue(issues, `response.bindings.${key}`, response.bindings[key], request[key]);
  }
  const declared = new Map(
    request.evidenceRequirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  for (const observation of response.observations) {
    const requirement = declared.get(observation.requirementId);
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
      if (
        observation.artifact !== null &&
        !request.expectedArtifacts.includes(observation.artifact.path)
      ) {
        issues.push(
          `artifact requirement ${requirement.requirementId} observed an undeclared artifact`,
        );
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
        `unsupported requirement ${requirement.requirementId} cannot receive a passing fixture observation`,
      );
    }
  }
  if (issues.length > 0) throw new ReplayEvidenceValidationCoherenceError(issues);
}

export function replayEvidenceValidationExchangeSourceEvent(input: {
  readonly request: ReplayEvidenceRequest;
  readonly response: ReplayEvidenceResponse;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const request = ReplayEvidenceRequestSchema.parse(input.request);
  const response = ReplayEvidenceResponseSchema.parse(input.response);
  const artifact = ReplayEvidenceValidationExchangeSchema.parse({
    kind: "odeu.replay-evidence-validation-exchange",
    version: 1,
    request,
    response,
  });
  return evidenceSourceEvent({
    artifact,
    sourceId: replayEvidenceValidationExchangeSourceId(
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

export function parseReplayEvidenceValidationAttemptSource(
  source: SourceRecord,
): ReplayEvidenceValidationAttempt | null {
  return parseArtifact(
    source,
    ReplayEvidenceValidationAttemptSchema,
    (attempt) =>
      replayEvidenceValidationAttemptSourceId(
        attempt.request.validationRequestId,
      ),
  );
}

export function parseReplayEvidenceValidationExchangeSource(
  source: SourceRecord,
): ReplayEvidenceValidationExchange | null {
  return parseArtifact(
    source,
    ReplayEvidenceValidationExchangeSchema,
    (exchange) =>
      replayEvidenceValidationExchangeSourceId(
        exchange.request.validationRequestId,
      ),
  );
}

export function replayEvidenceValidationRecordedEvent(input: {
  readonly state: WorldstateState;
  readonly request: ReplayEvidenceRequest;
  readonly response: ReplayEvidenceResponse;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"evidence.validation_recorded"> {
  assertValidator(input.actor);
  assertReplayEvidenceResponseMatchesRequest({
    request: input.request,
    response: input.response,
  });
  const response = input.response;
  if (!response.ok) {
    throw new ReplayEvidenceValidationCoherenceError([
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
    equalIssue(
      issues,
      "closure.baseRevisionId",
      closure.baseRevisionId,
      input.request.baseRevisionId,
    );
    equalIssue(
      issues,
      "closure.artifactBaseRef",
      closure.artifactBaseRef,
      input.request.artifactBaseRef,
    );
  }
  if (runProjection) {
    equalIssue(issues, "run.briefId", runProjection.run.briefId, input.request.briefId);
    equalIssue(
      issues,
      "run.baseRevisionId",
      runProjection.run.baseRevisionId,
      input.request.baseRevisionId,
    );
  }
  if (brief) {
    equalIssue(issues, "brief.baseRevisionId", brief.baseRevisionId, input.request.baseRevisionId);
    equalIssue(issues, "brief.artifactBaseRef", brief.artifactBaseRef, input.request.artifactBaseRef);
  }
  const codexExchangeSource =
    input.state.operational.sources[input.request.exchangeSourceId];
  const durableCodexExchange = codexExchangeSource
    ? parseCodexRunExchangeSource(codexExchangeSource)
    : null;
  if (!durableCodexExchange) {
    issues.push(
      "The exact Codex exchange selected by the validation request is not durable or intact.",
    );
  } else if (closure && runProjection && brief) {
    try {
      const recompiled = compileReplayEvidenceRequest({
        validationRequestId: input.request.validationRequestId,
        validationId: input.request.validationId,
        run: runProjection.run,
        brief,
        closure,
        codexExchange: durableCodexExchange,
      });
      if (stableStringify(recompiled) !== stableStringify(input.request)) {
        issues.push(
          "The validation request does not exactly recompile from the durable Codex exchange and current domain records.",
        );
      }
    } catch (error) {
      issues.push(
        error instanceof Error && error.message.trim()
          ? error.message
          : "The durable Codex exchange cannot recompile the validation request.",
      );
    }
  }
  const attemptSource = input.state.operational.sources[
    replayEvidenceValidationAttemptSourceId(
      input.request.validationRequestId,
    )
  ];
  const exactSource = input.state.operational.sources[
    replayEvidenceValidationExchangeSourceId(
      input.request.validationRequestId,
    )
  ];
  const durableAttempt = attemptSource
    ? parseReplayEvidenceValidationAttemptSource(attemptSource)
    : null;
  if (
    !durableAttempt ||
    stableStringify(durableAttempt.request) !== stableStringify(input.request)
  ) {
    issues.push(
      "The exact replay-evidence validation attempt is not durable or does not match the request.",
    );
  }
  if (!exactSource) {
    issues.push("The exact replay-evidence verifier exchange is not durable.");
  } else {
    const durableExchange =
      parseReplayEvidenceValidationExchangeSource(exactSource);
    if (
      !durableExchange ||
      stableStringify(durableExchange.request) !==
        stableStringify(input.request) ||
      stableStringify(durableExchange.response) !==
        stableStringify(input.response)
    ) {
      issues.push(
        "The durable replay-evidence verifier exchange does not exactly match the normalized request and response.",
      );
    }
  }
  if (issues.length > 0) throw new ReplayEvidenceValidationCoherenceError(issues);
  if (!brief) {
    throw new ReplayEvidenceValidationCoherenceError(["Brief is unavailable."]);
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
  const evidenceSourceId = replayEvidenceValidationExchangeSourceId(
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
              ? Array.from(
                  new Set([evidenceSourceId, observation.evidenceRef]),
                )
              : [evidenceSourceId],
          };
        }),
      },
    },
  });
}
