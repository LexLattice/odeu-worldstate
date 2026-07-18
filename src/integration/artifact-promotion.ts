import { z } from "zod";

import { artifactPromotionId } from "@/adapters/artifact-promotion/identity";
import {
  ArtifactCandidateReceiptSchema,
  ArtifactPromotionReceiptSchema,
  type ArtifactCandidateReceipt,
  type ArtifactPromotionReceipt,
} from "@/adapters/artifact-promotion/schema";
import type { LiveEvidenceRequest } from "@/adapters/live-evidence";
import {
  ArtifactPromotionProposalSchema,
  artifactPromotionAuthorizedEvent,
  artifactPromotionOutcomeRecordedEvent,
  artifactPromotionProposedEvent,
  fingerprint,
  sourceCapturedEvent,
  stableStringify,
  type Actor,
  type ArtifactPromotionProposal,
  type EvidenceValidation,
  type LedgerEventOf,
  type SourceRecord,
  type WorldstateState,
} from "@/domain";
import { parseCodexRunExchangeSource } from "@/integration/codex-run-evidence";
import {
  liveEvidenceValidationRecordedEvent,
  parseLiveEvidenceValidationExchangeSource,
} from "@/integration/live-evidence-validation";
import {
  assertReconciliationDeltaMatchesCurrentState,
  parseResultReconciliationArtifactSource,
  resultReconciliationSourceId,
} from "@/integration/validated-closure-to-reconciliation";

export const ARTIFACT_PROMOTION_MANAGER_ACTOR = {
  id: "actor-artifact-promotion-manager",
  kind: "manager",
  label: "Artifact promotion manager",
} as const satisfies Actor;

export class ArtifactPromotionCompilationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Artifact promotion cannot proceed: ${issues.join("; ")}`);
    this.name = "ArtifactPromotionCompilationError";
  }
}

export const ArtifactPromotionProposalArtifactSchema = z
  .object({
    kind: z.literal("odeu.artifact-promotion-proposal"),
    version: z.literal(1),
    proposal: ArtifactPromotionProposalSchema,
  })
  .strict();

export const ArtifactPromotionRequestArtifactSchema = z
  .object({
    kind: z.literal("odeu.artifact-promotion-request"),
    version: z.literal(1),
    promotionId: z.string().trim().min(1).max(240),
    integratedRevisionId: z.string().trim().min(1).max(240),
    candidateId: z.string().regex(/^artifact-candidate:sha256:[0-9a-f]{64}$/),
    repositoryId: z.string().trim().min(1).max(240),
    targetRef: z.string().trim().min(1).max(1_024),
    expectedBaseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    candidateCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  })
  .strict();

export const ArtifactPromotionResponseArtifactSchema = z
  .object({
    kind: z.literal("odeu.artifact-promotion-response"),
    version: z.literal(1),
    receipt: ArtifactPromotionReceiptSchema,
  })
  .strict();

const PublicPromotionFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum([
          "invalid_request",
          "promotion_not_authorized",
          "promotion_unavailable",
          "promotion_failed",
        ]),
        message: z.string().trim().min(1).max(1_000),
      })
      .strict(),
  })
  .strict();

export const ArtifactPromotionCommandResponseSchema = z.discriminatedUnion("ok", [
  z.discriminatedUnion("status", [
    z
      .object({
        ok: z.literal(true),
        status: z.literal("completed"),
        promotionId: z
          .string()
          .regex(/^artifact-promotion:sha256:[0-9a-f]{64}$/),
        receipt: ArtifactPromotionReceiptSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(true),
        status: z.literal("outcome_unknown"),
        promotionId: z
          .string()
          .regex(/^artifact-promotion:sha256:[0-9a-f]{64}$/),
        receipt: z.null(),
      })
      .strict(),
  ]),
  PublicPromotionFailureSchema,
]);

export const ArtifactPromotionStatusResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      status: z.enum([
        "absent",
        "authorized_only",
        "attempt_only",
        "completed",
      ]),
      promotionId: z.string().regex(/^artifact-promotion:sha256:[0-9a-f]{64}$/),
      receipt: ArtifactPromotionReceiptSchema.nullable(),
    })
    .strict()
    .superRefine((status, context) => {
      if ((status.status === "completed") !== (status.receipt !== null)) {
        context.addIssue({
          code: "custom",
          path: ["receipt"],
          message: "only a completed promotion status may expose a receipt",
        });
      }
    }),
  PublicPromotionFailureSchema,
]);

export type ArtifactPromotionProposalArtifact = z.infer<
  typeof ArtifactPromotionProposalArtifactSchema
>;
export type ArtifactPromotionRequestArtifact = z.infer<
  typeof ArtifactPromotionRequestArtifactSchema
>;
export type ArtifactPromotionResponseArtifact = z.infer<
  typeof ArtifactPromotionResponseArtifactSchema
>;
export type ArtifactPromotionCommandResponse = z.infer<
  typeof ArtifactPromotionCommandResponseSchema
>;
export type ArtifactPromotionStatusResponse = z.infer<
  typeof ArtifactPromotionStatusResponseSchema
>;

export function artifactPromotionProposalSourceId(promotionId: string): string {
  return `source-artifact-promotion-proposal:${promotionId}`;
}

export function artifactPromotionRequestSourceId(promotionId: string): string {
  return `source-artifact-promotion-request:${promotionId}`;
}

export function artifactPromotionResponseSourceId(promotionId: string): string {
  return `source-artifact-promotion-response:${promotionId}`;
}

function parseIntegrityBoundArtifact<T>(input: {
  readonly source: SourceRecord;
  readonly schema: z.ZodType<T>;
  readonly expectedSourceId: (artifact: T) => string;
}): T | null {
  let artifact: T;
  try {
    artifact = input.schema.parse(JSON.parse(input.source.content));
  } catch {
    return null;
  }
  if (
    input.source.kind !== "system" ||
    input.source.visibility !== "shared" ||
    input.source.id !== input.expectedSourceId(artifact) ||
    input.source.content !== stableStringify(artifact) ||
    input.source.integrity?.algorithm !== "fnv1a64" ||
    input.source.integrity.digest !== fingerprint(artifact)
  ) {
    return null;
  }
  return artifact;
}

export function parseArtifactPromotionProposalSource(
  source: SourceRecord,
): ArtifactPromotionProposalArtifact | null {
  return parseIntegrityBoundArtifact({
    source,
    schema: ArtifactPromotionProposalArtifactSchema,
    expectedSourceId: (artifact) =>
      artifactPromotionProposalSourceId(artifact.proposal.id),
  });
}

export function parseArtifactPromotionRequestSource(
  source: SourceRecord,
): ArtifactPromotionRequestArtifact | null {
  return parseIntegrityBoundArtifact({
    source,
    schema: ArtifactPromotionRequestArtifactSchema,
    expectedSourceId: (artifact) =>
      artifactPromotionRequestSourceId(artifact.promotionId),
  });
}

export function parseArtifactPromotionResponseSource(
  source: SourceRecord,
): ArtifactPromotionResponseArtifact | null {
  return parseIntegrityBoundArtifact({
    source,
    schema: ArtifactPromotionResponseArtifactSchema,
    expectedSourceId: (artifact) =>
      artifactPromotionResponseSourceId(artifact.receipt.promotionId),
  });
}

function exactValidation(input: {
  readonly state: WorldstateState;
  readonly validation: EvidenceValidation;
  readonly reconciliationDeltaId: string;
}) {
  const source = input.state.operational.sources[
    input.validation.evidenceSourceId
  ];
  const exchange = source
    ? parseLiveEvidenceValidationExchangeSource(source)
    : null;
  if (!exchange || !exchange.response.ok || exchange.response.status !== "passed") {
    throw new ArtifactPromotionCompilationError([
      "The accepted reconciliation is not grounded in a passed, intact independent live-candidate exchange.",
    ]);
  }
  let reproduced: EvidenceValidation;
  try {
    const validationBase = input.state.canonical.revisions[
      exchange.request.baseRevisionId
    ];
    if (!validationBase) {
      throw new Error(
        "The independent validation base revision is no longer reconstructable.",
      );
    }
    const validationState: WorldstateState = {
      ...input.state,
      canonical: { ...input.state.canonical, head: validationBase },
    };
    reproduced = liveEvidenceValidationRecordedEvent({
      state: validationState,
      request: exchange.request,
      response: exchange.response,
      eventId: `event-artifact-promotion-validation-check:${input.reconciliationDeltaId}`,
      commandId: `command-artifact-promotion-validation-check:${input.reconciliationDeltaId}`,
      occurredAt: input.validation.observedAt,
      actor: input.validation.validator,
    }).payload.validation;
  } catch (error) {
    throw new ArtifactPromotionCompilationError([
      error instanceof Error
        ? error.message
        : "The independent candidate validation could not be reproduced.",
    ]);
  }
  if (stableStringify(reproduced) !== stableStringify(input.validation)) {
    throw new ArtifactPromotionCompilationError([
      "The recorded independent validation does not exactly reproduce from its durable exchange.",
    ]);
  }
  const requiredResults = new Map(
    exchange.response.observations.map((observation) => [
      observation.requirementId,
      observation.result,
    ]),
  );
  if (
    exchange.request.evidenceRequirements.some(
      (requirement) =>
        requirement.required && requiredResults.get(requirement.requirementId) !== "passed",
    )
  ) {
    throw new ArtifactPromotionCompilationError([
      "The independent candidate exchange does not pass every required evidence item.",
    ]);
  }
  return exchange;
}

function exactCandidateReceipt(input: {
  readonly state: WorldstateState;
  readonly proposal?: ArtifactPromotionProposal;
  readonly reconciliationDeltaId: string;
}): {
  readonly candidate: ArtifactCandidateReceipt;
  readonly candidateEvidenceSourceId: string;
  readonly validationRequest: LiveEvidenceRequest;
  readonly validationId: string;
  readonly closureId: string;
} {
  const projection = input.state.operational.deltas[input.reconciliationDeltaId];
  const validationId = projection?.delta.validationRef;
  const closureId = projection?.delta.closureRef;
  if (
    !projection ||
    projection.disposition !== "accepted" ||
    projection.delta.purpose !== "reconciliation" ||
    !projection.acceptedRevisionId ||
    !validationId ||
    !closureId ||
    input.state.provenance.deltaToRevisionId[input.reconciliationDeltaId] !==
      projection.acceptedRevisionId ||
    input.state.canonical.head.id !== projection.acceptedRevisionId
  ) {
    throw new ArtifactPromotionCompilationError([
      "Artifact promotion requires the current, accepted reconciliation at the semantic head.",
    ]);
  }
  try {
    assertReconciliationDeltaMatchesCurrentState(
      input.state,
      input.reconciliationDeltaId,
    );
  } catch (error) {
    throw new ArtifactPromotionCompilationError([
      error instanceof Error
        ? error.message
        : "The accepted reconciliation does not reproduce from current evidence.",
    ]);
  }
  const reconciliationSource = input.state.operational.sources[
    resultReconciliationSourceId(input.reconciliationDeltaId)
  ];
  const reconciliationArtifact = reconciliationSource
    ? parseResultReconciliationArtifactSource(reconciliationSource)
    : null;
  if (
    !reconciliationArtifact ||
    reconciliationArtifact.verificationScope !== "sealed_live_candidate" ||
    reconciliationArtifact.causalExecutionEstablished !== true ||
    reconciliationArtifact.causalAuthorshipEstablished !== false ||
    reconciliationArtifact.artifactPromotion !== "not_performed"
  ) {
    throw new ArtifactPromotionCompilationError([
      "The accepted reconciliation is not the exact sealed-live-candidate review boundary.",
    ]);
  }
  const validation = input.state.operational.validations[validationId];
  if (!validation || validation.closureId !== closureId) {
    throw new ArtifactPromotionCompilationError([
      "The accepted reconciliation has no exact independent validation lineage.",
    ]);
  }
  const validationExchange = exactValidation({
    state: input.state,
    validation,
    reconciliationDeltaId: input.reconciliationDeltaId,
  });
  const candidateSourceId = validationExchange.request.exchangeSourceId;
  const candidateSource = input.state.operational.sources[candidateSourceId];
  const codexExchange = candidateSource
    ? parseCodexRunExchangeSource(candidateSource)
    : null;
  if (
    !codexExchange ||
    !codexExchange.response.ok ||
    !codexExchange.response.closure.artifactCandidate
  ) {
    throw new ArtifactPromotionCompilationError([
      "The independently validated staged candidate is not present in its exact intact Codex exchange.",
    ]);
  }
  const candidate = ArtifactCandidateReceiptSchema.parse(
    codexExchange.response.closure.artifactCandidate,
  );
  if (
    stableStringify(candidate) !==
      stableStringify(validationExchange.request.candidateReceipt) ||
    candidate.metadata.candidateId !== validationExchange.request.artifactCandidateId ||
    candidate.metadata.git.candidateCommit !==
      validationExchange.request.artifactCandidateCommit
  ) {
    throw new ArtifactPromotionCompilationError([
      "The signed candidate differs between the live worker and independent verifier exchanges.",
    ]);
  }
  if (
    input.proposal &&
    (input.proposal.candidateEvidenceSourceId !== candidateSourceId ||
      input.proposal.candidateId !== candidate.metadata.candidateId ||
      input.proposal.candidateCommit !== candidate.metadata.git.candidateCommit)
  ) {
    throw new ArtifactPromotionCompilationError([
      "The proposal does not bind the exact independently validated candidate source.",
    ]);
  }
  return {
    candidate,
    candidateEvidenceSourceId: candidateSourceId,
    validationRequest: validationExchange.request,
    validationId,
    closureId,
  };
}

export function compileArtifactPromotionProposal(
  state: WorldstateState,
  input: { readonly reconciliationDeltaId: string },
): ArtifactPromotionProposal {
  const exact = exactCandidateReceipt({
    state,
    reconciliationDeltaId: input.reconciliationDeltaId,
  });
  const candidate = exact.candidate.metadata;
  const closure = state.operational.closures[exact.closureId];
  const run = closure ? state.operational.runs[closure.runId] : undefined;
  const brief = closure ? state.operational.briefs[closure.briefId] : undefined;
  const reconciliation = state.operational.deltas[input.reconciliationDeltaId];
  const artifactBaseCommit = closure?.artifactBaseRef.match(
    /^git:([0-9a-f]{40}|[0-9a-f]{64})$/,
  )?.[1];
  const issues: string[] = [];
  if (!closure || closure.mode !== "live" || closure.outcome !== "returned") {
    issues.push("The reconciliation closure is not a returned live closure.");
  }
  if (!run || run.status !== "returned" || run.run.mode !== "live") {
    issues.push("The reconciliation run is not a returned live run.");
  }
  if (!brief || brief.executionMode !== "live") {
    issues.push("The reconciliation brief does not authorize live execution.");
  }
  if (!artifactBaseCommit || artifactBaseCommit !== candidate.git.baseCommit) {
    issues.push("The staged candidate base does not equal the authorized artifact base.");
  }
  if (
    closure &&
    (closure.artifactCandidateId !== candidate.candidateId ||
      closure.artifactCandidateCommit !== candidate.git.candidateCommit)
  ) {
    issues.push("The closure does not bind the exact signed staged candidate.");
  }
  if (
    run &&
    (candidate.runId !== run.run.id ||
      candidate.briefId !== run.run.briefId ||
      candidate.baseRevisionId !== run.run.baseRevisionId)
  ) {
    issues.push("The signed candidate does not bind the exact live run lineage.");
  }
  if (
    brief &&
    !brief.expectedArtifacts.some((path) =>
      candidate.manifest.entries.some(
        (entry) => entry.path === path && entry.status !== "deleted",
      ),
    )
  ) {
    issues.push("The candidate does not retain a changed artifact declared by the brief.");
  }
  if (issues.length > 0 || !closure || !run || !brief || !reconciliation || !artifactBaseCommit) {
    throw new ArtifactPromotionCompilationError(issues);
  }
  const id = artifactPromotionId({
    candidateId: candidate.candidateId,
    repositoryId: candidate.repositoryId,
    targetRef: candidate.targetRef,
    expectedBaseCommit: candidate.git.baseCommit,
    candidateCommit: candidate.git.candidateCommit,
  });
  return ArtifactPromotionProposalSchema.parse({
    id,
    runId: run.run.id,
    briefId: brief.id,
    closureId: closure.id,
    validationId: exact.validationId,
    reconciliationDeltaId: input.reconciliationDeltaId,
    integratedRevisionId: reconciliation.acceptedRevisionId,
    artifactBaseRef: closure.artifactBaseRef,
    repositoryId: candidate.repositoryId,
    targetRef: candidate.targetRef,
    expectedBaseCommit: candidate.git.baseCommit,
    candidateId: candidate.candidateId,
    candidateCommit: candidate.git.candidateCommit,
    candidateTree: candidate.git.candidateTree,
    manifestDigest: candidate.manifest.digest,
    patchDigest: candidate.patch.digest,
    changedPaths: candidate.manifest.entries.map(({ path, status }) => ({
      path,
      status,
    })),
    candidateEvidenceSourceId: exact.candidateEvidenceSourceId,
    proposalSourceId: artifactPromotionProposalSourceId(id),
  });
}

export type ArtifactPromotionProposalEventBatch = readonly [
  LedgerEventOf<"source.captured">,
  LedgerEventOf<"artifact.promotion_proposed">,
];

export function artifactPromotionProposalEvents(input: {
  readonly state: WorldstateState;
  readonly reconciliationDeltaId: string;
  readonly eventId: string;
  readonly commandId: string;
  readonly sourceEventId: string;
  readonly sourceCommandId: string;
  readonly occurredAt: string;
  readonly systemActor: Actor;
}): ArtifactPromotionProposalEventBatch {
  if (input.systemActor.kind !== "system") {
    throw new ArtifactPromotionCompilationError([
      "The proposal receipt requires the trusted system boundary.",
    ]);
  }
  const proposal = compileArtifactPromotionProposal(input.state, input);
  const artifact = ArtifactPromotionProposalArtifactSchema.parse({
    kind: "odeu.artifact-promotion-proposal",
    version: 1,
    proposal,
  });
  return [
    sourceCapturedEvent({
      eventId: input.sourceEventId,
      commandId: input.sourceCommandId,
      occurredAt: input.occurredAt,
      actor: input.systemActor,
      payload: {
        source: {
          id: proposal.proposalSourceId,
          kind: "system",
          content: stableStringify(artifact),
          visibility: "shared",
          integrity: { algorithm: "fnv1a64", digest: fingerprint(artifact) },
        },
      },
    }),
    artifactPromotionProposedEvent({
      eventId: input.eventId,
      commandId: input.commandId,
      occurredAt: input.occurredAt,
      actor: ARTIFACT_PROMOTION_MANAGER_ACTOR,
      payload: { proposal },
    }),
  ];
}

function requestArtifact(proposal: ArtifactPromotionProposal) {
  return ArtifactPromotionRequestArtifactSchema.parse({
    kind: "odeu.artifact-promotion-request",
    version: 1,
    promotionId: proposal.id,
    integratedRevisionId: proposal.integratedRevisionId,
    candidateId: proposal.candidateId,
    repositoryId: proposal.repositoryId,
    targetRef: proposal.targetRef,
    expectedBaseCommit: proposal.expectedBaseCommit,
    candidateCommit: proposal.candidateCommit,
  });
}

export function assertArtifactPromotionProposalMatchesCurrentState(
  state: WorldstateState,
  promotionId: string,
): ArtifactPromotionProposal {
  const projection = state.operational.artifactPromotions[promotionId];
  if (!projection) {
    throw new ArtifactPromotionCompilationError([
      `Artifact promotion ${promotionId} is not present.`,
    ]);
  }
  const source = state.operational.sources[projection.proposal.proposalSourceId];
  const artifact = source ? parseArtifactPromotionProposalSource(source) : null;
  const expected = compileArtifactPromotionProposal(state, {
    reconciliationDeltaId: projection.proposal.reconciliationDeltaId,
  });
  if (
    !artifact ||
    artifact.proposal.id !== promotionId ||
    stableStringify(artifact.proposal) !== stableStringify(projection.proposal) ||
    stableStringify(expected) !== stableStringify(projection.proposal)
  ) {
    throw new ArtifactPromotionCompilationError([
      `Artifact promotion ${promotionId} does not match its current deterministic proposal and receipt.`,
    ]);
  }
  return projection.proposal;
}

export type ArtifactPromotionAuthorizationEventBatch = readonly [
  LedgerEventOf<"source.captured">,
  LedgerEventOf<"artifact.promotion_authorized">,
];

export function artifactPromotionAuthorizationEvents(input: {
  readonly state: WorldstateState;
  readonly promotionId: string;
  readonly sourceEventId: string;
  readonly sourceCommandId: string;
  readonly authorizationEventId: string;
  readonly authorizationCommandId: string;
  readonly occurredAt: string;
  readonly systemActor: Actor;
  readonly humanActor: Actor;
}): ArtifactPromotionAuthorizationEventBatch {
  if (input.systemActor.kind !== "system" || input.humanActor.kind !== "human") {
    throw new ArtifactPromotionCompilationError([
      "Promotion requests require a system receipt followed by explicit human authority.",
    ]);
  }
  const projection = input.state.operational.artifactPromotions[input.promotionId];
  const proposal = assertArtifactPromotionProposalMatchesCurrentState(
    input.state,
    input.promotionId,
  );
  if (
    projection?.status !== "proposed" ||
    input.state.canonical.head.id !== proposal.integratedRevisionId
  ) {
    throw new ArtifactPromotionCompilationError([
      "Only a current proposed promotion may receive human authority.",
    ]);
  }
  const artifact = requestArtifact(proposal);
  const sourceId = artifactPromotionRequestSourceId(proposal.id);
  return [
    sourceCapturedEvent({
      eventId: input.sourceEventId,
      commandId: input.sourceCommandId,
      occurredAt: input.occurredAt,
      actor: input.systemActor,
      payload: {
        source: {
          id: sourceId,
          kind: "system",
          content: stableStringify(artifact),
          visibility: "shared",
          integrity: { algorithm: "fnv1a64", digest: fingerprint(artifact) },
        },
      },
    }),
    artifactPromotionAuthorizedEvent({
      eventId: input.authorizationEventId,
      commandId: input.authorizationCommandId,
      occurredAt: input.occurredAt,
      actor: input.humanActor,
      payload: {
        promotionId: proposal.id,
        integratedRevisionId: proposal.integratedRevisionId,
        requestSourceId: sourceId,
      },
    }),
  ];
}

export interface AuthorizedArtifactPromotion {
  readonly proposal: ArtifactPromotionProposal;
  readonly request: ArtifactPromotionRequestArtifact;
  readonly candidate: ArtifactCandidateReceipt;
  readonly validationRequest: LiveEvidenceRequest;
}

/** Revalidates every durable authority/evidence binding immediately before CAS. */
export function resolveAuthorizedArtifactPromotion(
  state: WorldstateState,
  promotionId: string,
): AuthorizedArtifactPromotion {
  const projection = state.operational.artifactPromotions[promotionId];
  if (
    !projection ||
    (projection.status !== "authorized" &&
      projection.status !== "outcome_unknown") ||
    !projection.requestSourceId
  ) {
    throw new ArtifactPromotionCompilationError([
      `Artifact promotion ${promotionId} has no durable human authorization.`,
    ]);
  }
  const proposal = assertArtifactPromotionProposalMatchesCurrentState(
    state,
    promotionId,
  );
  if (state.canonical.head.id !== proposal.integratedRevisionId) {
    throw new ArtifactPromotionCompilationError([
      "The authorized promotion is stale against the current semantic head.",
    ]);
  }
  const source = state.operational.sources[projection.requestSourceId];
  const request = source ? parseArtifactPromotionRequestSource(source) : null;
  const expectedRequest = requestArtifact(proposal);
  if (!request || stableStringify(request) !== stableStringify(expectedRequest)) {
    throw new ArtifactPromotionCompilationError([
      "The exact human-authorized promotion request is missing or has drifted.",
    ]);
  }
  const exact = exactCandidateReceipt({
    state,
    proposal,
    reconciliationDeltaId: proposal.reconciliationDeltaId,
  });
  const candidate = exact.candidate;
  const expectedId = artifactPromotionId({
    candidateId: candidate.metadata.candidateId,
    repositoryId: candidate.metadata.repositoryId,
    targetRef: candidate.metadata.targetRef,
    expectedBaseCommit: candidate.metadata.git.baseCommit,
    candidateCommit: candidate.metadata.git.candidateCommit,
  });
  if (expectedId !== promotionId) {
    throw new ArtifactPromotionCompilationError([
      "The authorized promotion ID does not match its exact signed candidate binding.",
    ]);
  }
  return {
    proposal,
    request,
    candidate,
    validationRequest: exact.validationRequest,
  };
}

export type ArtifactPromotionOutcomeEventBatch = readonly [
  LedgerEventOf<"source.captured">,
  LedgerEventOf<"artifact.promotion_outcome_recorded">,
];

export function artifactPromotionOutcomeEvents(input: {
  readonly state: WorldstateState;
  readonly promotionId: string;
  readonly receipt: ArtifactPromotionReceipt;
  readonly sourceEventId: string;
  readonly sourceCommandId: string;
  readonly outcomeEventId: string;
  readonly outcomeCommandId: string;
  readonly occurredAt: string;
  readonly systemActor: Actor;
}): ArtifactPromotionOutcomeEventBatch {
  if (input.systemActor.kind !== "system") {
    throw new ArtifactPromotionCompilationError([
      "Promotion outcomes require the trusted system observer.",
    ]);
  }
  const authorized = resolveAuthorizedArtifactPromotion(
    input.state,
    input.promotionId,
  );
  const receipt = ArtifactPromotionReceiptSchema.parse(input.receipt);
  if (
    receipt.promotionId !== authorized.proposal.id ||
    receipt.candidateId !== authorized.proposal.candidateId ||
    receipt.repositoryId !== authorized.proposal.repositoryId ||
    receipt.targetRef !== authorized.proposal.targetRef ||
    receipt.expectedBaseCommit !== authorized.proposal.expectedBaseCommit ||
    receipt.candidateCommit !== authorized.proposal.candidateCommit
  ) {
    throw new ArtifactPromotionCompilationError([
      "The signed server receipt does not match the exact human-authorized promotion.",
    ]);
  }
  const artifact = ArtifactPromotionResponseArtifactSchema.parse({
    kind: "odeu.artifact-promotion-response",
    version: 1,
    receipt,
  });
  const sourceId = artifactPromotionResponseSourceId(receipt.promotionId);
  return [
    sourceCapturedEvent({
      eventId: input.sourceEventId,
      commandId: input.sourceCommandId,
      occurredAt: input.occurredAt,
      actor: input.systemActor,
      payload: {
        source: {
          id: sourceId,
          kind: "system",
          content: stableStringify(artifact),
          visibility: "shared",
          integrity: { algorithm: "fnv1a64", digest: fingerprint(artifact) },
        },
      },
    }),
    artifactPromotionOutcomeRecordedEvent({
      eventId: input.outcomeEventId,
      commandId: input.outcomeCommandId,
      occurredAt: input.occurredAt,
      actor: input.systemActor,
      payload: {
        outcome: {
          promotionId: receipt.promotionId,
          outcome: receipt.outcome,
          repositoryId: receipt.repositoryId,
          targetRef: receipt.targetRef,
          expectedBaseCommit: receipt.expectedBaseCommit,
          candidateCommit: receipt.candidateCommit,
          observedTargetCommit: receipt.observedRefAfter,
          responseSourceId: sourceId,
        },
      },
    }),
  ];
}
