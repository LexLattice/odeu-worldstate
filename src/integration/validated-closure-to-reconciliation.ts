import { z } from "zod";

import {
  deltaProposedEvent,
  fingerprint,
  sourceCapturedEvent,
  stableStringify,
  WorldstateDeltaSchema,
  type Actor,
  type EvidenceValidation,
  type LedgerEventOf,
  type SourceRecord,
  type WorldstateDelta,
  type WorldstateState,
} from "@/domain";
import {
  parseReplayEvidenceValidationExchangeSource,
  replayEvidenceValidationRecordedEvent,
} from "@/integration/replay-evidence-validation";
import {
  liveEvidenceValidationRecordedEvent,
  parseLiveEvidenceValidationExchangeSource,
} from "@/integration/live-evidence-validation";

export const RESULT_RECONCILIATION_MANAGER_ACTOR = {
  id: "actor-result-reconciliation-manager",
  kind: "manager",
  label: "Result reconciliation manager",
} as const satisfies Actor;

export const REGISTERED_FIXTURE_VERIFICATION_SCOPE =
  "registered_fixture_bundle" as const;
export const SEALED_LIVE_CANDIDATE_VERIFICATION_SCOPE =
  "sealed_live_candidate" as const;
export const RESULT_ARTIFACT_PROMOTION = "not_performed" as const;

const FIXTURE_SCOPE_LIMITATION =
  "The evidence validates the registered fixture bundle; it does not establish live execution or causal repository authorship.";
const LIVE_SCOPE_LIMITATION =
  "The evidence validates the exact sealed live candidate and establishes independent candidate execution; it does not establish causal model authorship or artifact promotion.";

export const ResultVerificationScopeSchema = z.enum([
  REGISTERED_FIXTURE_VERIFICATION_SCOPE,
  SEALED_LIVE_CANDIDATE_VERIFICATION_SCOPE,
]);
export type ResultVerificationScope = z.infer<
  typeof ResultVerificationScopeSchema
>;

export class ReconciliationCompilationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Reconciliation cannot be compiled: ${issues.join("; ")}`);
    this.name = "ReconciliationCompilationError";
  }
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function activeReconciliationForClosure(
  state: WorldstateState,
  closureId: string,
) {
  return Object.values(state.operational.deltas).find(
    (projection) =>
      projection.delta.purpose === "reconciliation" &&
      projection.delta.closureRef === closureId &&
      projection.disposition !== "rejected" &&
      projection.disposition !== "superseded",
  );
}

function assertExactReplayValidation(input: {
  readonly state: WorldstateState;
  readonly validation: EvidenceValidation;
  readonly deltaId: string;
}): ReturnType<typeof parseReplayEvidenceValidationExchangeSource> {
  const source = input.state.operational.sources[
    input.validation.evidenceSourceId
  ];
  const exchange = source
    ? parseReplayEvidenceValidationExchangeSource(source)
    : null;
  if (!exchange) {
    throw new ReconciliationCompilationError([
      `Validation ${input.validation.id} is not grounded in an intact replay-evidence verifier exchange.`,
    ]);
  }

  let expected: EvidenceValidation;
  try {
    expected = replayEvidenceValidationRecordedEvent({
      state: input.state,
      request: exchange.request,
      response: exchange.response,
      eventId: `event-reconciliation-validation-check:${input.deltaId}`,
      commandId: `command-reconciliation-validation-check:${input.deltaId}`,
      occurredAt: input.validation.observedAt,
      actor: input.validation.validator,
    }).payload.validation;
  } catch (error) {
    throw new ReconciliationCompilationError([
      error instanceof Error && error.message.trim()
        ? error.message
        : `Validation ${input.validation.id} cannot be reproduced from durable evidence.`,
    ]);
  }

  if (stableStringify(expected) !== stableStringify(input.validation)) {
    throw new ReconciliationCompilationError([
      `Validation ${input.validation.id} does not exactly reproduce from its durable verifier exchange.`,
    ]);
  }
  return exchange;
}

function assertExactLiveValidation(input: {
  readonly state: WorldstateState;
  readonly validation: EvidenceValidation;
  readonly deltaId: string;
}): ReturnType<typeof parseLiveEvidenceValidationExchangeSource> {
  const source = input.state.operational.sources[
    input.validation.evidenceSourceId
  ];
  const exchange = source
    ? parseLiveEvidenceValidationExchangeSource(source)
    : null;
  if (!exchange) {
    throw new ReconciliationCompilationError([
      `Validation ${input.validation.id} is not grounded in an intact live-candidate verifier exchange.`,
    ]);
  }

  let expected: EvidenceValidation;
  try {
    expected = liveEvidenceValidationRecordedEvent({
      state: input.state,
      request: exchange.request,
      response: exchange.response,
      eventId: `event-reconciliation-validation-check:${input.deltaId}`,
      commandId: `command-reconciliation-validation-check:${input.deltaId}`,
      occurredAt: input.validation.observedAt,
      actor: input.validation.validator,
    }).payload.validation;
  } catch (error) {
    throw new ReconciliationCompilationError([
      error instanceof Error && error.message.trim()
        ? error.message
        : `Validation ${input.validation.id} cannot be reproduced from durable live-candidate evidence.`,
    ]);
  }

  if (stableStringify(expected) !== stableStringify(input.validation)) {
    throw new ReconciliationCompilationError([
      `Validation ${input.validation.id} does not exactly reproduce from its durable live-candidate verifier exchange.`,
    ]);
  }
  return exchange;
}

type ExactValidationContext = {
  readonly codexExchangeSourceId: string;
  readonly verificationScope: ResultVerificationScope;
  readonly causalExecutionEstablished: boolean;
  readonly scopeLimitation: string;
};

function assertExactValidation(input: {
  readonly state: WorldstateState;
  readonly validation: EvidenceValidation;
  readonly deltaId: string;
  readonly mode: "live" | "replay";
}): ExactValidationContext {
  if (input.mode === "live") {
    const exchange = assertExactLiveValidation(input);
    if (!exchange) {
      throw new ReconciliationCompilationError([
        `Validation ${input.validation.id} has no live-candidate verifier exchange.`,
      ]);
    }
    return {
      codexExchangeSourceId: exchange.request.exchangeSourceId,
      verificationScope: SEALED_LIVE_CANDIDATE_VERIFICATION_SCOPE,
      causalExecutionEstablished: true,
      scopeLimitation: LIVE_SCOPE_LIMITATION,
    };
  }

  const exchange = assertExactReplayValidation(input);
  if (!exchange) {
    throw new ReconciliationCompilationError([
      `Validation ${input.validation.id} has no replay verifier exchange.`,
    ]);
  }
  return {
    codexExchangeSourceId: exchange.request.exchangeSourceId,
    verificationScope: REGISTERED_FIXTURE_VERIFICATION_SCOPE,
    causalExecutionEstablished: false,
    scopeLimitation: FIXTURE_SCOPE_LIMITATION,
  };
}

export interface CompileValidatedClosureReconciliationInput {
  readonly closureId: string;
  readonly validationId: string;
  readonly deltaId: string;
}

export function resultReconciliationDeltaId(input: {
  readonly closureId: string;
  readonly validationId: string;
  readonly baseRevisionId: string;
}): string {
  return `delta-result-reconciliation:${fingerprint(input).slice(-16)}`;
}

export function resultReconciliationSourceId(deltaId: string): string {
  return `source-result-reconciliation:${deltaId}`;
}

/**
 * Deterministically compiles a reviewable reconciliation candidate from a
 * returned closure and its exact independent validation. The result is
 * operational only: callers must persist delta.proposed and stop before any
 * human-authored delta.accepted event is considered.
 */
export function compileValidatedClosureReconciliation(
  state: WorldstateState,
  input: CompileValidatedClosureReconciliationInput,
): WorldstateDelta {
  const issues: string[] = [];
  const closure = state.operational.closures[input.closureId];
  const validation = state.operational.validations[input.validationId];

  if (!closure) issues.push(`Closure ${input.closureId} is missing.`);
  if (!validation) issues.push(`Validation ${input.validationId} is missing.`);
  if (issues.length > 0 || !closure || !validation) {
    throw new ReconciliationCompilationError(issues);
  }

  const brief = state.operational.briefs[closure.briefId];
  const runProjection = state.operational.runs[closure.runId];
  const target = brief
    ? state.canonical.nodes[brief.targetNodeId]
    : undefined;
  if (!brief) issues.push(`Brief ${closure.briefId} is missing.`);
  if (!runProjection) issues.push(`Run ${closure.runId} is missing.`);
  if (!target || target.retiredRevisionId) {
    issues.push(
      `The active target from brief ${closure.briefId} is missing or retired.`,
    );
  } else if (target.kind !== "Task") {
    issues.push(`Reconciliation target ${target.id} is not a Task.`);
  }

  if (closure.outcome !== "returned") {
    issues.push(`Closure ${closure.id} did not return successfully.`);
  }
  if (!closure.claimedCompletion) {
    issues.push(`Closure ${closure.id} does not claim completion.`);
  }
  if (runProjection?.status !== "returned") {
    issues.push(`Run ${closure.runId} is not in the returned state.`);
  }
  if (
    runProjection &&
    (closure.mode !== runProjection.run.mode ||
      brief?.executionMode !== runProjection.run.mode)
  ) {
    issues.push("The closure, run, and brief execution modes do not match.");
  }
  if (
    closure.baseRevisionId !== state.canonical.head.id ||
    brief?.baseRevisionId !== state.canonical.head.id ||
    runProjection?.run.baseRevisionId !== state.canonical.head.id ||
    validation.baseRevisionId !== state.canonical.head.id
  ) {
    issues.push(
      "The closure, brief, run, validation, and canonical head must share one current worldstate revision.",
    );
  }
  if (
    !brief ||
    closure.briefId !== brief.id ||
    closure.briefId !== validation.briefId ||
    closure.runId !== runProjection?.run.id ||
    runProjection.run.briefId !== brief.id
  ) {
    issues.push("The closure, run, brief, and validation lineage is incoherent.");
  }
  if (
    !brief ||
    closure.artifactBaseRef !== brief.artifactBaseRef ||
    closure.artifactBaseRef !== runProjection?.run.artifactBaseRef
  ) {
    issues.push("The closure, run, and brief artifact bases do not match.");
  }
  if (validation.closureId !== closure.id) {
    issues.push(`Validation ${validation.id} belongs to another closure.`);
  }
  const deterministicDeltaId = resultReconciliationDeltaId({
    closureId: closure.id,
    validationId: validation.id,
    baseRevisionId: validation.baseRevisionId,
  });
  if (input.deltaId !== deterministicDeltaId) {
    issues.push(
      `Reconciliation delta ID must be the deterministic binding ID ${deterministicDeltaId}.`,
    );
  }
  if (brief) {
    const observations = new Map(
      validation.observations.map((observation) => [
        observation.requirementId,
        observation,
      ]),
    );
    for (const requirement of brief.evidenceContract.requirements.filter(
      (candidate) => candidate.required,
    )) {
      const observation = observations.get(requirement.id);
      if (
        !observation ||
        observation.result !== "passed" ||
        observation.freshness !== "current" ||
        !observation.evidenceRefs.includes(validation.evidenceSourceId)
      ) {
        issues.push(
          `Required evidence ${requirement.id} has not passed with current, validation-bound evidence.`,
        );
      }
    }
  }

  const existingById = state.operational.deltas[input.deltaId];
  if (
    existingById &&
    (existingById.delta.purpose !== "reconciliation" ||
      existingById.delta.closureRef !== closure.id)
  ) {
    issues.push(`Delta ID ${input.deltaId} is already bound to another proposal.`);
  }
  const existingForClosure = activeReconciliationForClosure(state, closure.id);
  if (existingForClosure && existingForClosure.delta.id !== input.deltaId) {
    issues.push(
      `Closure ${closure.id} already has reconciliation ${existingForClosure.delta.id}.`,
    );
  }

  if (issues.length > 0 || !brief || !runProjection || !target) {
    throw new ReconciliationCompilationError(issues);
  }

  const exactValidation = assertExactValidation({
    state,
    validation,
    deltaId: input.deltaId,
    mode: runProjection.run.mode,
  });

  const durableEvidenceSourceRefs = unique([
    validation.evidenceSourceId,
    exactValidation.codexExchangeSourceId,
    ...closure.evidenceRefs.filter(
      (reference) => state.operational.sources[reference],
    ),
  ]);
  const reconciliationSourceId = resultReconciliationSourceId(input.deltaId);
  const targetSourceRefs = unique([
    ...target.sourceRefs,
    reconciliationSourceId,
    ...durableEvidenceSourceRefs,
  ]);
  const evidenceNodeId = `evidence:${input.deltaId}`;
  const evidenceRelationId = `relation:${input.deltaId}`;
  const unresolved = unique([
    ...closure.unresolved,
    exactValidation.scopeLimitation,
  ]);
  const live = exactValidation.verificationScope ===
    SEALED_LIVE_CANDIDATE_VERIFICATION_SCOPE;

  return WorldstateDeltaSchema.parse({
    id: input.deltaId,
    baseRevisionId: state.canonical.head.id,
    scopeId: state.canonical.projectId,
    purpose: "reconciliation",
    proposedBy: RESULT_RECONCILIATION_MANAGER_ACTOR,
    operations: [
      {
        op: "node.patch",
        nodeId: target.id,
        patch: {
          knowledge: { standing: "supported", freshness: "current" },
          work: { phase: "completed", verification: "verified" },
          sourceRefs: targetSourceRefs,
          data: {
            resultClosureId: closure.id,
            resultRunId: runProjection.run.id,
            resultBriefId: brief.id,
            resultValidationId: validation.id,
            resultArtifactRefs: closure.artifactRefs,
            validationEvidenceSourceId: validation.evidenceSourceId,
            verificationScope: exactValidation.verificationScope,
            causalExecutionEstablished:
              exactValidation.causalExecutionEstablished,
            causalAuthorshipEstablished: false,
            artifactPromotion: RESULT_ARTIFACT_PROMOTION,
          },
        },
      },
      {
        op: "node.add",
        node: {
          id: evidenceNodeId,
          scopeId: state.canonical.projectId,
          kind: "Evidence",
          title: live
            ? `Independent live-candidate evidence for ${target.title}`
            : `Independent replay evidence for ${target.title}`,
          description: live
            ? "Independent validation executed the registered checks against the exact sealed candidate from the authorized live run. It does not establish causal model authorship or promote the candidate."
            : "Independent replay verified the registered fixture bundle against the delegated brief. It does not establish live Codex execution or causal repository authorship.",
          visibility: "shared",
          knowledge: { standing: "supported", freshness: "current" },
          governance: { standing: "adopted", approval: "not_required" },
          sourceRefs: durableEvidenceSourceRefs,
          data: {
            closureId: closure.id,
            runId: runProjection.run.id,
            briefId: brief.id,
            validationId: validation.id,
            artifactRefs: closure.artifactRefs,
            verificationScope: exactValidation.verificationScope,
            causalExecutionEstablished:
              exactValidation.causalExecutionEstablished,
            causalAuthorshipEstablished: false,
            artifactPromotion: RESULT_ARTIFACT_PROMOTION,
          },
        },
      },
      {
        op: "relation.add",
        relation: {
          id: evidenceRelationId,
          scopeId: state.canonical.projectId,
          kind: "evidenced_by",
          fromNodeId: target.id,
          toNodeId: evidenceNodeId,
          label: live
            ? "verified against sealed live candidate"
            : "verified by registered replay evidence",
          sourceRefs: durableEvidenceSourceRefs,
          data: {
            closureId: closure.id,
            validationId: validation.id,
            verificationScope: exactValidation.verificationScope,
            causalExecutionEstablished:
              exactValidation.causalExecutionEstablished,
          },
        },
      },
    ],
    rationale: [
      "The returned closure claims completion for the exact brief and current worldstate revision.",
      live
        ? "Independent live-candidate validation passed every required evidence check against the exact sealed candidate."
        : "Independent replay validation passed every required evidence check against the registered fixture bundle.",
      "Human acceptance is still required before canonical worldstate changes.",
    ],
    sourceRefs: [reconciliationSourceId, ...durableEvidenceSourceRefs],
    uncertainty: unresolved,
    alternatives: [
      "Leave the returned result staged without changing canonical worldstate.",
      live
        ? "Leave the sealed candidate unpromoted or remand it if causal authorship evidence is required."
        : "Remand the result if live execution or causal authorship evidence is required.",
    ],
    conflicts: [],
    visibleConsequence: live
      ? "The task becomes completed and verified with evidence from the exact sealed live candidate; causal authorship and artifact promotion remain unclaimed."
      : "The task becomes completed and verified with linked registered-fixture evidence; no live or causal authorship claim is added.",
    closureRef: closure.id,
    validationRef: validation.id,
  });
}

export const ResultReconciliationArtifactSchema = z
  .object({
    kind: z.literal("odeu.result-reconciliation"),
    version: z.literal(1),
    bindings: z
      .object({
        deltaId: z.string().trim().min(1),
        closureId: z.string().trim().min(1),
        validationId: z.string().trim().min(1),
        runId: z.string().trim().min(1),
        briefId: z.string().trim().min(1),
        targetNodeId: z.string().trim().min(1),
        baseRevisionId: z.string().trim().min(1),
        artifactBaseRef: z.string().trim().min(1),
        codexExchangeSourceId: z.string().trim().min(1),
        validationExchangeSourceId: z.string().trim().min(1),
      })
      .strict(),
    verificationScope: ResultVerificationScopeSchema,
    causalExecutionEstablished: z.boolean().default(false),
    causalAuthorshipEstablished: z.literal(false),
    artifactPromotion: z.literal(RESULT_ARTIFACT_PROMOTION),
    delta: WorldstateDeltaSchema,
  })
  .strict();

export type ResultReconciliationArtifact = z.infer<
  typeof ResultReconciliationArtifactSchema
>;

export function compileResultReconciliationArtifact(
  state: WorldstateState,
  input: CompileValidatedClosureReconciliationInput,
): ResultReconciliationArtifact {
  const delta = compileValidatedClosureReconciliation(state, input);
  const closure = state.operational.closures[input.closureId];
  const brief = closure
    ? state.operational.briefs[closure.briefId]
    : undefined;
  const validation = state.operational.validations[input.validationId];
  const validationSource = validation
    ? state.operational.sources[validation.evidenceSourceId]
    : undefined;
  const runProjection = closure
    ? state.operational.runs[closure.runId]
    : undefined;
  const validationExchange = validationSource && runProjection
    ? runProjection.run.mode === "live"
      ? parseLiveEvidenceValidationExchangeSource(validationSource)
      : parseReplayEvidenceValidationExchangeSource(validationSource)
    : null;
  if (!closure || !brief || !validation || !validationExchange) {
    throw new ReconciliationCompilationError([
      "The reconciliation artifact cannot bind its exact closure lineage.",
    ]);
  }
  const verificationScope =
    runProjection?.run.mode === "live"
      ? SEALED_LIVE_CANDIDATE_VERIFICATION_SCOPE
      : REGISTERED_FIXTURE_VERIFICATION_SCOPE;
  return ResultReconciliationArtifactSchema.parse({
    kind: "odeu.result-reconciliation",
    version: 1,
    bindings: {
      deltaId: delta.id,
      closureId: closure.id,
      validationId: validation.id,
      runId: closure.runId,
      briefId: brief.id,
      targetNodeId: brief.targetNodeId,
      baseRevisionId: delta.baseRevisionId,
      artifactBaseRef: closure.artifactBaseRef,
      codexExchangeSourceId: validationExchange.request.exchangeSourceId,
      validationExchangeSourceId: validation.evidenceSourceId,
    },
    verificationScope,
    causalExecutionEstablished:
      verificationScope === SEALED_LIVE_CANDIDATE_VERIFICATION_SCOPE,
    causalAuthorshipEstablished: false,
    artifactPromotion: RESULT_ARTIFACT_PROMOTION,
    delta,
  });
}

export function parseResultReconciliationArtifactSource(
  source: SourceRecord,
): ResultReconciliationArtifact | null {
  let artifact: ResultReconciliationArtifact;
  try {
    artifact = ResultReconciliationArtifactSchema.parse(
      JSON.parse(source.content),
    );
  } catch {
    return null;
  }
  if (
    source.kind !== "system" ||
    source.visibility !== "shared" ||
    source.id !== resultReconciliationSourceId(artifact.delta.id) ||
    source.integrity?.algorithm !== "fnv1a64" ||
    source.integrity.digest !== fingerprint(artifact)
  ) {
    return null;
  }
  return artifact;
}

export type ResultReconciliationProposalEventBatch = readonly [
  LedgerEventOf<"source.captured">,
  LedgerEventOf<"delta.proposed">,
];

export function resultReconciliationProposalEvents(input: {
  readonly state: WorldstateState;
  readonly closureId: string;
  readonly validationId: string;
  readonly deltaId: string;
  readonly occurredAt: string;
  readonly systemActor: Actor;
}): ResultReconciliationProposalEventBatch {
  if (input.systemActor.kind !== "system") {
    throw new ReconciliationCompilationError([
      "The reconciliation receipt requires the trusted system boundary.",
    ]);
  }
  const artifact = compileResultReconciliationArtifact(input.state, input);
  const sourceId = resultReconciliationSourceId(artifact.delta.id);
  return [
    sourceCapturedEvent({
      eventId: `event-result-reconciliation-source:${artifact.delta.id}`,
      commandId: `command-result-reconciliation-source:${artifact.delta.id}`,
      occurredAt: input.occurredAt,
      actor: input.systemActor,
      payload: {
        source: {
          id: sourceId,
          kind: "system",
          content: stableStringify(artifact),
          visibility: "shared",
          integrity: {
            algorithm: "fnv1a64",
            digest: fingerprint(artifact),
          },
        },
      },
    }),
    deltaProposedEvent({
      eventId: `event-result-reconciliation-proposed:${artifact.delta.id}`,
      commandId: `command-result-reconciliation-proposed:${artifact.delta.id}`,
      occurredAt: input.occurredAt,
      actor: RESULT_RECONCILIATION_MANAGER_ACTOR,
      payload: { delta: artifact.delta },
    }),
  ];
}

/**
 * Refuses manager-substituted operations by recompiling from current durable
 * closure/validation evidence and comparing the entire candidate byte-for-byte
 * under the kernel's stable serialization.
 */
export function assertReconciliationDeltaMatchesCurrentState(
  state: WorldstateState,
  deltaId: string,
): void {
  const projection = state.operational.deltas[deltaId];
  if (
    !projection ||
    projection.delta.purpose !== "reconciliation" ||
    !projection.delta.closureRef
  ) {
    throw new ReconciliationCompilationError([
      `Reconciliation delta ${deltaId} is not available.`,
    ]);
  }
  const validationId = projection.delta.validationRef;
  if (!validationId) {
    throw new ReconciliationCompilationError([
      `Closure ${projection.delta.closureRef} has no validation.`,
    ]);
  }
  const receiptSource = state.operational.sources[
    resultReconciliationSourceId(deltaId)
  ];
  const receipt = receiptSource
    ? parseResultReconciliationArtifactSource(receiptSource)
    : null;
  if (
    !receipt ||
    receipt.bindings.deltaId !== deltaId ||
    receipt.bindings.closureId !== projection.delta.closureRef ||
    receipt.bindings.validationId !== validationId ||
    stableStringify(receipt.delta) !== stableStringify(projection.delta)
  ) {
    throw new ReconciliationCompilationError([
      `Reconciliation delta ${deltaId} is not backed by its exact integrity-bound proposal receipt.`,
    ]);
  }
  let compilationState = state;
  if (state.canonical.head.id !== projection.delta.baseRevisionId) {
    const acceptedRevision = projection.acceptedRevisionId
      ? state.canonical.revisions[projection.acceptedRevisionId]
      : undefined;
    const baseRevision =
      state.canonical.revisions[projection.delta.baseRevisionId];
    const closure = state.operational.closures[projection.delta.closureRef];
    const brief = closure
      ? state.operational.briefs[closure.briefId]
      : undefined;
    const baseTarget = brief?.sharedNodes.find(
      (node) => node.id === brief.targetNodeId,
    );
    if (
      projection.disposition !== "accepted" ||
      !acceptedRevision ||
      acceptedRevision.deltaId !== projection.delta.id ||
      acceptedRevision.parentRevisionId !== projection.delta.baseRevisionId ||
      !baseRevision ||
      !baseTarget
    ) {
      throw new ReconciliationCompilationError([
        `Reconciliation delta ${deltaId} cannot reconstruct its accepted base revision.`,
      ]);
    }
    compilationState = {
      ...state,
      canonical: {
        ...state.canonical,
        head: baseRevision,
        nodes: {
          ...state.canonical.nodes,
          [baseTarget.id]: baseTarget,
        },
      },
    };
  }
  const expectedReceipt = compileResultReconciliationArtifact(compilationState, {
    closureId: projection.delta.closureRef,
    validationId,
    deltaId,
  });
  if (
    stableStringify(expectedReceipt) !== stableStringify(receipt) ||
    stableStringify(expectedReceipt.delta) !== stableStringify(projection.delta)
  ) {
    throw new ReconciliationCompilationError([
      `Reconciliation delta ${deltaId} does not exactly match the deterministic candidate compiled from current evidence.`,
    ]);
  }
}
