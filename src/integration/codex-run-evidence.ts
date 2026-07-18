import { z } from "zod";

import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  type AgentLifecycleEvent,
  type AgentRunRequest,
  type AgentRunResponse,
} from "@/adapters/codex/schema";
import {
  AgentBriefSchema as DomainAgentBriefSchema,
  AgentRunSchema as DomainAgentRunSchema,
  closureStagedEvent,
  fingerprint,
  runLifecycleEvent,
  sourceCapturedEvent,
  stableStringify,
  type Actor,
  type AgentBrief,
  type AgentRun,
  type LedgerEventOf,
  type SourceRecord,
} from "@/domain";

import { domainBriefToCodexRunRequest } from "./domain-brief-to-codex";

export const CodexRunAttemptSchema = z
  .object({
    kind: z.literal("odeu.codex-run-attempt"),
    version: z.literal(1),
    request: AgentRunRequestSchema,
  })
  .strict();

export const CodexRunExchangeSchema = z
  .object({
    kind: z.literal("odeu.codex-run-exchange"),
    version: z.literal(1),
    request: AgentRunRequestSchema,
    response: AgentRunResponseSchema,
  })
  .strict();

export const CODEX_RUN_NORMALIZATION_FAILURE_MESSAGE_MAX_LENGTH = 2_000;

export const CodexRunNormalizationFailureSchema = z
  .object({
    kind: z.literal("odeu.codex-run-normalization-failure"),
    version: z.literal(1),
    requestId: z.string().trim().min(1).max(160),
    runId: z.string().trim().min(1).max(160),
    briefId: z.string().trim().min(1).max(160),
    code: z.enum(["coherence_rejected", "state_conflict"]),
    message: z
      .string()
      .trim()
      .min(1)
      .max(CODEX_RUN_NORMALIZATION_FAILURE_MESSAGE_MAX_LENGTH),
  })
  .strict();

export type CodexRunAttempt = z.infer<typeof CodexRunAttemptSchema>;
export type CodexRunExchange = z.infer<typeof CodexRunExchangeSchema>;
export type CodexRunNormalizationFailure = z.infer<
  typeof CodexRunNormalizationFailureSchema
>;

export class CodexRunResponseCoherenceError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Codex response does not match its authorized run: ${issues.join("; ")}`);
    this.name = "CodexRunResponseCoherenceError";
  }
}

export class CodexRunEvidenceAuthorityError extends Error {
  constructor(
    readonly actorId: string,
    readonly actorKind: Actor["kind"],
  ) {
    super(
      `Codex run evidence must be recorded by a system actor; received ${actorKind} actor ${actorId}.`,
    );
    this.name = "CodexRunEvidenceAuthorityError";
  }
}

export function codexRunAttemptSourceId(requestId: string): string {
  return `source-codex-attempt:${requestId}`;
}

export function codexRunExchangeSourceId(requestId: string): string {
  return `source-codex-exchange:${requestId}`;
}

export function codexRunNormalizationFailureSourceId(
  requestId: string,
  code: CodexRunNormalizationFailure["code"],
): string {
  return `source-codex-normalization-failure:${requestId}:${code}`;
}

function evidenceSourceEvent(input: {
  readonly artifact:
    | CodexRunAttempt
    | CodexRunExchange
    | CodexRunNormalizationFailure;
  readonly sourceId: string;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  if (input.actor.kind !== "system") {
    throw new CodexRunEvidenceAuthorityError(input.actor.id, input.actor.kind);
  }
  const digest = fingerprint(input.artifact);
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
        integrity: { algorithm: "fnv1a64", digest },
      },
    },
  });
}

function immutableBindingIssues(input: {
  readonly run: AgentRun;
  readonly brief: AgentBrief;
  readonly request: AgentRunRequest;
}): string[] {
  const { run, brief, request } = input;
  const issues: string[] = [];
  const equal = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) issues.push(`${label} must equal ${String(expected)}`);
  };

  equal("request.runId", request.runId, run.id);
  equal("request.mode", request.mode, run.mode);
  equal("run.briefId", run.briefId, brief.id);
  equal("run.baseRevisionId", run.baseRevisionId, brief.baseRevisionId);
  equal("run.artifactBaseRef", run.artifactBaseRef, brief.artifactBaseRef);
  equal("request.brief.briefId", request.brief.briefId, brief.id);
  equal(
    "request.brief.sourceRevisionId",
    request.brief.sourceRevisionId,
    run.baseRevisionId,
  );
  equal(
    "request.brief.artifactBaseRef",
    request.brief.artifactBaseRef,
    run.artifactBaseRef,
  );
  const expectedRequest = domainBriefToCodexRunRequest(
    brief,
    request.runId,
    request.mode,
    request.requestId,
  );
  if (stableStringify(request.brief) !== stableStringify(expectedRequest.brief)) {
    issues.push("request.brief must equal the immutable domain brief projection");
  }
  if (request.authorization !== null) {
    equal("request.authorization.runId", request.authorization.runId, run.id);
    equal(
      "request.authorization.requestId",
      request.authorization.requestId,
      request.requestId,
    );
    equal(
      "request.authorization.baseRevisionId",
      request.authorization.baseRevisionId,
      run.baseRevisionId,
    );
    equal(
      "request.authorization.artifactBaseRef",
      request.authorization.artifactBaseRef,
      run.artifactBaseRef,
    );
  }
  return issues;
}

function parseBindings(input: {
  readonly run: AgentRun;
  readonly brief: AgentBrief;
  readonly request: AgentRunRequest;
}) {
  return {
    run: DomainAgentRunSchema.parse(input.run),
    brief: DomainAgentBriefSchema.parse(input.brief),
    request: AgentRunRequestSchema.parse(input.request),
  };
}

export function codexRunAttemptSourceEvent(input: {
  readonly run: AgentRun;
  readonly brief: AgentBrief;
  readonly request: AgentRunRequest;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const bindings = parseBindings(input);
  const issues = immutableBindingIssues(bindings);
  if (issues.length > 0) throw new CodexRunResponseCoherenceError(issues);
  const artifact = CodexRunAttemptSchema.parse({
    kind: "odeu.codex-run-attempt",
    version: 1,
    request: bindings.request,
  });
  return evidenceSourceEvent({
    artifact,
    sourceId: codexRunAttemptSourceId(bindings.request.requestId),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

const TRANSITIONS: Readonly<Record<AgentLifecycleEvent["status"], readonly AgentLifecycleEvent["status"][]>> = {
  queued: ["received", "failed", "cancelled"],
  received: ["working", "blocked", "failed", "cancelled"],
  working: ["blocked", "returned", "failed", "cancelled"],
  blocked: ["working", "returned", "failed", "cancelled"],
  returned: [],
  failed: [],
  cancelled: [],
};

function lifecycleIssues(
  events: readonly AgentLifecycleEvent[],
  terminalStatus: AgentLifecycleEvent["status"],
): string[] {
  const issues: string[] = [];
  if (events[0]?.status !== "queued") {
    issues.push("lifecycle must begin with queued");
  }
  events.forEach((event, index) => {
    if (event.sequence !== index) {
      issues.push(`lifecycle sequence ${event.sequence} must equal ${index}`);
    }
    if (index > 0) {
      const previous = events[index - 1];
      if (!previous || !TRANSITIONS[previous.status].includes(event.status)) {
        issues.push(
          `lifecycle cannot move from ${previous?.status ?? "missing"} to ${event.status}`,
        );
      }
      if (previous && Date.parse(event.at) < Date.parse(previous.at)) {
        issues.push(
          `lifecycle timestamp at sequence ${event.sequence} precedes sequence ${previous.sequence}`,
        );
      }
    }
  });
  if (events.at(-1)?.status !== terminalStatus) {
    issues.push(`lifecycle must end in ${terminalStatus}`);
  }
  return issues;
}

export function assertCodexRunResponseMatchesRun(input: {
  readonly run: AgentRun;
  readonly brief: AgentBrief;
  readonly request: AgentRunRequest;
  readonly response: AgentRunResponse;
}): void {
  const bindings = parseBindings(input);
  const response = AgentRunResponseSchema.parse(input.response);
  const issues = immutableBindingIssues(bindings);
  const equal = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) issues.push(`${label} must equal ${String(expected)}`);
  };

  if (response.runtime.effectiveMode !== null) {
    equal("response.runtime.effectiveMode", response.runtime.effectiveMode, bindings.run.mode);
  }
  equal("response.runtime.requestedMode", response.runtime.requestedMode, bindings.run.mode);

  if (response.ok) {
    const closureOutcome = response.closure.report.outcome;
    const expectedRuntimeStatus =
      bindings.run.mode === "replay" && closureOutcome === "returned"
        ? "replayed"
        : closureOutcome;
    equal(
      "response.runtime.status",
      response.runtime.status,
      expectedRuntimeStatus,
    );
    equal("response.closure.runId", response.closure.runId, bindings.run.id);
    equal("response.closure.briefId", response.closure.briefId, bindings.brief.id);
    equal(
      "response.closure.sourceRevisionIdUsed",
      response.closure.sourceRevisionIdUsed,
      bindings.run.baseRevisionId,
    );
    equal(
      "response.closure.artifactBaseRefUsed",
      response.closure.artifactBaseRefUsed,
      bindings.run.artifactBaseRef,
    );
    issues.push(...lifecycleIssues(response.events, response.closure.report.outcome));
  } else if (response.runtime.status === "blocked") {
    if (!response.blockedRun) {
      issues.push("a blocked response must carry blockedRun evidence");
    } else {
      equal("response.blockedRun.runId", response.blockedRun.runId, bindings.run.id);
      equal("response.blockedRun.briefId", response.blockedRun.briefId, bindings.brief.id);
      equal(
        "response.blockedRun.sourceRevisionIdUsed",
        response.blockedRun.sourceRevisionIdUsed,
        bindings.run.baseRevisionId,
      );
      equal(
        "response.blockedRun.artifactBaseRefUsed",
        response.blockedRun.artifactBaseRefUsed,
        bindings.run.artifactBaseRef,
      );
      issues.push(...lifecycleIssues(response.blockedRun.events, "blocked"));
    }
  } else if (response.blockedRun !== null) {
    issues.push("a non-blocked response cannot carry blockedRun evidence");
  }

  if (issues.length > 0) throw new CodexRunResponseCoherenceError(issues);
}

export function codexRunExchangeSourceEvent(input: {
  readonly request: AgentRunRequest;
  readonly response: AgentRunResponse;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const artifact = CodexRunExchangeSchema.parse({
    kind: "odeu.codex-run-exchange",
    version: 1,
    request: input.request,
    response: input.response,
  });
  return evidenceSourceEvent({
    artifact,
    sourceId: codexRunExchangeSourceId(input.request.requestId),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

function boundedNormalizationFailureMessage(message: string): string {
  const normalized = message.trim() || "Codex response normalization failed.";
  if (
    normalized.length <= CODEX_RUN_NORMALIZATION_FAILURE_MESSAGE_MAX_LENGTH
  ) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    CODEX_RUN_NORMALIZATION_FAILURE_MESSAGE_MAX_LENGTH - 1,
  )}…`;
}

export function codexRunNormalizationFailureSourceEvent(input: {
  readonly requestId: string;
  readonly runId: string;
  readonly briefId: string;
  readonly code: CodexRunNormalizationFailure["code"];
  readonly message: string;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const artifact = CodexRunNormalizationFailureSchema.parse({
    kind: "odeu.codex-run-normalization-failure",
    version: 1,
    requestId: input.requestId,
    runId: input.runId,
    briefId: input.briefId,
    code: input.code,
    message: boundedNormalizationFailureMessage(input.message),
  });
  return evidenceSourceEvent({
    artifact,
    sourceId: codexRunNormalizationFailureSourceId(
      artifact.requestId,
      artifact.code,
    ),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

export function parseCodexRunAttempt(content: string): CodexRunAttempt | null {
  try {
    return CodexRunAttemptSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

export function parseCodexRunExchange(content: string): CodexRunExchange | null {
  try {
    return CodexRunExchangeSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

export function parseCodexRunNormalizationFailure(
  content: string,
): CodexRunNormalizationFailure | null {
  try {
    return CodexRunNormalizationFailureSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

function hasValidEvidencePosture(
  source: SourceRecord,
  artifact:
    | CodexRunAttempt
    | CodexRunExchange
    | CodexRunNormalizationFailure,
  expectedId: string,
): boolean {
  return (
    source.kind === "system" &&
    source.visibility === "shared" &&
    source.id === expectedId &&
    source.integrity?.algorithm === "fnv1a64" &&
    source.integrity.digest === fingerprint(artifact)
  );
}

export function parseCodexRunAttemptSource(
  source: SourceRecord,
): CodexRunAttempt | null {
  const attempt = parseCodexRunAttempt(source.content);
  if (
    !attempt ||
    !hasValidEvidencePosture(
      source,
      attempt,
      codexRunAttemptSourceId(attempt.request.requestId),
    )
  ) {
    return null;
  }
  return attempt;
}

export function parseCodexRunExchangeSource(
  source: SourceRecord,
): CodexRunExchange | null {
  const exchange = parseCodexRunExchange(source.content);
  if (
    !exchange ||
    !hasValidEvidencePosture(
      source,
      exchange,
      codexRunExchangeSourceId(exchange.request.requestId),
    )
  ) {
    return null;
  }
  return exchange;
}

export function parseCodexRunNormalizationFailureSource(
  source: SourceRecord,
): CodexRunNormalizationFailure | null {
  const failure = parseCodexRunNormalizationFailure(source.content);
  if (
    !failure ||
    !hasValidEvidencePosture(
      source,
      failure,
      codexRunNormalizationFailureSourceId(failure.requestId, failure.code),
    )
  ) {
    return null;
  }
  return failure;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function itemReference(threadId: string | null, itemId: string): string {
  return `codex-item:${threadId ?? "unidentified"}/${itemId}`;
}

function closureFromResponse(input: {
  readonly run: AgentRun;
  readonly response: Extract<AgentRunResponse, { ok: true }>;
  readonly closureId: string;
  readonly exchangeSourceId: string;
}) {
  const { closure } = input.response;
  const failedClaims = closure.report.claimedChecks
    .filter((check) => check.status !== "passed")
    .map((check) => `Claimed check ${check.label}: ${check.detail}`);
  const failedSdkFiles = closure.sdkObservations.fileChanges
    .filter((observation) => observation.status === "failed")
    .map(
      (observation) =>
        `SDK-observed file change failed for ${observation.path}.`,
    );
  const failedSdkCommands = closure.sdkObservations.commands
    .filter((observation) => observation.status === "failed")
    .map((observation) =>
      `SDK-observed command failed${observation.exitCode === null ? "" : ` with exit ${observation.exitCode}`}: ${observation.command}`,
    );
  const itemRefs = unique([
    ...closure.sdkObservations.fileChanges.map((item) =>
      itemReference(closure.workerThreadId, item.itemId),
    ),
    ...closure.sdkObservations.commands.map((item) =>
      itemReference(closure.workerThreadId, item.itemId),
    ),
  ]);

  return {
    id: input.closureId,
    runId: input.run.id,
    briefId: input.run.briefId,
    baseRevisionId: input.run.baseRevisionId,
    artifactBaseRef: input.run.artifactBaseRef,
    artifactCandidateId:
      closure.artifactCandidate?.metadata.candidateId ?? null,
    artifactCandidateCommit:
      closure.artifactCandidate?.metadata.git.candidateCommit ?? null,
    mode: input.run.mode,
    outcome: closure.report.outcome,
    claimedCompletion: closure.report.completionClaim.claimedDone,
    summary: closure.report.candidateReconciliationSummary,
    changes: [
      ...closure.report.claimedEffects.map((effect) => `Claimed effect: ${effect}`),
      ...closure.report.claimedArtifacts.map(
        (artifact) =>
          `Claimed artifact ${artifact.kind} at ${artifact.path}: ${artifact.summary}`,
      ),
    ],
    artifactRefs: unique([
      ...closure.report.claimedArtifacts.map((artifact) => artifact.reference),
      ...(closure.artifactCandidate
        ? [closure.artifactCandidate.metadata.candidateId]
        : []),
    ]),
    evidenceRefs: unique([
      input.exchangeSourceId,
      ...closure.report.claimedChecks.map((check) => check.reference),
      ...itemRefs,
    ]),
    failures: [
      ...closure.report.failures,
      ...failedClaims,
      ...failedSdkFiles,
      ...failedSdkCommands,
    ],
    unresolved: closure.report.unresolved,
  };
}

export type CodexRunResponseEventBatch = readonly [
  LedgerEventOf<"source.captured">,
  ...Array<
    | LedgerEventOf<"run.lifecycle_recorded">
    | LedgerEventOf<"closure.staged">
  >,
];

/**
 * Turns one validated adapter exchange into immutable operational evidence.
 * The exact exchange remains the claim/observation boundary; this function does
 * not create evidence validation, a reconciliation delta, or canonical state.
 * Adapter timestamps remain inside that exchange; normalized domain events use the
 * host-owned recordedAt observation time.
 */
export function codexRunResponseEvents(input: {
  readonly run: AgentRun;
  readonly brief: AgentBrief;
  readonly request: AgentRunRequest;
  readonly response: AgentRunResponse;
  readonly recordedAt: string;
  readonly systemActor: Actor;
  readonly closureId?: string;
}): CodexRunResponseEventBatch {
  assertCodexRunResponseMatchesRun(input);
  const exchangeSourceId = codexRunExchangeSourceId(input.request.requestId);
  const events: Array<
    LedgerEventOf<"run.lifecycle_recorded"> | LedgerEventOf<"closure.staged">
  > = [];
  const exchange = codexRunExchangeSourceEvent({
    request: input.request,
    response: input.response,
    eventId: `event-codex-exchange:${input.request.requestId}`,
    commandId: `command-codex-exchange:${input.request.requestId}`,
    occurredAt: input.recordedAt,
    actor: input.systemActor,
  });
  const lifecycle = input.response.ok
    ? input.response.events
    : input.response.blockedRun?.events ?? [];

  if (lifecycle.length > 0) {
    lifecycle.slice(1).forEach((item, index, normalized) => {
      if (item.status === "queued") {
        throw new CodexRunResponseCoherenceError([
          "queued may appear only as the first adapter lifecycle event",
        ]);
      }
      const terminal = index === normalized.length - 1;
      events.push(
        runLifecycleEvent({
          eventId: `event-codex-lifecycle:${input.run.id}:${item.sequence}`,
          commandId: `command-codex-lifecycle:${input.run.id}:${item.sequence}`,
          occurredAt: input.recordedAt,
          actor: input.systemActor,
          payload: {
            runId: input.run.id,
            status: item.status,
            message: item.detail,
            evidenceRefs: terminal ? [exchangeSourceId] : [],
          },
        }),
      );
    });
  } else {
    if (input.response.ok) {
      throw new CodexRunResponseCoherenceError(["a successful response has no lifecycle"]);
    }
    events.push(
      runLifecycleEvent({
        eventId: `event-codex-lifecycle:${input.run.id}:failed`,
        commandId: `command-codex-lifecycle:${input.run.id}:failed`,
        occurredAt: input.recordedAt,
        actor: input.systemActor,
        payload: {
          runId: input.run.id,
          status: "failed",
          message: input.response.error.message,
          evidenceRefs: [exchangeSourceId],
        },
      }),
    );
  }

  if (input.response.ok) {
    events.push(
      closureStagedEvent({
        eventId: `event-codex-closure:${input.run.id}`,
        commandId: `command-codex-closure:${input.run.id}`,
        occurredAt: input.recordedAt,
        actor: input.systemActor,
        payload: {
          closure: closureFromResponse({
            run: input.run,
            response: input.response,
            closureId: input.closureId ?? `closure:${input.run.id}`,
            exchangeSourceId,
          }),
        },
      }),
    );
  }

  return [exchange, ...events];
}
