import { z } from "zod";

import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  type AgentRunRequest,
  type AgentRunResponse,
} from "@/adapters/codex/schema";
import { BrowserAgentGatewayError } from "@/adapters/codex/browser";
import type {
  BrowserAgentRuntimeCapabilityGetter,
  BrowserLiveAuthorizationGateway,
  BrowserLiveRunStatusGetter,
} from "@/adapters/codex/browser-live-authorization";
import {
  AgentRuntimeCapabilitySchema,
  type AgentRuntimeCapability,
} from "@/adapters/codex/live-authorization";
import {
  LiveEvidenceResponseSchema,
  type LiveEvidenceRequest,
  type LiveEvidenceResponse,
} from "@/adapters/live-evidence";
import {
  ReplayEvidenceResponseSchema,
  type ReplayEvidenceRequest,
  type ReplayEvidenceResponse,
} from "@/adapters/replay-evidence";
import type {
  BrowserArtifactPromotionGateway,
  BrowserArtifactPromotionStatusGetter,
} from "@/adapters/artifact-promotion/browser";
import { artifactIdentitySha256Hex } from "@/adapters/artifact-promotion/identity";
import type { ArtifactPromotionReceipt } from "@/adapters/artifact-promotion/schema";
import {
  LedgerConflictError,
  LedgerCorruptionError,
  ledgerVersion,
  parseWorldstateLedgerDocument,
  worldstateLedgerDocument,
  type LedgerVersion,
  type ProjectLedgerStore,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";
import {
  PlacementResponseSchema,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  appendLedgerEvent,
  briefCompiledEvent,
  buildDeltaAcceptedEvent,
  createLedgerEvent,
  deltaProposedEvent,
  evaluateIntegrationGate,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  runLifecycleEvent,
  sourceCapturedEvent,
  stableStringify,
  type AgentBrief,
  type AgentRun,
  type LedgerEvent,
  type WorldstateDelta,
  type WorldstateLedger,
  type WorldstateState,
} from "@/domain";
import {
  createHomeMoveSeedFixture,
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
} from "@/fixtures";
import {
  codexRunAttemptSourceEvent,
  codexRunAttemptSourceId,
  codexRunExchangeSourceEvent,
  codexRunExchangeSourceId,
  codexRunNormalizationFailureSourceEvent,
  codexRunNormalizationFailureSourceId,
  codexRunResponseEvents,
  parseCodexRunAttemptSource,
  parseCodexRunExchangeSource,
  parseCodexRunNormalizationFailureSource,
  type CodexRunAttempt,
  type CodexRunExchange,
  type CodexRunNormalizationFailure,
} from "@/integration/codex-run-evidence";
import {
  CodexTransportObservationSchema,
  codexTransportObservationSourceEvent,
  codexTransportObservationSourceId,
  parseCodexTransportObservationSource,
  type CodexTransportObservationInput,
} from "@/integration/codex-transport-evidence";
import { compileAcceptedPlacementAgentBrief } from "@/integration/accepted-placement-to-agent-brief";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";
import {
  assertPlacementResponseMatchesRequest,
  parsePlacementAttemptSource,
  parsePlacementExchangeSource,
  PlacementResponseCoherenceError,
  placementAttemptSourceEvent,
  placementExchangeSourceEvent,
  placementExchangeSourceId,
} from "@/integration/placement-evidence";
import { placementResponseToKernelDelta } from "@/integration/placement-to-kernel";
import { compilePlacementRequest } from "@/integration/worldstate-to-placement";
import {
  INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
  ReplayEvidenceValidationCoherenceError,
  compileReplayEvidenceRequest,
  parseReplayEvidenceValidationAttemptSource,
  parseReplayEvidenceValidationExchangeSource,
  replayEvidenceValidationAttemptSourceEvent,
  replayEvidenceValidationExchangeSourceEvent,
  replayEvidenceValidationRecordedEvent,
  type ReplayEvidenceValidationExchange,
} from "@/integration/replay-evidence-validation";
import {
  INDEPENDENT_LIVE_VALIDATOR_ACTOR,
  LiveEvidenceValidationCoherenceError,
  compileLiveEvidenceRequest,
  liveEvidenceValidationAttemptSourceEvent,
  liveEvidenceValidationExchangeSourceEvent,
  liveEvidenceValidationRecordedEvent,
  parseLiveEvidenceValidationAttemptSource,
  parseLiveEvidenceValidationExchangeSource,
  type LiveEvidenceValidationExchange,
} from "@/integration/live-evidence-validation";
import {
  ArtifactPromotionCompilationError,
  artifactPromotionAuthorizationEvents,
  artifactPromotionOutcomeEvents,
  artifactPromotionProposalEvents,
  parseArtifactPromotionResponseSource,
} from "@/integration/artifact-promotion";
import {
  ReconciliationCompilationError,
  assertReconciliationDeltaMatchesCurrentState,
  parseResultReconciliationArtifactSource,
  resultReconciliationDeltaId,
  resultReconciliationProposalEvents,
  resultReconciliationSourceId,
} from "@/integration/validated-closure-to-reconciliation";

import {
  createWorldstateLedgerTransactionService,
  worldstateLedgerFromDocument,
  type NonEmptyLedgerEvents,
  type WorldstateLedgerTransactionResult,
  type WorldstateLedgerTransactionService,
} from "./worldstate-ledger-transaction";

export type WorldstateSessionPersistenceState =
  "loading" | "saved" | "saving" | "conflict" | "corrupt" | "unavailable";

export type WorldstateSessionOperationState =
  | "idle"
  | "initializing"
  | "capturing"
  | "placing"
  | "persisting_placement"
  | "accepting"
  | "preparing_brief"
  | "authorizing_run"
  | "dispatching_run"
  | "persisting_run_result"
  | "validating_evidence"
  | "persisting_validation"
  | "proposing_reconciliation"
  | "integrating_result"
  | "proposing_promotion"
  | "authorizing_promotion"
  | "promoting_artifact"
  | "persisting_promotion_receipt"
  | "resetting";

export type WorldstateSessionIdKind =
  | "source"
  | "request"
  | "event"
  | "command"
  | "brief"
  | "run"
  | "closure"
  | "validation";

export type WorldstateSessionErrorScope =
  | "placement"
  | "delegation"
  | "validation"
  | "reconciliation"
  | "integration"
  | "artifact_promotion"
  | "semantic_commit"
  | "persistence"
  | "reset";

export interface WorldstateSessionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly scope: WorldstateSessionErrorScope;
}

export interface WorldstateSessionRetry {
  readonly operation: "placement";
  readonly sourceId: string;
  readonly selectedNodeId: string;
}

export interface WorldstateSessionSnapshot {
  readonly document: WorldstateLedgerDocument | null;
  readonly ledger: WorldstateLedger | null;
  readonly state: WorldstateState | null;
  readonly version: LedgerVersion | null;
  readonly persistenceState: WorldstateSessionPersistenceState;
  readonly persistenceDetail: string | null;
  readonly operationState: WorldstateSessionOperationState;
  readonly agentRuntimeCapability?: AgentRuntimeCapability | null;
  readonly activeSourceId: string | null;
  readonly activeRequestId: string | null;
  readonly activeDeltaId: string | null;
  readonly activeAgentRequestId: string | null;
  readonly activeBriefId: string | null;
  readonly activeRunId: string | null;
  readonly activeClosureId: string | null;
  readonly activeValidationRequestId: string | null;
  readonly activeValidationId: string | null;
  readonly activeReconciliationDeltaId: string | null;
  readonly activeIntegratedRevisionId: string | null;
  readonly activeArtifactPromotionId: string | null;
  /** Ephemeral fingerprints of exact host-attested receipts; never restored from browser claims. */
  readonly hostAttestedArtifactPromotionReceiptDigests?: Readonly<
    Record<string, string>
  >;
  readonly error: WorldstateSessionError | null;
  readonly retry: WorldstateSessionRetry | null;
}

export interface WorldstateSessionDependencies {
  readonly store: ProjectLedgerStore<LedgerEvent>;
  readonly placementGateway: (
    request: PlacementRequest,
  ) => Promise<PlacementResponse>;
  readonly agentGateway?: (
    request: AgentRunRequest,
  ) => Promise<AgentRunResponse>;
  readonly agentRuntimeCapabilityGetter?: BrowserAgentRuntimeCapabilityGetter;
  readonly liveAuthorizationGateway?: BrowserLiveAuthorizationGateway;
  readonly liveRunStatusGetter?: BrowserLiveRunStatusGetter;
  readonly liveEvidenceGateway?: (
    request: LiveEvidenceRequest,
  ) => Promise<LiveEvidenceResponse>;
  readonly replayEvidenceGateway?: (
    request: ReplayEvidenceRequest,
  ) => Promise<ReplayEvidenceResponse>;
  readonly artifactPromotionGateway?: BrowserArtifactPromotionGateway;
  readonly artifactPromotionStatusGetter?: BrowserArtifactPromotionStatusGetter;
  readonly now: () => string;
  readonly nextId: (kind: WorldstateSessionIdKind) => string;
}

export interface WorldstateSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorldstateSessionSnapshot;
  initialize(): Promise<void>;
  captureAndPlace(text: string, selectedNodeId?: string): Promise<void>;
  retryPlacement(): Promise<void>;
  acceptActivePlacement(): Promise<void>;
  prepareActiveAgentBrief(): Promise<void>;
  authorizeAndDispatchActiveBrief(): Promise<void>;
  retryActiveLiveDispatch(): Promise<void>;
  validateActiveEvidence(): Promise<void>;
  validateActiveReplayEvidence(): Promise<void>;
  proposeActiveReconciliation(): Promise<void>;
  integrateActiveReconciliation(): Promise<void>;
  proposeActiveArtifactPromotion(): Promise<void>;
  promoteActiveArtifact(): Promise<void>;
  resetSandbox(): Promise<void>;
}

export class WorldstateSessionBusyError extends Error {
  constructor(readonly operationState: WorldstateSessionOperationState) {
    super(`Worldstate session is busy with ${operationState}.`);
    this.name = "WorldstateSessionBusyError";
  }
}

export class WorldstateSessionNotReadyError extends Error {
  constructor() {
    super("Worldstate session has not loaded a durable ledger.");
    this.name = "WorldstateSessionNotReadyError";
  }
}

const PROJECT_LABEL = "Plan our home move";
const MAX_LEDGER_CONFLICT_RECOVERY_ATTEMPTS = 16;
const REPLAY_ARTIFACT_BASE_REF = "git:demo-base-001";

function defaultReplayRuntimeCapability(): AgentRuntimeCapability {
  return AgentRuntimeCapabilitySchema.parse({
    requestedMode: "replay",
    effectiveMode: "replay",
    status: "available",
    artifactBaseRef: null,
    reason: null,
  });
}

type ReconciliationRecoveryCode =
  | "stale_reconciliation"
  | "reconciliation_conflict"
  | "integration_gate_blocked";

class ReconciliationRecoveryError extends Error {
  constructor(
    readonly code: ReconciliationRecoveryCode,
    message: string,
    readonly durableDocument: WorldstateLedgerDocument,
  ) {
    super(message);
    this.name = "ReconciliationRecoveryError";
  }
}

interface ActivityProjection {
  readonly activeSourceId: string | null;
  readonly activeRequestId: string | null;
  readonly activeDeltaId: string | null;
  readonly activeAgentRequestId: string | null;
  readonly activeBriefId: string | null;
  readonly activeRunId: string | null;
  readonly activeClosureId: string | null;
  readonly activeValidationRequestId: string | null;
  readonly activeValidationId: string | null;
  readonly activeReconciliationDeltaId: string | null;
  readonly activeIntegratedRevisionId: string | null;
  readonly activeArtifactPromotionId: string | null;
  readonly error: WorldstateSessionError | null;
  readonly retry: WorldstateSessionRetry | null;
}

const EMPTY_ACTIVITY: ActivityProjection = {
  activeSourceId: null,
  activeRequestId: null,
  activeDeltaId: null,
  activeAgentRequestId: null,
  activeBriefId: null,
  activeRunId: null,
  activeClosureId: null,
  activeValidationRequestId: null,
  activeValidationId: null,
  activeReconciliationDeltaId: null,
  activeIntegratedRevisionId: null,
  activeArtifactPromotionId: null,
  error: null,
  retry: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function activityFromLedger(ledger: WorldstateLedger): ActivityProjection {
  let activity = EMPTY_ACTIVITY;
  let selectedNodeId: string = HOME_MOVE_IDS.budget;

  for (const event of ledger.events) {
    if (event.type === "source.captured") {
      const codexAttempt = parseCodexRunAttemptSource(event.payload.source);
      const codexExchange = parseCodexRunExchangeSource(event.payload.source);
      const codexNormalizationFailure = parseCodexRunNormalizationFailureSource(
        event.payload.source,
      );
      const codexTransportObservation = parseCodexTransportObservationSource(
        event.payload.source,
      );
      const replayEvidenceAttempt = parseReplayEvidenceValidationAttemptSource(
        event.payload.source,
      );
      const replayEvidenceExchange =
        parseReplayEvidenceValidationExchangeSource(event.payload.source);
      const liveEvidenceAttempt = parseLiveEvidenceValidationAttemptSource(
        event.payload.source,
      );
      const liveEvidenceExchange = parseLiveEvidenceValidationExchangeSource(
        event.payload.source,
      );
      const attempt = parsePlacementAttemptSource(event.payload.source);
      const exchange = parsePlacementExchangeSource(event.payload.source);
      const evidenceAttempt = replayEvidenceAttempt ?? liveEvidenceAttempt;
      const evidenceExchange = replayEvidenceExchange ?? liveEvidenceExchange;
      if (evidenceAttempt) {
        if (evidenceAttempt.request.closureId !== activity.activeClosureId) {
          continue;
        }
        activity = {
          ...activity,
          activeValidationRequestId:
            evidenceAttempt.request.validationRequestId,
          activeValidationId: evidenceAttempt.request.validationId,
          error: {
            code: "validation_outcome_unobserved",
            message:
              "The exact independent-validation request is durable, but no verifier response was observed.",
            retryable: true,
            scope: "validation",
          },
        };
      } else if (evidenceExchange) {
        if (
          evidenceExchange.request.closureId !== activity.activeClosureId ||
          evidenceExchange.request.validationRequestId !==
            activity.activeValidationRequestId
        ) {
          continue;
        }
        activity = {
          ...activity,
          activeValidationRequestId:
            evidenceExchange.request.validationRequestId,
          activeValidationId: evidenceExchange.request.validationId,
          error: evidenceExchange.response.ok
            ? null
            : {
                code: `validation_${evidenceExchange.response.error.code}`,
                message: evidenceExchange.response.error.message,
                retryable: false,
                scope: "validation",
              },
        };
      } else if (codexAttempt) {
        if (
          codexAttempt.request.brief.briefId !== activity.activeBriefId ||
          codexAttempt.request.runId !== activity.activeRunId
        ) {
          continue;
        }
        activity = {
          ...activity,
          activeAgentRequestId: codexAttempt.request.requestId,
          activeBriefId: codexAttempt.request.brief.briefId,
          activeRunId: codexAttempt.request.runId,
          activeClosureId: null,
          error: {
            code: "delegation_outcome_unobserved",
            message:
              "The exact replay request is durable, but no corresponding response was observed.",
            retryable: false,
            scope: "delegation",
          },
        };
      } else if (codexExchange) {
        if (
          codexExchange.request.brief.briefId !== activity.activeBriefId ||
          codexExchange.request.runId !== activity.activeRunId ||
          codexExchange.request.requestId !== activity.activeAgentRequestId
        ) {
          continue;
        }
        const responseError = codexExchange.response.ok
          ? null
          : {
              code: codexExchange.response.error.code,
              message: codexExchange.response.error.message,
              retryable: false,
              scope: "delegation" as const,
            };
        activity = {
          ...activity,
          activeAgentRequestId: codexExchange.request.requestId,
          activeBriefId: codexExchange.request.brief.briefId,
          activeRunId: codexExchange.request.runId,
          error: responseError,
        };
      } else if (codexNormalizationFailure) {
        if (
          codexNormalizationFailure.runId !== activity.activeRunId ||
          codexNormalizationFailure.requestId !==
            activity.activeAgentRequestId ||
          codexNormalizationFailure.briefId !== activity.activeBriefId
        ) {
          continue;
        }
        activity = {
          ...activity,
          error: {
            code: `delegation_${codexNormalizationFailure.code}`,
            message: codexNormalizationFailure.message,
            retryable: false,
            scope: "delegation",
          },
        };
      } else if (codexTransportObservation) {
        if (
          codexTransportObservation.runId !== activity.activeRunId ||
          codexTransportObservation.requestId !== activity.activeAgentRequestId
        ) {
          continue;
        }
        const httpDetail =
          codexTransportObservation.httpStatus === null
            ? "No HTTP response was observed."
            : `HTTP ${codexTransportObservation.httpStatus} was observed.`;
        activity = {
          ...activity,
          error: {
            code: `delegation_${codexTransportObservation.outcome}`,
            message: `The Codex gateway recorded ${codexTransportObservation.outcome}. ${httpDetail}`,
            retryable: false,
            scope: "delegation",
          },
        };
      } else if (attempt) {
        selectedNodeId =
          attempt.request.projection.selectedNodeId ?? HOME_MOVE_IDS.budget;
        activity = {
          ...activity,
          activeSourceId: attempt.request.source.sourceId,
          activeRequestId: attempt.request.requestId,
          activeDeltaId: null,
          error: null,
          retry: {
            operation: "placement",
            sourceId: attempt.request.source.sourceId,
            selectedNodeId,
          },
        };
      } else if (exchange) {
        selectedNodeId =
          exchange.request.projection.selectedNodeId ?? HOME_MOVE_IDS.budget;
        const responseError = exchange.response.ok
          ? null
          : {
              code: exchange.response.error.code,
              message: exchange.response.error.message,
              retryable: exchange.response.error.retryable,
              scope: "placement" as const,
            };
        activity = {
          ...activity,
          activeSourceId: exchange.request.source.sourceId,
          activeRequestId: exchange.request.requestId,
          activeDeltaId:
            exchange.response.ok && exchange.response.delta
              ? exchange.response.delta.deltaId
              : null,
          error: responseError,
          retry:
            responseError?.retryable === true
              ? {
                  operation: "placement",
                  sourceId: exchange.request.source.sourceId,
                  selectedNodeId,
                }
              : null,
        };
      } else if (
        event.payload.source.kind === "text" &&
        event.payload.source.visibility === "shared"
      ) {
        activity = {
          ...EMPTY_ACTIVITY,
          activeSourceId: event.payload.source.id,
          retry: {
            operation: "placement",
            sourceId: event.payload.source.id,
            selectedNodeId,
          },
        };
      }
      continue;
    }

    if (event.type === "delta.proposed") {
      const { delta } = event.payload;
      if (
        delta.purpose === "reconciliation" &&
        delta.closureRef === activity.activeClosureId
      ) {
        activity = {
          ...activity,
          activeReconciliationDeltaId: delta.id,
          activeIntegratedRevisionId: null,
          error:
            activity.error?.scope === "reconciliation" ||
            activity.error?.scope === "integration"
              ? null
              : activity.error,
        };
      }
      continue;
    }

    if (event.type === "delta.accepted") {
      if (event.payload.deltaId === activity.activeReconciliationDeltaId) {
        activity = {
          ...activity,
          activeIntegratedRevisionId: event.payload.revision.id,
          error:
            activity.error?.scope === "reconciliation" ||
            activity.error?.scope === "integration"
              ? null
              : activity.error,
        };
      }
      continue;
    }

    if (event.type === "manager.failure_recorded") {
      activity = {
        ...activity,
        activeSourceId: event.payload.sourceId ?? activity.activeSourceId,
        activeDeltaId: null,
        error: {
          code: event.payload.code,
          message: event.payload.message,
          retryable: event.payload.retriable,
          scope: "placement",
        },
        retry:
          event.payload.retriable && event.payload.sourceId
            ? {
                operation: "placement",
                sourceId: event.payload.sourceId,
                selectedNodeId,
              }
            : null,
      };
      continue;
    }

    if (event.type === "brief.compiled") {
      activity = {
        ...activity,
        activeAgentRequestId: null,
        activeBriefId: event.payload.brief.id,
        activeRunId: null,
        activeClosureId: null,
        activeValidationRequestId: null,
        activeValidationId: null,
        activeReconciliationDeltaId: null,
        activeIntegratedRevisionId: null,
        activeArtifactPromotionId: null,
        error: null,
      };
      continue;
    }

    if (event.type === "run.authorized") {
      if (event.payload.run.briefId !== activity.activeBriefId) {
        continue;
      }
      activity = {
        ...activity,
        activeBriefId: event.payload.run.briefId,
        activeRunId: event.payload.run.id,
        activeClosureId: null,
        activeValidationRequestId: null,
        activeValidationId: null,
        activeReconciliationDeltaId: null,
        activeIntegratedRevisionId: null,
        activeArtifactPromotionId: null,
        error: null,
      };
      continue;
    }

    if (event.type === "run.lifecycle_recorded") {
      if (event.payload.runId !== activity.activeRunId) {
        continue;
      }
      const status = event.payload.status;
      activity = {
        ...activity,
        activeRunId: event.payload.runId,
        error:
          status === "failed" ||
          status === "cancelled" ||
          status === "outcome_unknown"
            ? {
                code: `delegation_${status}`,
                message:
                  event.payload.message ??
                  `The replay run ended with status ${status}.`,
                retryable: false,
                scope: "delegation",
              }
            : activity.error?.scope === "delegation"
              ? null
              : activity.error,
      };
      continue;
    }

    if (event.type === "closure.staged") {
      if (
        event.payload.closure.briefId !== activity.activeBriefId ||
        event.payload.closure.runId !== activity.activeRunId
      ) {
        continue;
      }
      activity = {
        ...activity,
        activeBriefId: event.payload.closure.briefId,
        activeRunId: event.payload.closure.runId,
        activeClosureId: event.payload.closure.id,
        activeValidationRequestId: null,
        activeValidationId: null,
        activeReconciliationDeltaId: null,
        activeIntegratedRevisionId: null,
        activeArtifactPromotionId: null,
        error:
          event.payload.closure.outcome === "returned"
            ? null
            : {
                code: `delegation_${event.payload.closure.outcome}`,
                message: event.payload.closure.summary,
                retryable: false,
                scope: "delegation",
              },
      };
      continue;
    }

    if (event.type === "evidence.validation_recorded") {
      if (event.payload.validation.closureId !== activity.activeClosureId) {
        continue;
      }
      activity = {
        ...activity,
        activeValidationId: event.payload.validation.id,
        error: activity.error?.scope === "validation" ? null : activity.error,
      };
      continue;
    }

    if (event.type === "artifact.promotion_proposed") {
      activity = {
        ...activity,
        activeArtifactPromotionId: event.payload.proposal.id,
        error:
          activity.error?.scope === "artifact_promotion"
            ? null
            : activity.error,
      };
      continue;
    }

    if (event.type === "artifact.promotion_authorized") {
      if (activity.activeArtifactPromotionId !== event.payload.promotionId) {
        continue;
      }
      activity = {
        ...activity,
        error:
          activity.error?.scope === "artifact_promotion"
            ? null
            : activity.error,
      };
      continue;
    }

    if (event.type === "artifact.promotion_outcome_recorded") {
      if (
        activity.activeArtifactPromotionId !==
        event.payload.outcome.promotionId
      ) {
        continue;
      }
      const outcome = event.payload.outcome.outcome;
      activity = {
        ...activity,
        error:
          outcome === "promoted"
            ? null
            : {
                code: `artifact_promotion_${outcome}`,
                message:
                  outcome === "stale"
                    ? "The authoritative target moved before the candidate could be promoted."
                    : outcome === "outcome_unknown"
                      ? "The server recorded a promotion attempt but cannot establish the target-ref outcome."
                      : "The signed artifact candidate was not promoted.",
                retryable: false,
                scope: "artifact_promotion",
              },
      };
    }
  }

  return activity;
}

function loadedDocument(input: unknown): {
  readonly document: WorldstateLedgerDocument;
  readonly ledger: WorldstateLedger;
  readonly state: WorldstateState;
  readonly version: LedgerVersion;
  readonly activity: ActivityProjection;
} {
  const document = parseWorldstateLedgerDocument(input);
  const ledger = worldstateLedgerFromDocument(document);
  const state = reduceWorldstateLedger(ledger);
  const version = ledgerVersion(document);

  if (!version) {
    throw new LedgerCorruptionError(
      `Ledger ${document.projectId} did not produce a persistence version.`,
    );
  }

  return {
    document,
    ledger,
    state,
    version,
    activity: activityFromLedger(ledger),
  };
}

type LoadedWorldstateDocument = Pick<
  ReturnType<typeof loadedDocument>,
  "document" | "ledger" | "state" | "version"
>;

function transactionResultFromLoaded(
  loaded: LoadedWorldstateDocument,
  replayedEventIds: readonly string[] = [],
): WorldstateLedgerTransactionResult {
  return {
    document: loaded.document,
    ledger: loaded.ledger,
    state: loaded.state,
    version: loaded.version,
    appendedEventIds: [],
    replayedEventIds,
  };
}

function artifactPromotionReceiptDigest(
  receipt: ArtifactPromotionReceipt,
): string {
  return `sha256:${artifactIdentitySha256Hex(stableStringify(receipt))}`;
}

function hasEquivalentReconciliationProposal(
  loaded: LoadedWorldstateDocument,
  expected: WorldstateDelta,
): boolean {
  const projection = loaded.state.operational.deltas[expected.id];
  const receiptSource =
    loaded.state.operational.sources[resultReconciliationSourceId(expected.id)];
  const receipt = receiptSource
    ? parseResultReconciliationArtifactSource(receiptSource)
    : null;
  const structurallyEquivalent =
    projection?.delta.purpose === "reconciliation" &&
    stableStringify(projection.delta) === stableStringify(expected) &&
    receipt?.bindings.deltaId === expected.id &&
    stableStringify(receipt.delta) === stableStringify(expected);
  if (!structurallyEquivalent) return false;

  try {
    assertReconciliationDeltaMatchesCurrentState(loaded.state, expected.id);
    return true;
  } catch {
    return false;
  }
}

class DurableWorldstateSession implements WorldstateSession {
  private readonly listeners = new Set<() => void>();
  private readonly transaction: WorldstateLedgerTransactionService;
  private snapshot: WorldstateSessionSnapshot = {
    document: null,
    ledger: null,
    state: null,
    version: null,
    persistenceState: "loading",
    persistenceDetail: "Waiting for the browser ledger.",
    operationState: "idle",
    agentRuntimeCapability: null,
    hostAttestedArtifactPromotionReceiptDigests: {},
    ...EMPTY_ACTIVITY,
  };

  constructor(private readonly dependencies: WorldstateSessionDependencies) {
    this.transaction = createWorldstateLedgerTransactionService({
      store: dependencies.store,
      now: dependencies.now,
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WorldstateSessionSnapshot => this.snapshot;

  async initialize(): Promise<void> {
    this.assertIdle();
    this.patch({
      persistenceState: "loading",
      persistenceDetail: "Loading the browser ledger.",
      operationState: "initializing",
      error: null,
      retry: null,
    });

    try {
      const existing = await this.dependencies.store.get(HOME_MOVE_IDS.project);
      if (existing) {
        this.install(existing, "saved", "Browser ledger loaded.");
        await this.recoverDurableLiveRunResponse();
        await this.recoverDurableCodexNormalization();
        await this.recoverDurableReplayEvidenceValidation();
        await this.recoverDurableLiveEvidenceValidation();
        await this.recoverDurableArtifactPromotions();
        await this.refreshAgentRuntimeCapability();
        return;
      }

      const fixture = createHomeMoveSeedFixture();
      const document = worldstateLedgerDocument({
        ledger: fixture.ledger,
        projectLabel: PROJECT_LABEL,
        updatedAt: this.dependencies.now(),
      });

      try {
        await this.dependencies.store.put(document, null);
        this.install(document, "saved", "Sandbox ledger created.");
        await this.refreshAgentRuntimeCapability();
      } catch (error) {
        if (!(error instanceof LedgerConflictError)) throw error;

        const concurrentlyCreated = await this.dependencies.store.get(
          HOME_MOVE_IDS.project,
        );
        if (!concurrentlyCreated) throw error;
        this.install(
          concurrentlyCreated,
          "saved",
          "Sandbox ledger loaded after concurrent creation.",
        );
        await this.recoverDurableLiveRunResponse();
        await this.recoverDurableCodexNormalization();
        await this.recoverDurableReplayEvidenceValidation();
        await this.recoverDurableLiveEvidenceValidation();
        await this.recoverDurableArtifactPromotions();
        await this.refreshAgentRuntimeCapability();
      }
    } catch (error) {
      this.surfaceLoadFailure(error);
    }
  }

  async captureAndPlace(
    text: string,
    selectedNodeId = HOME_MOVE_IDS.budget,
  ): Promise<void> {
    this.assertIdle();
    const { ledger } = this.requireLoaded();

    const sourceId = this.dependencies.nextId("source");
    const sourceEvent = sourceCapturedEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: sourceId,
          kind: "text",
          content: text,
          visibility: "shared",
        },
      },
    });
    const requestId = this.dependencies.nextId("request");
    let request: PlacementRequest;

    try {
      const previewLedger = appendLedgerEvent(ledger, sourceEvent).ledger;
      request = compilePlacementRequest({
        state: reduceWorldstateLedger(previewLedger),
        sourceId,
        requestId,
        scopeId: HOME_MOVE_IDS.project,
        projectId: HOME_MOVE_IDS.projectNode,
        selectedNodeId,
      });
    } catch (error) {
      await this.persistUnplacedSource({
        sourceEvent,
        sourceId,
        error,
      });
      return;
    }

    const attempt = placementAttemptSourceEvent({
      request,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the source and bounded placement request.",
      operationState: "capturing",
      error: null,
      retry: null,
    });

    try {
      const sourceResult = await this.append([sourceEvent, attempt]);
      this.installTransaction(
        sourceResult,
        {
          activeSourceId: sourceId,
          activeRequestId: requestId,
          activeDeltaId: null,
          error: null,
          retry: { operation: "placement", sourceId, selectedNodeId },
        },
        {
          operationState: "placing",
          persistenceDetail:
            "The source and exact placement request are durable; placement is in progress.",
        },
      );
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "placement");
      return;
    }

    await this.requestPlacement(request, selectedNodeId);
  }

  async retryPlacement(): Promise<void> {
    this.assertIdle();
    this.requireLoaded();
    const retry = this.snapshot.retry;
    if (!retry || retry.operation !== "placement") {
      throw new WorldstateSessionNotReadyError();
    }
    if (!this.snapshot.state?.operational.sources[retry.sourceId]) {
      throw new WorldstateSessionNotReadyError();
    }

    await this.placeCapturedSource(retry.sourceId, retry.selectedNodeId);
  }

  async acceptActivePlacement(): Promise<void> {
    this.assertIdle();
    const { state } = this.requireLoaded();
    const deltaId = this.snapshot.activeDeltaId;
    const proposal = deltaId ? state.operational.deltas[deltaId] : undefined;

    if (!deltaId || !proposal || proposal.disposition !== "pending") {
      throw new WorldstateSessionNotReadyError();
    }

    if (proposal.delta.baseRevisionId !== state.canonical.head.id) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The placement is stale and must be reviewed against the current revision.",
        operationState: "idle",
        error: {
          code: "stale_delta",
          message:
            "This placement was proposed against an older revision and cannot be committed.",
          retryable: false,
          scope: "semantic_commit",
        },
        retry: null,
      });
      return;
    }

    const accepted = buildDeltaAcceptedEvent(state, {
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.human,
      deltaId,
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the semantic commit.",
      operationState: "accepting",
      error: null,
      retry: null,
    });

    try {
      const result = await this.append([accepted]);
      this.installTransaction(result, {
        ...activityFromLedger(result.ledger),
        activeSourceId: this.snapshot.activeSourceId,
        activeRequestId: this.snapshot.activeRequestId,
        activeDeltaId: deltaId,
      });
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "semantic_commit");
    }
  }

  async prepareActiveAgentBrief(): Promise<void> {
    this.assertIdle();
    const { state } = this.requireLoaded();
    const activeBrief = this.snapshot.activeBriefId
      ? state.operational.briefs[this.snapshot.activeBriefId]
      : undefined;
    const currentBrief =
      activeBrief?.baseRevisionId === state.canonical.head.id
        ? activeBrief
        : Object.values(state.operational.briefs).find(
            (brief) => brief.baseRevisionId === state.canonical.head.id,
          );

    if (currentBrief?.baseRevisionId === state.canonical.head.id) {
      throw new WorldstateSessionNotReadyError();
    }

    const runtime = await this.refreshAgentRuntimeCapability();
    if (
      runtime.status !== "available" ||
      runtime.effectiveMode === null ||
      (runtime.effectiveMode === "live" && runtime.artifactBaseRef === null)
    ) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The accepted placement is durable, but the configured agent runtime is unavailable.",
        operationState: "idle",
        error: {
          code: "agent_runtime_unavailable",
          message:
            runtime.reason ??
            "The configured agent runtime did not provide a lawful execution base.",
          retryable: true,
          scope: "delegation",
        },
      });
      return;
    }

    let brief;
    try {
      brief = compileAcceptedPlacementAgentBrief(state, {
        briefId: this.dependencies.nextId("brief"),
        executionMode: runtime.effectiveMode,
        artifactBaseRef:
          runtime.effectiveMode === "live"
            ? runtime.artifactBaseRef!
            : REPLAY_ARTIFACT_BASE_REF,
      });
    } catch (error) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The accepted placement is durable, but no lawful delegation brief could be compiled.",
        operationState: "idle",
        error: {
          code: "agent_brief_invalid",
          message: errorMessage(
            error,
            "The accepted placement cannot be compiled into an agent brief.",
          ),
          retryable: false,
          scope: "delegation",
        },
      });
      return;
    }

    const compiled = briefCompiledEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.manager,
      payload: { brief },
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the immutable agent brief preview.",
      operationState: "preparing_brief",
      error: null,
      retry: null,
    });

    try {
      const result = await this.append([compiled]);
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail:
          "The bounded agent brief is durable; no run authority has been granted.",
      });
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "delegation");
    }
  }

  async authorizeAndDispatchActiveBrief(): Promise<void> {
    this.assertIdle();
    const { document, ledger, state } = this.requireLoaded();
    const briefId = this.snapshot.activeBriefId;
    const brief = briefId ? state.operational.briefs[briefId] : undefined;

    if (
      !brief ||
      brief.baseRevisionId !== state.canonical.head.id ||
      Object.values(state.operational.runs).some(
        (projection) => projection.run.briefId === brief.id,
      )
    ) {
      throw new WorldstateSessionNotReadyError();
    }

    if (!this.dependencies.agentGateway) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The agent brief remains staged without dispatch authority.",
        operationState: "idle",
        error: {
          code: "agent_gateway_unavailable",
          message: "The configured agent gateway is unavailable in this host.",
          retryable: false,
          scope: "delegation",
        },
      });
      return;
    }

    if (
      brief.executionMode === "live" &&
      !this.dependencies.liveAuthorizationGateway
    ) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The live brief remains staged without server-minted dispatch authority.",
        operationState: "idle",
        error: {
          code: "live_authority_gateway_unavailable",
          message:
            "The browser-to-server live authorization handoff is unavailable in this host.",
          retryable: false,
          scope: "delegation",
        },
      });
      return;
    }

    const run: AgentRun = {
      id: this.dependencies.nextId("run"),
      briefId: brief.id,
      baseRevisionId: brief.baseRevisionId,
      artifactBaseRef: brief.artifactBaseRef,
      mode: brief.executionMode,
    };
    const requestId = this.dependencies.nextId("request");
    const unsignedRequest = domainBriefToCodexRunRequest(
      brief,
      run.id,
      run.mode,
      requestId,
    );
    const authorized = runAuthorizedEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.human,
      payload: { run },
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail:
        run.mode === "live"
          ? "Requesting a server-minted capability for one exact proposed live run."
          : "Saving one-run replay authority and the exact execution request.",
      operationState: "authorizing_run",
      error: null,
      retry: null,
    });

    let request: AgentRunRequest;
    if (run.mode === "replay") {
      request = unsignedRequest;
      const attempt = codexRunAttemptSourceEvent({
        run,
        brief,
        request,
        eventId: this.dependencies.nextId("event"),
        commandId: this.dependencies.nextId("command"),
        occurredAt: this.dependencies.now(),
        actor: HOME_MOVE_ACTORS.system,
      });
      try {
        const result = await this.append([authorized, attempt]);
        this.installTransaction(
          result,
          { error: null },
          {
            operationState: "dispatching_run",
            persistenceDetail:
              "Replay authority and the exact request are durable; the fixture adapter is in progress.",
          },
        );
      } catch (error) {
        await this.surfaceWriteFailure(error, null, "delegation");
        return;
      }
    } else {
      // The authority service needs to inspect the exact proposed run before it
      // can mint a capability. Publish that proposal to the server from an
      // in-memory ledger preview, then commit the human authorization and exact
      // signed request together in the browser ledger before any dispatch. A
      // crash in between can leave only an inert private server intent; it
      // cannot leave a queued browser run whose request identity was lost.
      const authorizationPreview = worldstateLedgerDocument({
        ledger: appendLedgerEvent(ledger, authorized).ledger,
        projectLabel: document.projectLabel,
        updatedAt: authorized.occurredAt,
      });
      try {
        request = AgentRunRequestSchema.parse(
          await this.dependencies.liveAuthorizationGateway!({
            document: authorizationPreview,
            runId: run.id,
            requestId,
          }),
        );
        const withoutAuthorization = AgentRunRequestSchema.parse({
          ...request,
          authorization: null,
        });
        if (
          request.authorization === null ||
          stableStringify(withoutAuthorization) !==
            stableStringify(unsignedRequest)
        ) {
          throw new Error(
            "The live authority service changed the immutable run request.",
          );
        }
      } catch (error) {
        this.patch({
          persistenceState: "saved",
          persistenceDetail:
            "No live run was committed because the server did not mint an execution capability.",
          operationState: "idle",
          error: {
            code: "live_authorization_failed",
            message: errorMessage(
              error,
              "The live authority service did not authorize this exact run.",
            ),
            retryable: true,
            scope: "delegation",
          },
        });
        return;
      }

      const attempt = codexRunAttemptSourceEvent({
        run,
        brief,
        request,
        eventId: this.dependencies.nextId("event"),
        commandId: this.dependencies.nextId("command"),
        occurredAt: this.dependencies.now(),
        actor: HOME_MOVE_ACTORS.system,
      });
      this.patch({
        persistenceState: "saving",
        persistenceDetail:
          "Saving live authority and the exact signed request together before dispatch.",
        operationState: "authorizing_run",
      });
      try {
        const result = await this.append([authorized, attempt]);
        this.installTransaction(
          result,
          { error: null },
          {
            operationState: "dispatching_run",
            persistenceDetail:
              "The signed live request is durable; isolated Codex execution is in progress.",
          },
        );
      } catch (error) {
        await this.surfaceWriteFailure(error, null, "delegation");
        return;
      }
    }

    await this.dispatchAndPersistAuthorizedRun({ run, brief, request });
  }

  async retryActiveLiveDispatch(): Promise<void> {
    this.assertIdle();
    const { ledger, state } = this.requireLoaded();
    const runId = this.snapshot.activeRunId;
    const runProjection = runId
      ? state.operational.runs[runId]
      : undefined;
    const run = runProjection?.run;
    const brief = run ? state.operational.briefs[run.briefId] : undefined;
    if (
      !run ||
      !brief ||
      run.mode !== "live" ||
      runProjection.status !== "queued" ||
      !this.dependencies.agentGateway ||
      !this.dependencies.liveRunStatusGetter
    ) {
      throw new WorldstateSessionNotReadyError();
    }
    let request: AgentRunRequest | null = null;
    for (const event of ledger.events) {
      if (event.type !== "source.captured") continue;
      const attempt = parseCodexRunAttemptSource(event.payload.source);
      if (attempt?.request.runId === run.id) request = attempt.request;
    }
    if (!request || request.mode !== "live" || !request.authorization) {
      throw new WorldstateSessionNotReadyError();
    }

    let status;
    try {
      status = await this.dependencies.liveRunStatusGetter({
        runId: run.id,
        requestId: request.requestId,
      });
    } catch (error) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The exact live request remains durable; private server status could not be read, so dispatch was not retried.",
        operationState: "idle",
        error: {
          code: "delegation_status_unavailable",
          message: errorMessage(
            error,
            "Private live-run status is unavailable.",
          ),
          retryable: true,
          scope: "delegation",
        },
      });
      return;
    }
    if (status.status === "completed" && status.response) {
      await this.dispatchAndPersistAuthorizedRun({
        run,
        brief,
        request,
        observedResponse: status.response,
      });
      return;
    }
    if (status.status !== "not_started") {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          status.status === "in_progress"
            ? "The server reports the exact live dispatch is already in progress."
            : "The server cannot establish a safe redispatch posture for the exact live request.",
        operationState: "idle",
        error: {
          code: `delegation_${status.status}`,
          message:
            status.status === "in_progress"
              ? "Wait for the private server response; no duplicate dispatch was attempted."
              : "The live run has execution evidence without a recoverable exact response; it will not be rerun.",
          retryable: status.status === "in_progress",
          scope: "delegation",
        },
      });
      return;
    }

    this.patch({
      persistenceState: "saved",
      persistenceDetail:
        "The private server confirms dispatch never started; retrying the exact signed request without creating new authority.",
      operationState: "dispatching_run",
      error: null,
      retry: null,
    });
    await this.dispatchAndPersistAuthorizedRun({ run, brief, request });
  }

  private async dispatchAndPersistAuthorizedRun(input: {
    readonly run: AgentRun;
    readonly brief: AgentBrief;
    readonly request: AgentRunRequest;
    readonly observedResponse?: AgentRunResponse;
  }): Promise<void> {
    const brief = input.brief;
    let response: AgentRunResponse;
    try {
      response = AgentRunResponseSchema.parse(
        input.observedResponse ??
          (await this.dependencies.agentGateway!(input.request)),
      );
    } catch (error) {
      await this.persistDelegationGatewayFailure({
        run: input.run,
        request: input.request,
        error,
      });
      return;
    }

    if (
      input.run.mode === "live" &&
      !response.ok &&
      (response.error.code === "run_claim_busy" ||
        response.error.code === "authorization_consumed")
    ) {
      // These codes can be emitted by the private dispatch wrapper before it
      // invokes the worker (for example, when another tab already claimed the
      // exact request). They are not terminal worker evidence by themselves.
      // Prefer the server-private durable response when one exists. Every
      // non-completed posture remains nonterminal: an outcome_unknown status
      // can mean another server process is still executing because its active
      // in-memory marker is not visible here.
      let privateResponse: AgentRunResponse | null = null;
      let privateStatus:
        | "not_started"
        | "in_progress"
        | "outcome_unknown"
        | "unavailable" = "unavailable";
      if (this.dependencies.liveRunStatusGetter) {
        try {
          const status = await this.dependencies.liveRunStatusGetter({
            runId: input.run.id,
            requestId: input.request.requestId,
          });
          if (status.status === "completed") {
            privateResponse = status.response
              ? AgentRunResponseSchema.parse(status.response)
              : null;
            if (!privateResponse) privateStatus = "outcome_unknown";
          } else {
            privateStatus = status.status;
          }
        } catch {
          privateStatus = "unavailable";
        }
      }
      if (!privateResponse) {
        this.patch({
          persistenceState: "saved",
          persistenceDetail:
            privateStatus === "not_started"
              ? "The private server confirms dispatch never started; the exact signed request remains safely retryable."
              : privateStatus === "in_progress"
                ? "The private server reports that the exact live request is still in progress."
                : privateStatus === "outcome_unknown"
                  ? "The private server has execution evidence without a durable response; the run remains nonterminal because another server process may still be executing."
                  : "Private live-run status could not establish a terminal response; the run remains queued.",
          operationState: "idle",
          error: {
            code:
              privateStatus === "unavailable"
                ? "delegation_status_unavailable"
                : `delegation_${privateStatus}`,
            message:
              privateStatus === "not_started"
                ? "The live request awaits an explicit exact dispatch retry."
                : privateStatus === "in_progress"
                  ? "Wait for the private server response; no duplicate dispatch was attempted."
                  : privateStatus === "outcome_unknown"
                    ? "Execution evidence exists without a recoverable response. The browser will not infer a terminal outcome or redispatch the request."
                    : "Private live-run status is unavailable; no terminal outcome was inferred.",
            retryable: privateStatus !== "outcome_unknown",
            scope: "delegation",
          },
        });
        return;
      }
      response = privateResponse;
    }

    const recordedAt = this.dependencies.now();
    const exchange = codexRunExchangeSourceEvent({
      request: input.request,
      response,
      eventId: `event-codex-exchange:${input.request.requestId}`,
      commandId: `command-codex-exchange:${input.request.requestId}`,
      occurredAt: recordedAt,
      actor: HOME_MOVE_ACTORS.system,
    });
    this.patch({
      persistenceState: "saving",
      persistenceDetail: `Saving the exact ${input.run.mode} response before state-dependent normalization.`,
      operationState: "persisting_run_result",
    });
    try {
      const result = await this.appendWithConflictRecovery([exchange]);
      this.installTransaction(result, activityFromLedger(result.ledger), {
        operationState: "persisting_run_result",
        persistenceDetail: `The exact ${input.run.mode} response is durable; lifecycle normalization is in progress.`,
      });
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "delegation");
      return;
    }

    let normalizedEvents: NonEmptyLedgerEvents;
    try {
      const [, ...events] = codexRunResponseEvents({
        run: input.run,
        brief,
        request: input.request,
        response,
        recordedAt,
        systemActor: HOME_MOVE_ACTORS.system,
      });
      const [firstEvent, ...remainingEvents] = events;
      if (!firstEvent) {
        throw new Error("The agent response produced no lifecycle evidence.");
      }
      normalizedEvents = [firstEvent, ...remainingEvents];
    } catch (error) {
      await this.persistDelegationNormalizationFailure({
        run: input.run,
        request: input.request,
        code: "coherence_rejected",
        error,
      });
      return;
    }
    try {
      const result = await this.appendWithConflictRecovery(normalizedEvents);
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail: `The ${input.run.mode} result is durable and staged for review; canonical worldstate is unchanged.`,
      });
    } catch (error) {
      await this.persistDelegationNormalizationFailure({
        run: input.run,
        request: input.request,
        code: "state_conflict",
        error,
      });
    }
  }

  async validateActiveEvidence(): Promise<void> {
    this.assertIdle();
    const { ledger, state } = this.requireLoaded();
    const closureId = this.snapshot.activeClosureId;
    const closure = closureId
      ? state.operational.closures[closureId]
      : undefined;
    const runProjection = closure
      ? state.operational.runs[closure.runId]
      : undefined;
    const brief = closure
      ? state.operational.briefs[closure.briefId]
      : undefined;
    const existingValidationId = closure
      ? state.operational.latestValidationByClosure[closure.id]
      : undefined;

    if (
      !closure ||
      !runProjection ||
      !brief ||
      existingValidationId ||
      closure.outcome !== "returned" ||
      (closure.mode !== "replay" && closure.mode !== "live") ||
      runProjection.status !== "returned" ||
      closure.baseRevisionId !== state.canonical.head.id ||
      brief.baseRevisionId !== state.canonical.head.id ||
      runProjection.run.baseRevisionId !== state.canonical.head.id
    ) {
      throw new WorldstateSessionNotReadyError();
    }

    const evidenceGateway =
      closure.mode === "live"
        ? this.dependencies.liveEvidenceGateway
        : this.dependencies.replayEvidenceGateway;
    if (!evidenceGateway) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail: `The returned ${closure.mode} result remains staged without an independent verifier.`,
        operationState: "idle",
        error: {
          code: "validation_gateway_unavailable",
          message:
            closure.mode === "live"
              ? "The independent live-candidate verification gateway is unavailable in this host."
              : "The independent fixture-verification gateway is unavailable in this host.",
          retryable: false,
          scope: "validation",
        },
      });
      return;
    }

    let codexExchange: CodexRunExchange | null = null;
    for (const event of ledger.events) {
      if (event.type !== "source.captured") continue;
      const candidate = parseCodexRunExchangeSource(event.payload.source);
      if (candidate?.request.runId === runProjection.run.id) {
        codexExchange = candidate;
      }
    }
    if (!codexExchange) throw new WorldstateSessionNotReadyError();

    let request: ReplayEvidenceRequest | LiveEvidenceRequest;
    let retryingDurableRequest = false;
    try {
      const activeValidationRequestId =
        this.snapshot.activeValidationRequestId;
      let priorRequest: ReplayEvidenceRequest | LiveEvidenceRequest | null = null;
      let priorResponseObserved = false;
      if (activeValidationRequestId) {
        for (const event of ledger.events) {
          if (event.type !== "source.captured") continue;
          const replayAttempt = parseReplayEvidenceValidationAttemptSource(
            event.payload.source,
          );
          const liveAttempt = parseLiveEvidenceValidationAttemptSource(
            event.payload.source,
          );
          const attempt = replayAttempt ?? liveAttempt;
          if (
            attempt?.request.validationRequestId ===
              activeValidationRequestId &&
            attempt.request.closureId === closure.id
          ) {
            priorRequest = attempt.request;
          }
          const replayExchange = parseReplayEvidenceValidationExchangeSource(
            event.payload.source,
          );
          const liveExchange = parseLiveEvidenceValidationExchangeSource(
            event.payload.source,
          );
          const observed = replayExchange ?? liveExchange;
          if (
            observed?.request.validationRequestId ===
            activeValidationRequestId
          ) {
            priorResponseObserved = true;
          }
        }
        if (!priorRequest || priorResponseObserved) {
          throw new Error(
            "The durable validation request is missing or already has an observed response.",
          );
        }
      }
      if (priorRequest) {
        request = priorRequest;
        retryingDurableRequest = true;
      } else {
        const bindings = {
          validationRequestId: this.dependencies.nextId("request"),
          validationId: this.dependencies.nextId("validation"),
          run: runProjection.run,
          brief,
          closure,
          codexExchange,
        };
        request =
          closure.mode === "live"
            ? compileLiveEvidenceRequest(bindings)
            : compileReplayEvidenceRequest(bindings);
      }
    } catch (error) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail: `The ${closure.mode} result remains staged; no validation request was issued.`,
        operationState: "idle",
        error: {
          code: "validation_binding_rejected",
          message: errorMessage(
            error,
            `The ${closure.mode} result could not be bound to an independent validation request.`,
          ),
          retryable: false,
          scope: "validation",
        },
      });
      return;
    }

    if (!retryingDurableRequest) {
      const attemptEventId = this.dependencies.nextId("event");
      const attemptCommandId = this.dependencies.nextId("command");
      const attemptOccurredAt = this.dependencies.now();
      const attempt =
        closure.mode === "live"
          ? liveEvidenceValidationAttemptSourceEvent({
              request: request as LiveEvidenceRequest,
              eventId: attemptEventId,
              commandId: attemptCommandId,
              occurredAt: attemptOccurredAt,
              actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
            })
          : replayEvidenceValidationAttemptSourceEvent({
              request: request as ReplayEvidenceRequest,
              eventId: attemptEventId,
              commandId: attemptCommandId,
              occurredAt: attemptOccurredAt,
              actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
            });
      this.patch({
        persistenceState: "saving",
        persistenceDetail:
          "Saving the exact independent-validation request before verification.",
        operationState: "validating_evidence",
        error: null,
        retry: null,
      });

      try {
        const result = await this.append([attempt]);
        this.installTransaction(
          result,
          { error: null },
          {
            operationState: "validating_evidence",
            persistenceDetail: `The exact validation request is durable; the independent ${closure.mode === "live" ? "live-candidate" : "fixture"} verifier is running.`,
          },
        );
      } catch (error) {
        await this.surfaceWriteFailure(error, null, "validation");
        return;
      }
    } else {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "Retrying the exact durable validation request after an unobserved response; no new request or authority was created.",
        operationState: "validating_evidence",
        error: null,
        retry: null,
      });
    }

    let response: ReplayEvidenceResponse | LiveEvidenceResponse;
    try {
      response =
        closure.mode === "live"
          ? LiveEvidenceResponseSchema.parse(
              await this.dependencies.liveEvidenceGateway!(
                request as LiveEvidenceRequest,
              ),
            )
          : ReplayEvidenceResponseSchema.parse(
              await this.dependencies.replayEvidenceGateway!(
                request as ReplayEvidenceRequest,
              ),
            );
    } catch (error) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The validation request is durable, but no verifier response was observed.",
        operationState: "idle",
        error: {
          code: "validation_outcome_unobserved",
          message: errorMessage(
            error,
            `The independent ${closure.mode === "live" ? "live-candidate" : "fixture"} verifier did not return an observable response.`,
          ),
          retryable: true,
          scope: "validation",
        },
      });
      return;
    }

    const recordedAt = this.dependencies.now();
    const exchange =
      closure.mode === "live"
        ? liveEvidenceValidationExchangeSourceEvent({
            request: request as LiveEvidenceRequest,
            response: response as LiveEvidenceResponse,
            eventId: `event-live-evidence-exchange:${request.validationRequestId}`,
            commandId: `command-live-evidence-exchange:${request.validationRequestId}`,
            occurredAt: recordedAt,
            actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
          })
        : replayEvidenceValidationExchangeSourceEvent({
            request: request as ReplayEvidenceRequest,
            response: response as ReplayEvidenceResponse,
            eventId: `event-replay-evidence-exchange:${request.validationRequestId}`,
            commandId: `command-replay-evidence-exchange:${request.validationRequestId}`,
            occurredAt: recordedAt,
            actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
          });
    this.patch({
      persistenceState: "saving",
      persistenceDetail:
        "Saving the exact verifier response before domain validation is recorded.",
      operationState: "persisting_validation",
    });

    let exchangeResult: WorldstateLedgerTransactionResult;
    try {
      exchangeResult = await this.appendWithConflictRecovery([exchange]);
      this.installTransaction(
        exchangeResult,
        activityFromLedger(exchangeResult.ledger),
        {
          operationState: response.ok ? "persisting_validation" : "idle",
          persistenceDetail: response.ok
            ? "The exact verifier response is durable; validation normalization is in progress."
            : "The independent verifier declined or failed the request; no validation record was created.",
        },
      );
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "validation");
      return;
    }

    if (!response.ok) return;

    try {
      const result =
        closure.mode === "live"
          ? await this.appendLiveEvidenceValidationWithConflictRecovery({
              request: request as LiveEvidenceRequest,
              response: response as Extract<LiveEvidenceResponse, { ok: true }>,
              eventId: `event-evidence-validation:${request.validationId}`,
              commandId: `command-evidence-validation:${request.validationId}`,
              occurredAt: recordedAt,
              actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
            })
          : await this.appendReplayEvidenceValidationWithConflictRecovery({
              request: request as ReplayEvidenceRequest,
              response: response as Extract<
                ReplayEvidenceResponse,
                { ok: true }
              >,
              eventId: `event-evidence-validation:${request.validationId}`,
              commandId: `command-evidence-validation:${request.validationId}`,
              occurredAt: recordedAt,
              actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
            });
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail: `Independent ${closure.mode === "live" ? "live-candidate" : "fixture"} evidence is durable; canonical worldstate is unchanged.`,
      });
    } catch (error) {
      if (
        error instanceof ReplayEvidenceValidationCoherenceError ||
        error instanceof LiveEvidenceValidationCoherenceError
      ) {
        this.patch({
          persistenceState: "saved",
          persistenceDetail:
            "The exact verifier response is durable, but validation normalization was rejected.",
          operationState: "idle",
          error: {
            code: "validation_coherence_rejected",
            message: errorMessage(
              error,
              `The verifier response did not match the durable ${closure.mode} result.`,
            ),
            retryable: false,
            scope: "validation",
          },
        });
        return;
      }
      await this.surfaceWriteFailure(error, null, "validation");
    }
  }

  async validateActiveReplayEvidence(): Promise<void> {
    return this.validateActiveEvidence();
  }

  async proposeActiveReconciliation(): Promise<void> {
    this.assertIdle();
    const { state } = this.requireLoaded();
    const closureId = this.snapshot.activeClosureId;
    const validationId = this.snapshot.activeValidationId;
    const closure = closureId
      ? state.operational.closures[closureId]
      : undefined;
    const validation = validationId
      ? state.operational.validations[validationId]
      : undefined;
    const existingForClosure = closureId
      ? Object.values(state.operational.deltas).find(
          (projection) =>
            projection.delta.purpose === "reconciliation" &&
            projection.delta.closureRef === closureId,
        )
      : undefined;

    if (
      !closure ||
      !validation ||
      validation.closureId !== closure.id ||
      state.operational.latestValidationByClosure[closure.id] !==
        validation.id ||
      this.snapshot.activeReconciliationDeltaId ||
      existingForClosure
    ) {
      throw new WorldstateSessionNotReadyError();
    }

    const deltaId = resultReconciliationDeltaId({
      closureId: closure.id,
      validationId: validation.id,
      baseRevisionId: state.canonical.head.id,
    });
    const occurredAt = this.dependencies.now();
    let proposalEvents: ReturnType<typeof resultReconciliationProposalEvents>;
    try {
      proposalEvents = resultReconciliationProposalEvents({
        state,
        closureId: closure.id,
        validationId: validation.id,
        deltaId,
        occurredAt,
        systemActor: HOME_MOVE_ACTORS.system,
      });
    } catch (error) {
      this.surfaceReconciliationCompilationFailure(
        error,
        "reconciliation",
        "reconciliation_binding_rejected",
        "The validated result could not be compiled into a reconciliation proposal.",
      );
      return;
    }

    this.patch({
      persistenceState: "saving",
      persistenceDetail:
        "Saving the integrity-bound reconciliation receipt and candidate proposal.",
      operationState: "proposing_reconciliation",
      error: null,
      retry: null,
    });

    try {
      const result =
        await this.appendReconciliationProposalWithConflictRecovery({
          closureId: closure.id,
          validationId: validation.id,
          deltaId,
          baseRevisionId: state.canonical.head.id,
          occurredAt,
          expectedDelta: proposalEvents[1].payload.delta,
        });
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail:
          "The evidence-bound reconciliation proposal is durable for human review; canonical worldstate is unchanged.",
      });
    } catch (error) {
      if (error instanceof ReconciliationRecoveryError) {
        this.surfaceReconciliationRecoveryFailure(error, "reconciliation");
        return;
      }
      if (error instanceof ReconciliationCompilationError) {
        this.surfaceReconciliationCompilationFailure(
          error,
          "reconciliation",
          "reconciliation_binding_rejected",
          "The reconciliation proposal no longer matches its durable evidence.",
        );
        return;
      }
      await this.surfaceWriteFailure(error, null, "reconciliation");
    }
  }

  async integrateActiveReconciliation(): Promise<void> {
    this.assertIdle();
    const { state } = this.requireLoaded();
    const deltaId = this.snapshot.activeReconciliationDeltaId;
    const projection = deltaId ? state.operational.deltas[deltaId] : undefined;

    if (
      !deltaId ||
      !projection ||
      projection.delta.purpose !== "reconciliation" ||
      projection.disposition !== "pending" ||
      this.snapshot.activeIntegratedRevisionId
    ) {
      throw new WorldstateSessionNotReadyError();
    }

    const occurredAt = this.dependencies.now();
    this.patch({
      persistenceState: "saving",
      persistenceDetail:
        "Saving the separate human integration decision as a canonical revision.",
      operationState: "integrating_result",
      error: null,
      retry: null,
    });

    try {
      const result =
        await this.appendReconciliationIntegrationWithConflictRecovery({
          deltaId,
          baseRevisionId: projection.delta.baseRevisionId,
          occurredAt,
        });
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail:
          "The reviewed result is integrated in a new canonical revision with its evidence lineage retained.",
      });
    } catch (error) {
      if (error instanceof ReconciliationRecoveryError) {
        this.surfaceReconciliationRecoveryFailure(error, "integration");
        return;
      }
      if (error instanceof ReconciliationCompilationError) {
        this.surfaceReconciliationCompilationFailure(
          error,
          "integration",
          "integration_gate_blocked",
          "The reconciliation proposal no longer matches its exact durable evidence.",
        );
        return;
      }
      await this.surfaceWriteFailure(error, null, "integration");
    }
  }

  async proposeActiveArtifactPromotion(): Promise<void> {
    this.assertIdle();
    const { state } = this.requireLoaded();
    const reconciliationDeltaId = this.snapshot.activeReconciliationDeltaId;
    const reconciliation = reconciliationDeltaId
      ? state.operational.deltas[reconciliationDeltaId]
      : undefined;
    if (
      !reconciliationDeltaId ||
      !reconciliation ||
      reconciliation.delta.purpose !== "reconciliation" ||
      reconciliation.disposition !== "accepted" ||
      reconciliation.acceptedRevisionId !== state.canonical.head.id ||
      this.snapshot.activeArtifactPromotionId
    ) {
      throw new WorldstateSessionNotReadyError();
    }

    let events: ReturnType<typeof artifactPromotionProposalEvents>;
    try {
      events = artifactPromotionProposalEvents({
        state,
        reconciliationDeltaId,
        sourceEventId: this.dependencies.nextId("event"),
        sourceCommandId: this.dependencies.nextId("command"),
        eventId: this.dependencies.nextId("event"),
        commandId: this.dependencies.nextId("command"),
        occurredAt: this.dependencies.now(),
        systemActor: HOME_MOVE_ACTORS.system,
      });
    } catch (error) {
      this.surfaceArtifactPromotionFailure(
        error,
        "artifact_promotion_binding_rejected",
        "The integrated live result could not be compiled into an exact artifact-promotion proposal.",
        false,
      );
      return;
    }

    this.patch({
      persistenceState: "saving",
      persistenceDetail:
        "Saving the signed-candidate promotion proposal without moving an authoritative ref.",
      operationState: "proposing_promotion",
      error: null,
      retry: null,
    });
    try {
      const result = await this.appendWithConflictRecovery(events);
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail:
          "The artifact-promotion proposal is durable for separate human review; no Git ref was moved.",
      });
    } catch (error) {
      if (error instanceof ArtifactPromotionCompilationError) {
        this.surfaceArtifactPromotionFailure(
          error,
          "artifact_promotion_binding_rejected",
          "The promotion proposal no longer matches current durable evidence.",
          false,
        );
        return;
      }
      await this.surfaceWriteFailure(error, null, "artifact_promotion");
    }
  }

  async promoteActiveArtifact(): Promise<void> {
    this.assertIdle();
    let loaded = this.requireLoaded();
    const promotionId = this.snapshot.activeArtifactPromotionId;
    let projection = promotionId
      ? loaded.state.operational.artifactPromotions[promotionId]
      : undefined;
    if (
      !promotionId ||
      !projection ||
      (projection.status !== "proposed" &&
        projection.status !== "authorized")
    ) {
      throw new WorldstateSessionNotReadyError();
    }
    if (!this.dependencies.artifactPromotionGateway) {
      this.surfaceArtifactPromotionFailure(
        new Error("The artifact-promotion gateway is unavailable."),
        "artifact_promotion_gateway_unavailable",
        "The artifact-promotion gateway is unavailable in this host.",
        false,
      );
      return;
    }

    if (projection.status === "proposed") {
      let authorizationEvents: ReturnType<
        typeof artifactPromotionAuthorizationEvents
      >;
      try {
        authorizationEvents = artifactPromotionAuthorizationEvents({
          state: loaded.state,
          promotionId,
          sourceEventId: this.dependencies.nextId("event"),
          sourceCommandId: this.dependencies.nextId("command"),
          authorizationEventId: this.dependencies.nextId("event"),
          authorizationCommandId: this.dependencies.nextId("command"),
          occurredAt: this.dependencies.now(),
          systemActor: HOME_MOVE_ACTORS.system,
          humanActor: HOME_MOVE_ACTORS.human,
        });
      } catch (error) {
        this.surfaceArtifactPromotionFailure(
          error,
          "artifact_promotion_authorization_rejected",
          "The current promotion proposal could not receive exact human authority.",
          false,
        );
        return;
      }

      this.patch({
        persistenceState: "saving",
        persistenceDetail:
          "Saving the exact promotion request and separate human authority before any Git ref update.",
        operationState: "authorizing_promotion",
        error: null,
        retry: null,
      });
      try {
        const result = await this.appendWithConflictRecovery(
          authorizationEvents,
        );
        this.installTransaction(result, activityFromLedger(result.ledger), {
          operationState: "promoting_artifact",
          persistenceDetail:
            "The exact promotion request is durable and human-authorized; the server is evaluating one target-ref CAS.",
        });
        loaded = this.requireLoaded();
        projection = loaded.state.operational.artifactPromotions[promotionId];
      } catch (error) {
        await this.surfaceWriteFailure(error, null, "artifact_promotion");
        return;
      }
    }

    if (projection?.status !== "authorized") {
      throw new WorldstateSessionNotReadyError();
    }

    // Re-read the shared durable ledger immediately before crossing the Git
    // boundary. Authorization reserves its semantic head in the kernel, so a
    // cooperating tab may append observations but cannot advance that head
    // until a terminal promotion outcome releases it.
    try {
      const durableDocument = await this.dependencies.store.get(
        HOME_MOVE_IDS.project,
      );
      if (!durableDocument) throw new WorldstateSessionNotReadyError();
      const fresh = loadedDocument(durableDocument);
      const freshProjection =
        fresh.state.operational.artifactPromotions[promotionId];
      if (
        freshProjection?.status === "promoted" ||
        freshProjection?.status === "stale" ||
        freshProjection?.status === "failed" ||
        freshProjection?.status === "outcome_unknown"
      ) {
        this.install(
          durableDocument,
          "saved",
          "A concurrent session already recorded the promotion outcome; no Git command was repeated.",
        );
        await this.recoverArtifactPromotionStatus(promotionId);
        return;
      }
      if (
        freshProjection?.status !== "authorized" ||
        fresh.state.canonical.head.id !==
          freshProjection.proposal.integratedRevisionId
      ) {
        this.install(
          durableDocument,
          "saved",
          "The durable promotion authority changed before the Git boundary.",
        );
        this.surfaceArtifactPromotionFailure(
          new Error(
            "The exact promotion authority is no longer current in shared durable state.",
          ),
          "artifact_promotion_authorization_stale",
          "The exact promotion authority is no longer current in shared durable state.",
          false,
        );
        return;
      }
      loaded = fresh;
      projection = freshProjection;
    } catch (error) {
      this.surfaceArtifactPromotionFailure(
        error,
        "artifact_promotion_preflight_unobserved",
        "Current shared durable promotion authority could not be observed immediately before the Git boundary.",
        true,
      );
      return;
    }

    this.patch({
      persistenceState: "saved",
      persistenceDetail:
        "The server is verifying private live-run evidence and independently revalidating the exact candidate before CAS.",
      operationState: "promoting_artifact",
      error: null,
      retry: null,
    });

    try {
      const response = await this.dependencies.artifactPromotionGateway({
        document: loaded.document,
        promotionId,
      });
      if (!response.ok) {
        this.surfaceArtifactPromotionFailure(
          new Error(response.error.message),
          response.error.code,
          response.error.message,
          response.error.code === "promotion_unavailable",
        );
        return;
      }
      if (response.status === "outcome_unknown") {
        const recovered = await this.recoverArtifactPromotionStatus(promotionId);
        if (recovered) return;
        this.surfaceArtifactPromotionFailure(
          new Error(
            "The promotion command could not establish a durable signed outcome.",
          ),
          "artifact_promotion_outcome_unknown",
          "The promotion command could not establish a durable signed outcome. The exact authority remains pending for read-only recovery or an explicit retry.",
          true,
        );
        return;
      }
      const attested = await this.recoverArtifactPromotionStatus(
        promotionId,
        response.receipt,
      );
      if (!attested) {
        this.surfaceArtifactPromotionFailure(
          new Error(
            "The completed command response was not re-attested by the read-only durable server journal.",
          ),
          "artifact_promotion_attestation_unobserved",
          "The completed command response was not re-attested by the read-only durable server journal, so no authoritative outcome was persisted or rendered.",
          true,
        );
      }
    } catch (error) {
      const recovered = await this.recoverArtifactPromotionStatus(promotionId);
      if (recovered) return;
      this.surfaceArtifactPromotionFailure(
        error,
        "artifact_promotion_transport_unobserved",
        "The promotion response was not observed. Durable server status did not establish an outcome, so no result was inferred and no automatic CAS retry occurred.",
        true,
      );
    }
  }

  private async recoverDurableLiveRunResponse(): Promise<void> {
    if (!this.dependencies.liveRunStatusGetter) return;
    const { ledger } = this.requireLoaded();
    const completedRequestIds = new Set<string>();
    const liveAttempts: CodexRunAttempt[] = [];

    for (const event of ledger.events) {
      if (event.type !== "source.captured") continue;
      const exchange = parseCodexRunExchangeSource(event.payload.source);
      if (exchange) completedRequestIds.add(exchange.request.requestId);
      const attempt = parseCodexRunAttemptSource(event.payload.source);
      if (attempt?.request.mode === "live") liveAttempts.push(attempt);
    }

    for (const attempt of liveAttempts) {
      const { request } = attempt;
      if (
        completedRequestIds.has(request.requestId) ||
        request.runId !== this.snapshot.activeRunId ||
        request.requestId !== this.snapshot.activeAgentRequestId
      ) {
        continue;
      }

      let durableStatus;
      try {
        durableStatus = await this.dependencies.liveRunStatusGetter({
          runId: request.runId,
          requestId: request.requestId,
        });
      } catch {
        continue;
      }

      if (durableStatus.status !== "completed" || !durableStatus.response) {
        this.patch({
          persistenceState: "saved",
          persistenceDetail:
            durableStatus.status === "in_progress"
              ? "The live dispatch is still in progress at the server boundary."
              : durableStatus.status === "outcome_unknown"
                ? "The live dispatch was claimed, but no exact response can be established; it will not be rerun."
                : "The exact live request is durable, but server dispatch has not started.",
          operationState: "idle",
          error: {
            code: `delegation_${durableStatus.status}`,
            message:
              durableStatus.status === "outcome_unknown"
                ? "The server cannot establish the live run outcome and refuses duplicate execution."
                : durableStatus.status === "in_progress"
                  ? "The server has not yet returned the exact live run response."
                  : "The live request awaits an explicit dispatch retry.",
            retryable: durableStatus.status !== "outcome_unknown",
            scope: "delegation",
          },
        });
        continue;
      }

      const occurredAt = this.dependencies.now();
      const exchange = codexRunExchangeSourceEvent({
        request,
        response: durableStatus.response,
        eventId: `event-codex-exchange:${request.requestId}`,
        commandId: `command-codex-exchange:${request.requestId}`,
        occurredAt,
        actor: HOME_MOVE_ACTORS.system,
      });
      this.patch({
        persistenceState: "saving",
        persistenceDetail:
          "Recovering the exact live response already durable at the server boundary.",
        operationState: "persisting_run_result",
        error: null,
      });
      try {
        const result = await this.appendWithConflictRecovery([exchange]);
        this.installTransaction(result, activityFromLedger(result.ledger), {
          operationState: "persisting_run_result",
          persistenceDetail:
            "The exact server-held live response is durable in the browser ledger; lifecycle normalization is in progress.",
        });
      } catch (error) {
        await this.surfaceWriteFailure(error, null, "delegation");
      }
    }
  }

  private async recoverDurableCodexNormalization(): Promise<void> {
    const pendingRunIds = Object.values(
      this.requireLoaded().state.operational.runs,
    )
      .filter(
        (projection) =>
          projection.status === "queued" ||
          projection.status === "received" ||
          projection.status === "working" ||
          projection.status === "blocked",
      )
      .map((projection) => projection.run.id);

    for (const runId of pendingRunIds) {
      const { ledger, state } = this.requireLoaded();
      const runProjection = state.operational.runs[runId];
      if (
        !runProjection ||
        (runProjection.status !== "queued" &&
          runProjection.status !== "received" &&
          runProjection.status !== "working" &&
          runProjection.status !== "blocked")
      ) {
        continue;
      }
      const run = runProjection.run;
      const brief = state.operational.briefs[run.briefId];
      if (!brief) continue;

      let exchangeRecord: {
        readonly event: LedgerEvent;
        readonly exchange: CodexRunExchange;
      } | null = null;
      let failure: CodexRunNormalizationFailure | null = null;

      for (const event of ledger.events) {
        if (event.type !== "source.captured") continue;
        const exchange = parseCodexRunExchangeSource(event.payload.source);
        if (exchange?.request.runId === run.id) {
          exchangeRecord = { event, exchange };
        }
        const candidateFailure = parseCodexRunNormalizationFailureSource(
          event.payload.source,
        );
        if (
          candidateFailure?.runId === run.id &&
          candidateFailure.briefId === brief.id
        ) {
          failure = candidateFailure;
        }
      }

      if (!exchangeRecord) continue;
      const { request, response } = exchangeRecord.exchange;
      if (failure?.requestId === request.requestId) {
        await this.persistRecoveredNormalizationOutcome({
          run,
          request,
          failure,
        });
        continue;
      }

      let attempt: CodexRunAttempt | null = null;
      for (const event of ledger.events) {
        if (event.type !== "source.captured") continue;
        const candidate = parseCodexRunAttemptSource(event.payload.source);
        if (
          candidate?.request.runId === run.id &&
          candidate.request.requestId === request.requestId
        ) {
          attempt = candidate;
        }
      }

      let normalizedEvents: NonEmptyLedgerEvents;
      try {
        if (
          !attempt ||
          stableStringify(attempt.request) !== stableStringify(request)
        ) {
          throw new Error(
            "The exact response request does not match its durable dispatch attempt.",
          );
        }
        const [, ...events] = codexRunResponseEvents({
          run,
          brief,
          request,
          response,
          recordedAt: exchangeRecord.event.occurredAt,
          systemActor: HOME_MOVE_ACTORS.system,
        });
        const alreadyObservedIndex =
          runProjection.status === "queued"
            ? -1
            : events.findLastIndex(
                (event) =>
                  event.type === "run.lifecycle_recorded" &&
                  event.payload.status === runProjection.status,
              );
        if (runProjection.status !== "queued" && alreadyObservedIndex === -1) {
          throw new Error(
            `Durable run status ${runProjection.status} does not occur in the exact response lifecycle.`,
          );
        }
        const remaining = events.slice(alreadyObservedIndex + 1);
        const [firstEvent, ...remainingEvents] = remaining;
        if (!firstEvent) {
          if (runProjection.status === "queued") {
            throw new Error(
              "The replay response produced no lifecycle evidence.",
            );
          }
          continue;
        }
        normalizedEvents = [firstEvent, ...remainingEvents];
      } catch (error) {
        await this.persistDelegationNormalizationFailure({
          run,
          request,
          code: "coherence_rejected",
          error,
        });
        continue;
      }

      this.patch({
        persistenceState: "saving",
        persistenceDetail:
          "Recovering lifecycle from an exact response that was already durable.",
        operationState: "persisting_run_result",
      });

      try {
        const result = await this.appendWithConflictRecovery(normalizedEvents);
        this.installTransaction(result, activityFromLedger(result.ledger), {
          persistenceDetail:
            "The durable replay response was normalized after reload without redispatch.",
        });
      } catch (error) {
        await this.persistDelegationNormalizationFailure({
          run,
          request,
          code: "state_conflict",
          error,
        });
      }
    }
  }

  private async recoverDurableReplayEvidenceValidation(): Promise<void> {
    const { ledger } = this.requireLoaded();
    const exchanges: Array<{
      readonly event: Extract<LedgerEvent, { type: "source.captured" }>;
      readonly exchange: ReplayEvidenceValidationExchange;
    }> = [];
    const attempts = new Map<string, ReplayEvidenceRequest>();

    for (const event of ledger.events) {
      if (event.type !== "source.captured") continue;
      const attempt = parseReplayEvidenceValidationAttemptSource(
        event.payload.source,
      );
      if (attempt) {
        attempts.set(attempt.request.validationRequestId, attempt.request);
      }
      const exchange = parseReplayEvidenceValidationExchangeSource(
        event.payload.source,
      );
      if (exchange) exchanges.push({ event, exchange });
    }

    for (const recorded of exchanges) {
      const { request, response } = recorded.exchange;
      const { state } = this.requireLoaded();
      if (!response.ok || state.operational.validations[request.validationId]) {
        continue;
      }
      const attempt = attempts.get(request.validationRequestId);
      if (!attempt || stableStringify(attempt) !== stableStringify(request)) {
        continue;
      }

      this.patch({
        persistenceState: "saving",
        persistenceDetail:
          "Recovering validation from an exact verifier response that is already durable.",
        operationState: "persisting_validation",
      });
      try {
        const result =
          await this.appendReplayEvidenceValidationWithConflictRecovery({
            request,
            response,
            eventId: `event-evidence-validation:${request.validationId}`,
            commandId: `command-evidence-validation:${request.validationId}`,
            occurredAt: recorded.event.occurredAt,
            actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
          });
        this.installTransaction(result, activityFromLedger(result.ledger), {
          persistenceDetail:
            "The durable verifier response was normalized after reload without rerunning verification.",
        });
      } catch (error) {
        if (error instanceof ReplayEvidenceValidationCoherenceError) {
          this.patch({
            persistenceState: "saved",
            persistenceDetail:
              "A durable verifier response could not be normalized after reload.",
            operationState: "idle",
            error: {
              code: "validation_coherence_rejected",
              message: errorMessage(
                error,
                "The durable verifier response did not match current replay evidence.",
              ),
              retryable: false,
              scope: "validation",
            },
          });
          continue;
        }
        await this.surfaceWriteFailure(error, null, "validation");
      }
    }
  }

  private async recoverDurableLiveEvidenceValidation(): Promise<void> {
    const { ledger } = this.requireLoaded();
    const exchanges: Array<{
      readonly event: Extract<LedgerEvent, { type: "source.captured" }>;
      readonly exchange: LiveEvidenceValidationExchange;
    }> = [];
    const attempts = new Map<string, LiveEvidenceRequest>();

    for (const event of ledger.events) {
      if (event.type !== "source.captured") continue;
      const attempt = parseLiveEvidenceValidationAttemptSource(
        event.payload.source,
      );
      if (attempt) {
        attempts.set(attempt.request.validationRequestId, attempt.request);
      }
      const exchange = parseLiveEvidenceValidationExchangeSource(
        event.payload.source,
      );
      if (exchange) exchanges.push({ event, exchange });
    }

    for (const recorded of exchanges) {
      const { request, response } = recorded.exchange;
      const { state } = this.requireLoaded();
      if (!response.ok || state.operational.validations[request.validationId]) {
        continue;
      }
      const attempt = attempts.get(request.validationRequestId);
      if (!attempt || stableStringify(attempt) !== stableStringify(request)) {
        continue;
      }

      this.patch({
        persistenceState: "saving",
        persistenceDetail:
          "Recovering live-candidate validation from an exact verifier response that is already durable.",
        operationState: "persisting_validation",
      });
      try {
        const result =
          await this.appendLiveEvidenceValidationWithConflictRecovery({
            request,
            response,
            eventId: `event-evidence-validation:${request.validationId}`,
            commandId: `command-evidence-validation:${request.validationId}`,
            occurredAt: recorded.event.occurredAt,
            actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
          });
        this.installTransaction(result, activityFromLedger(result.ledger), {
          persistenceDetail:
            "The durable live-candidate verifier response was normalized after reload without rerunning verification.",
        });
      } catch (error) {
        if (error instanceof LiveEvidenceValidationCoherenceError) {
          this.patch({
            persistenceState: "saved",
            persistenceDetail:
              "A durable live-candidate verifier response could not be normalized after reload.",
            operationState: "idle",
            error: {
              code: "validation_coherence_rejected",
              message: errorMessage(
                error,
                "The durable verifier response did not match current live-candidate evidence.",
              ),
              retryable: false,
              scope: "validation",
            },
          });
          continue;
        }
        await this.surfaceWriteFailure(error, null, "validation");
      }
    }
  }

  private async persistArtifactPromotionReceipt(input: {
    readonly promotionId: string;
    readonly receipt: ArtifactPromotionReceipt;
    readonly recovery: boolean;
  }): Promise<void> {
    const { state } = this.requireLoaded();
    const projection = state.operational.artifactPromotions[input.promotionId];
    if (
      projection?.status === "promoted" ||
      projection?.status === "stale" ||
      projection?.status === "failed" ||
      projection?.status === "outcome_unknown"
    ) {
      return;
    }
    if (projection?.status !== "authorized") {
      throw new WorldstateSessionNotReadyError();
    }

    const occurredAt = this.dependencies.now();
    const events = artifactPromotionOutcomeEvents({
      state,
      promotionId: input.promotionId,
      receipt: input.receipt,
      sourceEventId: `event-artifact-promotion-response:${input.promotionId}`,
      sourceCommandId: `command-artifact-promotion-response:${input.promotionId}`,
      outcomeEventId: `event-artifact-promotion-outcome:${input.promotionId}`,
      outcomeCommandId: `command-artifact-promotion-outcome:${input.promotionId}`,
      occurredAt,
      systemActor: HOME_MOVE_ACTORS.system,
    });
    this.patch({
      persistenceState: "saving",
      persistenceDetail: input.recovery
        ? "Saving the exact signed promotion outcome recovered from the read-only server journal."
        : "Saving the exact signed promotion outcome before rendering authoritative status.",
      operationState: "persisting_promotion_receipt",
      error: null,
      retry: null,
    });
    try {
      const result = await this.appendWithConflictRecovery(events);
      const outcome =
        result.state.operational.artifactPromotions[input.promotionId]?.status;
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail:
          outcome === "promoted"
            ? "The signed receipt durably records that the authoritative target ref was observed at the exact reviewed candidate."
            : "The signed promotion outcome is durable; no authoritative success was inferred.",
      });
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "artifact_promotion");
    }
  }

  private async recoverArtifactPromotionStatus(
    promotionId: string,
    expectedReceipt?: ArtifactPromotionReceipt,
  ): Promise<boolean> {
    if (!this.dependencies.artifactPromotionStatusGetter) return false;
    const loaded = this.requireLoaded();
    try {
      const response = await this.dependencies.artifactPromotionStatusGetter({
        document: loaded.document,
        promotionId,
      });
      if (!response.ok || response.status !== "completed" || !response.receipt) {
        return false;
      }
      if (
        expectedReceipt &&
        stableStringify(expectedReceipt) !== stableStringify(response.receipt)
      ) {
        return false;
      }
      const projection =
        this.requireLoaded().state.operational.artifactPromotions[promotionId];
      if (
        projection?.status === "promoted" ||
        projection?.status === "stale" ||
        projection?.status === "failed" ||
        projection?.status === "outcome_unknown"
      ) {
        const source = projection.latestOutcome
          ? this.requireLoaded().state.operational.sources[
              projection.latestOutcome.responseSourceId
            ]
          : undefined;
        const recorded = source
          ? parseArtifactPromotionResponseSource(source)?.receipt
          : null;
        if (
          !recorded ||
          stableStringify(recorded) !== stableStringify(response.receipt)
        ) {
          return false;
        }
      } else {
        await this.persistArtifactPromotionReceipt({
          promotionId,
          receipt: response.receipt,
          recovery: true,
        });
        const persisted =
          this.requireLoaded().state.operational.artifactPromotions[promotionId];
        const source = persisted?.latestOutcome
          ? this.requireLoaded().state.operational.sources[
              persisted.latestOutcome.responseSourceId
            ]
          : undefined;
        const recorded = source
          ? parseArtifactPromotionResponseSource(source)?.receipt
          : null;
        if (
          !recorded ||
          stableStringify(recorded) !== stableStringify(response.receipt)
        ) {
          return false;
        }
      }
      const receiptDigest = artifactPromotionReceiptDigest(response.receipt);
      this.patch({
        hostAttestedArtifactPromotionReceiptDigests: {
          ...(this.snapshot.hostAttestedArtifactPromotionReceiptDigests ?? {}),
          [promotionId]: receiptDigest,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async recoverDurableArtifactPromotions(): Promise<void> {
    if (!this.dependencies.artifactPromotionStatusGetter) return;
    const observable = Object.values(
      this.requireLoaded().state.operational.artifactPromotions,
    ).filter((projection) => projection.status !== "proposed");
    for (const projection of observable) {
      await this.recoverArtifactPromotionStatus(projection.proposal.id);
    }
  }

  private surfaceArtifactPromotionFailure(
    error: unknown,
    code: string,
    fallback: string,
    retryable: boolean,
  ): void {
    this.patch({
      persistenceState: "saved",
      persistenceDetail:
        "The reviewed candidate and any durable promotion authority remain inspectable; no authoritative success was inferred.",
      operationState: "idle",
      error: {
        code,
        message: errorMessage(error, fallback),
        retryable,
        scope: "artifact_promotion",
      },
      retry: null,
    });
  }

  async resetSandbox(): Promise<void> {
    this.assertIdle();
    const { state } = this.requireLoaded();
    const attestations =
      this.snapshot.hostAttestedArtifactPromotionReceiptDigests ?? {};
    const resetBlock = Object.values(
      state.operational.artifactPromotions,
    ).map((promotion) => {
      if (
        promotion.status === "authorized" ||
        promotion.status === "outcome_unknown"
      ) {
        return { promotion, reason: "recovery_required" as const };
      }
      if (
        promotion.status !== "promoted" &&
        promotion.status !== "stale" &&
        promotion.status !== "failed"
      ) {
        return null;
      }
      const source = promotion.latestOutcome
        ? state.operational.sources[promotion.latestOutcome.responseSourceId]
        : undefined;
      const receipt = source
        ? parseArtifactPromotionResponseSource(source)?.receipt
        : null;
      const receiptDigest = receipt
        ? artifactPromotionReceiptDigest(receipt)
        : null;
      return receiptDigest &&
        attestations[promotion.proposal.id] === receiptDigest
        ? null
        : { promotion, reason: "terminal_unattested" as const };
    }).find((block) => block !== null);
    if (resetBlock) {
      const terminalUnattested = resetBlock.reason === "terminal_unattested";
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          terminalUnattested
            ? "Sandbox reset is blocked because a terminal promotion receipt lacks exact ephemeral host attestation. Reset never reverses a Git ref operation."
            : "Sandbox reset is blocked while private promotion recovery may still be required. Reset never reverses a Git ref operation.",
        operationState: "idle",
        error: {
          code: terminalUnattested
            ? "artifact_promotion_terminal_unattested"
            : "artifact_promotion_reservation_active",
          message: terminalUnattested
            ? `Promotion ${resetBlock.promotion.proposal.id} must be re-attested by the host before the browser ledger can be reset.`
            : `Promotion ${resetBlock.promotion.proposal.id} must be reconciled before the browser ledger can be reset.`,
          retryable: terminalUnattested,
          scope: "reset",
        },
        retry: null,
      });
      return;
    }
    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Resetting the local sandbox.",
      operationState: "resetting",
      error: null,
      retry: null,
    });

    try {
      const fixture = createHomeMoveSeedFixture();
      const document = worldstateLedgerDocument({
        ledger: fixture.ledger,
        projectLabel: PROJECT_LABEL,
        updatedAt: this.dependencies.now(),
      });
      await this.dependencies.store.replace(document, this.snapshot.version);
      this.patch({ hostAttestedArtifactPromotionReceiptDigests: {} });
      this.install(document, "saved", "Sandbox ledger reset.");
    } catch (error) {
      await this.surfaceResetFailure(error);
    }
  }

  private async persistUnplacedSource(input: {
    readonly sourceEvent: LedgerEvent;
    readonly sourceId: string;
    readonly error: unknown;
  }): Promise<void> {
    const retry: WorldstateSessionRetry = {
      operation: "placement",
      sourceId: input.sourceId,
      selectedNodeId: HOME_MOVE_IDS.budget,
    };
    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the captured source.",
      operationState: "capturing",
      error: null,
      retry: null,
    });

    try {
      const result = await this.append([input.sourceEvent]);
      this.installTransaction(
        result,
        {
          activeSourceId: input.sourceId,
          activeRequestId: null,
          activeDeltaId: null,
          error: {
            code: "placement_request_invalid",
            message: errorMessage(
              input.error,
              "The placement request is invalid.",
            ),
            retryable: true,
            scope: "placement",
          },
          retry,
        },
        {
          persistenceDetail:
            "The source is durable, but the placement request was invalid.",
        },
      );
    } catch (writeError) {
      await this.surfaceWriteFailure(writeError, null, "placement");
    }
  }

  private async placeCapturedSource(
    sourceId: string,
    selectedNodeId: string,
  ): Promise<void> {
    const { state } = this.requireLoaded();
    const requestId = this.dependencies.nextId("request");
    let request: PlacementRequest;

    try {
      request = compilePlacementRequest({
        state,
        sourceId,
        requestId,
        scopeId: HOME_MOVE_IDS.project,
        projectId: HOME_MOVE_IDS.projectNode,
        selectedNodeId,
      });
    } catch (error) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The source is saved, but placement could not start.",
        operationState: "idle",
        activeSourceId: sourceId,
        activeRequestId: requestId,
        activeDeltaId: null,
        error: {
          code: "placement_request_invalid",
          message: errorMessage(error, "The placement request is invalid."),
          retryable: false,
          scope: "placement",
        },
        retry: null,
      });
      return;
    }

    const attempt = placementAttemptSourceEvent({
      request,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
    });
    const retry: WorldstateSessionRetry = {
      operation: "placement",
      sourceId,
      selectedNodeId,
    };

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the exact placement retry request.",
      operationState: "placing",
      activeSourceId: sourceId,
      activeRequestId: requestId,
      activeDeltaId: null,
      error: null,
      retry: null,
    });

    try {
      const result = await this.append([attempt]);
      this.installTransaction(
        result,
        {
          activeSourceId: sourceId,
          activeRequestId: requestId,
          activeDeltaId: null,
          error: null,
          retry,
        },
        {
          operationState: "placing",
          persistenceDetail:
            "The exact placement retry request is durable; placement is in progress.",
        },
      );
    } catch (error) {
      await this.surfaceWriteFailure(error, retry, "placement");
      return;
    }

    await this.requestPlacement(request, selectedNodeId);
  }

  private async requestPlacement(
    request: PlacementRequest,
    selectedNodeId: string,
  ): Promise<void> {
    const sourceId = request.source.sourceId;
    const requestId = request.requestId;

    let response: PlacementResponse;
    try {
      response = PlacementResponseSchema.parse(
        await this.dependencies.placementGateway(request),
      );
    } catch (error) {
      await this.persistNetworkFailure({
        sourceId,
        requestId,
        selectedNodeId,
        message: errorMessage(
          error,
          "The placement gateway failed before returning a response.",
        ),
      });
      return;
    }

    const exchangeSourceId = placementExchangeSourceId(requestId);
    const exchange = placementExchangeSourceEvent({
      request,
      response,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
    });
    const events: LedgerEvent[] = [exchange];
    let deltaId: string | null = null;
    let surfacedError: WorldstateSessionError | null = null;
    let retry: WorldstateSessionRetry | null = null;

    if (!response.ok) {
      surfacedError = {
        code: response.error.code,
        message: response.error.message,
        retryable: response.error.retryable,
        scope: "placement",
      };
      retry = response.error.retryable
        ? { operation: "placement", sourceId, selectedNodeId }
        : null;
      events.push(
        this.failureEvent({
          sourceId,
          code: response.error.code,
          message: response.error.message,
          retriable: response.error.retryable,
        }),
      );
    } else {
      try {
        assertPlacementResponseMatchesRequest(request, response);
        const delta = placementResponseToKernelDelta(response, {
          evidenceSourceId: exchangeSourceId,
        });
        if (delta) {
          const proposed = deltaProposedEvent({
            eventId: this.dependencies.nextId("event"),
            commandId: this.dependencies.nextId("command"),
            occurredAt: this.dependencies.now(),
            actor: HOME_MOVE_ACTORS.manager,
            payload: { delta },
          });
          const ledgerWithExchange = appendLedgerEvent(
            this.requireLoaded().ledger,
            exchange,
          ).ledger;
          appendLedgerEvent(ledgerWithExchange, proposed);
          deltaId = delta.id;
          events.push(proposed);
        }
      } catch (error) {
        const responseMismatch =
          error instanceof PlacementResponseCoherenceError;
        surfacedError = {
          code: responseMismatch
            ? "placement_response_mismatch"
            : "placement_conversion_failed",
          message: errorMessage(
            error,
            responseMismatch
              ? "The placement response did not match its exact request."
              : "The placement response could not be converted into a pending delta.",
          ),
          retryable: true,
          scope: "placement",
        };
        retry = { operation: "placement", sourceId, selectedNodeId };
        events.push(
          this.failureEvent({
            sourceId,
            code: surfacedError.code,
            message: surfacedError.message,
            retriable: true,
          }),
        );
      }
    }

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the exact placement result.",
      operationState: "persisting_placement",
    });

    try {
      const [firstEvent, ...remainingEvents] = events;
      if (!firstEvent) {
        throw new Error("A placement result must persist at least one event.");
      }
      const result = await this.append([firstEvent, ...remainingEvents]);
      this.installTransaction(result, {
        activeSourceId: sourceId,
        activeRequestId: requestId,
        activeDeltaId: deltaId,
        error: surfacedError,
        retry,
      });
    } catch (error) {
      await this.surfaceWriteFailure(
        error,
        {
          operation: "placement",
          sourceId,
          selectedNodeId,
        },
        "placement",
      );
    }
  }

  private async persistNetworkFailure(input: {
    readonly sourceId: string;
    readonly requestId: string;
    readonly selectedNodeId: string;
    readonly message: string;
  }): Promise<void> {
    const error: WorldstateSessionError = {
      code: "placement_gateway_failed",
      message: input.message,
      retryable: true,
      scope: "placement",
    };
    const retry: WorldstateSessionRetry = {
      operation: "placement",
      sourceId: input.sourceId,
      selectedNodeId: input.selectedNodeId,
    };

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the placement failure.",
      operationState: "persisting_placement",
      activeSourceId: input.sourceId,
      activeRequestId: input.requestId,
      activeDeltaId: null,
    });

    try {
      const result = await this.append([
        this.failureEvent({
          sourceId: input.sourceId,
          code: error.code,
          message: error.message,
          retriable: true,
        }),
      ]);
      this.installTransaction(result, {
        activeSourceId: input.sourceId,
        activeRequestId: input.requestId,
        activeDeltaId: null,
        error,
        retry,
      });
    } catch (writeError) {
      await this.surfaceWriteFailure(writeError, retry, "placement");
    }
  }

  private failureEvent(input: {
    readonly sourceId: string;
    readonly code: string;
    readonly message: string;
    readonly retriable: boolean;
  }): LedgerEvent {
    return createLedgerEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.manager,
      type: "manager.failure_recorded",
      payload: input,
    });
  }

  private async persistRecoveredNormalizationOutcome(input: {
    readonly run: AgentRun;
    readonly request: AgentRunRequest;
    readonly failure: CodexRunNormalizationFailure;
  }): Promise<void> {
    const runProjection =
      this.requireLoaded().state.operational.runs[input.run.id];
    if (
      !runProjection ||
      (runProjection.status !== "queued" &&
        runProjection.status !== "received" &&
        runProjection.status !== "working" &&
        runProjection.status !== "blocked")
    ) {
      return;
    }

    const outcomeUnknown = runLifecycleEvent({
      eventId: `event-codex-normalization-outcome:${input.request.requestId}:${input.failure.code}`,
      commandId: `command-codex-normalization-outcome:${input.request.requestId}:${input.failure.code}`,
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
      payload: {
        runId: input.run.id,
        status: "outcome_unknown",
        message: input.failure.message,
        evidenceRefs: [
          codexRunExchangeSourceId(input.request.requestId),
          codexRunNormalizationFailureSourceId(
            input.request.requestId,
            input.failure.code,
          ),
        ],
      },
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail:
        "Completing an interrupted unknown-outcome transition from durable evidence.",
      operationState: "persisting_run_result",
    });

    try {
      const result = await this.appendWithConflictRecovery([outcomeUnknown]);
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail:
          "The interrupted normalization failure was recovered without redispatch.",
      });
    } catch (error) {
      const current = await this.dependencies.store.get(HOME_MOVE_IDS.project);
      if (current) {
        const loaded = loadedDocument(current);
        const reloadedRun = loaded.state.operational.runs[input.run.id];
        if (
          reloadedRun?.status === "outcome_unknown" ||
          reloadedRun?.status === "returned" ||
          reloadedRun?.status === "failed" ||
          reloadedRun?.status === "cancelled"
        ) {
          this.install(
            current,
            "saved",
            "Concurrent terminal run evidence was retained during reload recovery.",
          );
          return;
        }
      }
      await this.surfaceWriteFailure(error, null, "delegation");
    }
  }

  private async persistDelegationNormalizationFailure(input: {
    readonly run: AgentRun;
    readonly request: AgentRunRequest;
    readonly code: "coherence_rejected" | "state_conflict";
    readonly error: unknown;
  }): Promise<void> {
    const message = errorMessage(
      input.error,
      input.code === "coherence_rejected"
        ? "The replay response did not match its authorized run."
        : "The replay response could not be normalized against the current ledger state.",
    );
    const failure = codexRunNormalizationFailureSourceEvent({
      requestId: input.request.requestId,
      runId: input.run.id,
      briefId: input.run.briefId,
      code: input.code,
      message,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail:
        "Saving the replay normalization failure independently of run state.",
      operationState: "persisting_run_result",
    });

    let failureResult: WorldstateLedgerTransactionResult;
    try {
      failureResult = await this.appendWithConflictRecovery([failure]);
      this.installTransaction(
        failureResult,
        activityFromLedger(failureResult.ledger),
        {
          operationState: "persisting_run_result",
          persistenceDetail:
            "The exact response and normalization failure are durable; recording the unknown outcome.",
        },
      );
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "delegation");
      return;
    }

    const currentRun = failureResult.state.operational.runs[input.run.id];
    const canRecordUnknown =
      currentRun?.status === "queued" ||
      currentRun?.status === "received" ||
      currentRun?.status === "working" ||
      currentRun?.status === "blocked";

    if (!canRecordUnknown) {
      this.installTransaction(
        failureResult,
        activityFromLedger(failureResult.ledger),
        {
          persistenceDetail:
            "The exact response and normalization failure are durable; the run already has a terminal ledger state.",
        },
      );
      return;
    }

    const outcomeUnknown = runLifecycleEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
      payload: {
        runId: input.run.id,
        status: "outcome_unknown",
        message,
        evidenceRefs: [
          codexRunExchangeSourceId(input.request.requestId),
          codexRunNormalizationFailureSourceId(
            input.request.requestId,
            input.code,
          ),
        ],
      },
    });

    try {
      const result = await this.appendWithConflictRecovery([outcomeUnknown]);
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail:
          "The exact replay response is durable, but its normalized outcome remains unknown.",
      });
    } catch (error) {
      const current = await this.dependencies.store.get(HOME_MOVE_IDS.project);
      if (current) {
        const loaded = loadedDocument(current);
        const reloadedRun = loaded.state.operational.runs[input.run.id];
        if (
          reloadedRun?.status === "outcome_unknown" ||
          reloadedRun?.status === "returned" ||
          reloadedRun?.status === "failed" ||
          reloadedRun?.status === "cancelled"
        ) {
          this.install(
            current,
            "saved",
            "The exact response and normalization failure are durable; concurrent terminal run evidence was retained.",
          );
          return;
        }
      }
      await this.surfaceWriteFailure(error, null, "delegation");
    }
  }

  private async persistDelegationGatewayFailure(input: {
    readonly run: AgentRun;
    readonly request: AgentRunRequest;
    readonly error: unknown;
  }): Promise<void> {
    const matchingBrowserError =
      input.error instanceof BrowserAgentGatewayError &&
      input.error.requestId === input.request.requestId &&
      input.error.runId === input.run.id
        ? input.error
        : null;
    const parsedBrowserObservation = matchingBrowserError
      ? CodexTransportObservationSchema.safeParse({
          kind: "odeu.codex-transport-observation",
          version: 1,
          requestId: matchingBrowserError.requestId,
          runId: matchingBrowserError.runId,
          outcome: matchingBrowserError.outcome,
          httpStatus: matchingBrowserError.httpStatus,
          contentType: matchingBrowserError.contentType,
          bodyExcerpt: matchingBrowserError.bodyExcerpt,
          bodyTruncated: matchingBrowserError.bodyTruncated,
          bodyDigest: matchingBrowserError.bodyDigest,
        })
      : null;
    const observation: CodexTransportObservationInput =
      parsedBrowserObservation?.success === true
        ? {
            requestId: parsedBrowserObservation.data.requestId,
            runId: parsedBrowserObservation.data.runId,
            outcome: parsedBrowserObservation.data.outcome,
            httpStatus: parsedBrowserObservation.data.httpStatus,
            contentType: parsedBrowserObservation.data.contentType,
            bodyExcerpt: parsedBrowserObservation.data.bodyExcerpt,
            bodyTruncated: parsedBrowserObservation.data.bodyTruncated,
            bodyDigest: parsedBrowserObservation.data.bodyDigest,
          }
        : {
            requestId: input.request.requestId,
            runId: input.run.id,
            outcome: "transport_failed",
            httpStatus: null,
            contentType: null,
            bodyExcerpt: null,
            bodyTruncated: false,
            bodyDigest: null,
          };
    const rawMessage = errorMessage(
      input.error,
      "the agent gateway failed before a valid response was observed",
    );
    const message =
      rawMessage.length <= 2_000
        ? rawMessage
        : `${rawMessage.slice(0, 1_999)}…`;
    const transportEvidence = codexTransportObservationSourceEvent({
      observation,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      systemActor: HOME_MOVE_ACTORS.system,
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail: `Saving the bounded ${input.run.mode} transport observation.`,
      operationState: "persisting_run_result",
    });

    let evidenceResult: WorldstateLedgerTransactionResult;
    try {
      evidenceResult = await this.appendWithConflictRecovery([
        transportEvidence,
      ]);
      this.installTransaction(
        evidenceResult,
        activityFromLedger(evidenceResult.ledger),
        {
          operationState: "persisting_run_result",
          persistenceDetail:
            "The bounded transport observation is durable; recording the unknown worker outcome.",
        },
      );
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "delegation");
      return;
    }

    const currentRun = evidenceResult.state.operational.runs[input.run.id];
    if (
      !currentRun ||
      currentRun.status === "outcome_unknown" ||
      currentRun.status === "returned" ||
      currentRun.status === "failed" ||
      currentRun.status === "cancelled"
    ) {
      this.installTransaction(
        evidenceResult,
        activityFromLedger(evidenceResult.ledger),
        {
          persistenceDetail:
            "The bounded transport observation is durable; the run already has a terminal ledger state.",
        },
      );
      return;
    }

    if (input.run.mode === "live") {
      if (!this.dependencies.liveRunStatusGetter) {
        this.installTransaction(
          evidenceResult,
          activityFromLedger(evidenceResult.ledger),
          {
            persistenceDetail:
              "The signed live request and bounded transport observation are durable; no server status reader is available, so the run was not redispatched or declared terminal.",
          },
        );
        return;
      }

      let durableStatus;
      try {
        durableStatus = await this.dependencies.liveRunStatusGetter({
          runId: input.run.id,
          requestId: input.request.requestId,
        });
      } catch {
        this.installTransaction(
          evidenceResult,
          activityFromLedger(evidenceResult.ledger),
          {
            persistenceDetail:
              "The signed live request and transport observation are durable; server status could not be observed, so no terminal outcome was inferred.",
          },
        );
        return;
      }

      if (durableStatus.status === "completed" && durableStatus.response) {
        const exchange = codexRunExchangeSourceEvent({
          request: input.request,
          response: durableStatus.response,
          eventId: `event-codex-exchange:${input.request.requestId}`,
          commandId: `command-codex-exchange:${input.request.requestId}`,
          occurredAt: this.dependencies.now(),
          actor: HOME_MOVE_ACTORS.system,
        });
        try {
          const recovered = await this.appendWithConflictRecovery([exchange]);
          this.installTransaction(
            recovered,
            activityFromLedger(recovered.ledger),
            {
              operationState: "persisting_run_result",
              persistenceDetail:
                "The exact server-held live response was recovered after transport loss; lifecycle normalization is in progress.",
            },
          );
          await this.recoverDurableCodexNormalization();
        } catch (error) {
          await this.surfaceWriteFailure(error, null, "delegation");
        }
        return;
      }

      if (durableStatus.status !== "outcome_unknown") {
        const durableActivity = activityFromLedger(evidenceResult.ledger);
        this.installTransaction(
          evidenceResult,
          {
            ...durableActivity,
            error: {
              code: `delegation_${durableStatus.status}`,
              message:
                durableStatus.status === "in_progress"
                  ? "The server has not yet returned the exact live run response."
                  : "The live request awaits an explicit dispatch retry.",
              retryable: true,
              scope: "delegation",
            },
          },
          {
            persistenceDetail:
              durableStatus.status === "in_progress"
                ? "The live request is durable and server execution is still in progress; no terminal outcome was inferred."
                : "The signed live request is durable but server dispatch has not started; no duplicate dispatch was attempted.",
          },
        );
        return;
      }
    }

    const outcomeUnknown = runLifecycleEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
      payload: {
        runId: input.run.id,
        status: "outcome_unknown",
        message:
          input.run.mode === "live"
            ? `The server reported an unknown live execution outcome: ${message}`
            : `No valid fixture replay response was observed: ${message}`,
        evidenceRefs: [
          codexRunAttemptSourceId(input.request.requestId),
          codexTransportObservationSourceId(input.request.requestId),
        ],
      },
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail: `Saving the unknown ${input.run.mode} boundary outcome.`,
      operationState: "persisting_run_result",
    });

    try {
      const result = await this.appendWithConflictRecovery([outcomeUnknown]);
      this.installTransaction(result, activityFromLedger(result.ledger), {
        persistenceDetail: `The ${input.run.mode} request remains durable, but no valid response was observed.`,
      });
    } catch (error) {
      const current = await this.dependencies.store.get(HOME_MOVE_IDS.project);
      if (current) {
        const loaded = loadedDocument(current);
        const reloadedRun = loaded.state.operational.runs[input.run.id];
        if (
          reloadedRun?.status === "outcome_unknown" ||
          reloadedRun?.status === "returned" ||
          reloadedRun?.status === "failed" ||
          reloadedRun?.status === "cancelled"
        ) {
          this.install(
            current,
            "saved",
            "The bounded transport observation is durable; concurrent terminal run evidence was retained.",
          );
          return;
        }
      }
      await this.surfaceWriteFailure(error, null, "delegation");
    }
  }

  private append(
    events: NonEmptyLedgerEvents,
  ): Promise<WorldstateLedgerTransactionResult> {
    const { document, version } = this.requireLoaded();
    return this.transaction.append({
      current: { document, expectedVersion: version },
      events,
    });
  }

  private async appendReconciliationProposalWithConflictRecovery(input: {
    readonly closureId: string;
    readonly validationId: string;
    readonly deltaId: string;
    readonly baseRevisionId: string;
    readonly occurredAt: string;
    readonly expectedDelta: WorldstateDelta;
  }): Promise<WorldstateLedgerTransactionResult> {
    let current = this.requireLoaded();
    let lastConflict: LedgerConflictError | null = null;

    for (
      let attempt = 0;
      attempt < MAX_LEDGER_CONFLICT_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      if (hasEquivalentReconciliationProposal(current, input.expectedDelta)) {
        const projection = current.state.operational.deltas[input.deltaId];
        return transactionResultFromLoaded(current, [
          projection?.proposedEventId ??
            `event-result-reconciliation-proposed:${input.deltaId}`,
        ]);
      }

      const competing = Object.values(current.state.operational.deltas).find(
        (projection) =>
          projection.delta.purpose === "reconciliation" &&
          projection.delta.closureRef === input.closureId,
      );
      if (competing) {
        throw new ReconciliationRecoveryError(
          "reconciliation_conflict",
          `Closure ${input.closureId} already has reconciliation ${competing.delta.id}; a parallel proposal was not created.`,
          current.document,
        );
      }
      if (current.state.canonical.head.id !== input.baseRevisionId) {
        throw new ReconciliationRecoveryError(
          "stale_reconciliation",
          `The canonical head advanced from ${input.baseRevisionId} to ${current.state.canonical.head.id} before reconciliation was proposed. The validated result was not rebased automatically.`,
          current.document,
        );
      }

      const events = resultReconciliationProposalEvents({
        state: current.state,
        closureId: input.closureId,
        validationId: input.validationId,
        deltaId: input.deltaId,
        occurredAt: input.occurredAt,
        systemActor: HOME_MOVE_ACTORS.system,
      });
      if (
        stableStringify(events[1].payload.delta) !==
        stableStringify(input.expectedDelta)
      ) {
        throw new ReconciliationCompilationError([
          `Reconciliation ${input.deltaId} changed meaning during conflict recovery.`,
        ]);
      }

      try {
        return await this.transaction.append({
          current: {
            document: current.document,
            expectedVersion: current.version,
          },
          events,
        });
      } catch (error) {
        let latest: LoadedWorldstateDocument | null = null;
        try {
          const durable = await this.dependencies.store.get(
            HOME_MOVE_IDS.project,
          );
          latest = durable ? loadedDocument(durable) : null;
        } catch {
          // Preserve the original write error when durable truth cannot be read.
        }
        if (
          latest &&
          hasEquivalentReconciliationProposal(latest, input.expectedDelta)
        ) {
          const projection = latest.state.operational.deltas[input.deltaId];
          return transactionResultFromLoaded(latest, [
            projection?.proposedEventId ??
              `event-result-reconciliation-proposed:${input.deltaId}`,
          ]);
        }
        if (!(error instanceof LedgerConflictError) || !latest) throw error;
        lastConflict = error;
        current = latest;
      }
    }

    if (!lastConflict) {
      throw new Error(
        "Reconciliation proposal recovery stopped without a conflict.",
      );
    }
    throw lastConflict;
  }

  private async appendReconciliationIntegrationWithConflictRecovery(input: {
    readonly deltaId: string;
    readonly baseRevisionId: string;
    readonly occurredAt: string;
  }): Promise<WorldstateLedgerTransactionResult> {
    let current = this.requireLoaded();
    const expectedDelta =
      current.state.operational.deltas[input.deltaId]?.delta;
    if (!expectedDelta || expectedDelta.purpose !== "reconciliation") {
      throw new WorldstateSessionNotReadyError();
    }
    let lastConflict: LedgerConflictError | null = null;

    for (
      let attempt = 0;
      attempt < MAX_LEDGER_CONFLICT_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      const projection = current.state.operational.deltas[input.deltaId];
      if (
        projection?.disposition === "accepted" &&
        stableStringify(projection.delta) === stableStringify(expectedDelta)
      ) {
        return transactionResultFromLoaded(
          current,
          projection.dispositionEventIds.slice(-1),
        );
      }
      if (
        !projection ||
        projection.delta.purpose !== "reconciliation" ||
        stableStringify(projection.delta) !== stableStringify(expectedDelta) ||
        projection.disposition !== "pending"
      ) {
        throw new ReconciliationRecoveryError(
          "reconciliation_conflict",
          `Reconciliation ${input.deltaId} changed disposition or meaning before integration; no canonical write was attempted.`,
          current.document,
        );
      }
      if (
        current.state.canonical.head.id !== input.baseRevisionId ||
        projection.delta.baseRevisionId !== input.baseRevisionId
      ) {
        throw new ReconciliationRecoveryError(
          "stale_reconciliation",
          `Reconciliation ${input.deltaId} is based on ${input.baseRevisionId}, but the canonical head is ${current.state.canonical.head.id}. It was not rebased or integrated.`,
          current.document,
        );
      }

      try {
        assertReconciliationDeltaMatchesCurrentState(
          current.state,
          input.deltaId,
        );
        const gate = evaluateIntegrationGate(current.state, input.deltaId);
        if (!gate.allowed || !gate.verified) {
          throw new ReconciliationCompilationError([
            `Integration gate rejected ${input.deltaId}: ${gate.reasons.join(", ") || "required evidence is not verified"}.`,
          ]);
        }
      } catch (error) {
        throw new ReconciliationRecoveryError(
          "integration_gate_blocked",
          errorMessage(
            error,
            `Reconciliation ${input.deltaId} no longer satisfies its exact evidence gate.`,
          ),
          current.document,
        );
      }

      const closureId = projection.delta.closureRef;
      const closure = closureId
        ? current.state.operational.closures[closureId]
        : undefined;
      if (!closure) {
        throw new ReconciliationRecoveryError(
          "integration_gate_blocked",
          `Reconciliation ${input.deltaId} has no durable closure witness.`,
          current.document,
        );
      }
      const accepted = buildDeltaAcceptedEvent(current.state, {
        eventId: `event-result-reconciliation-integrated:${input.deltaId}`,
        commandId: `command-result-reconciliation-integrated:${input.deltaId}`,
        occurredAt: input.occurredAt,
        actor: HOME_MOVE_ACTORS.human,
        deltaId: input.deltaId,
        artifactBaseRef: closure.artifactBaseRef,
      });

      try {
        return await this.transaction.append({
          current: {
            document: current.document,
            expectedVersion: current.version,
          },
          events: [accepted],
        });
      } catch (error) {
        let latest: LoadedWorldstateDocument | null = null;
        try {
          const durable = await this.dependencies.store.get(
            HOME_MOVE_IDS.project,
          );
          latest = durable ? loadedDocument(durable) : null;
        } catch {
          // Preserve the original write error when durable truth cannot be read.
        }
        const durableProjection =
          latest?.state.operational.deltas[input.deltaId];
        if (
          latest &&
          durableProjection?.disposition === "accepted" &&
          stableStringify(durableProjection.delta) ===
            stableStringify(expectedDelta)
        ) {
          return transactionResultFromLoaded(
            latest,
            durableProjection.dispositionEventIds.slice(-1),
          );
        }
        if (!(error instanceof LedgerConflictError) || !latest) throw error;
        lastConflict = error;
        current = latest;
      }
    }

    if (!lastConflict) {
      throw new Error(
        "Result integration recovery stopped without a conflict.",
      );
    }
    throw lastConflict;
  }

  private surfaceReconciliationCompilationFailure(
    error: unknown,
    scope: "reconciliation" | "integration",
    code: string,
    fallback: string,
  ): void {
    this.patch({
      persistenceState: "saved",
      persistenceDetail:
        scope === "reconciliation"
          ? "The validated result remains durable, but no reconciliation proposal was created."
          : "The reconciliation proposal remains durable and canonical worldstate is unchanged.",
      operationState: "idle",
      error: {
        code,
        message: errorMessage(error, fallback),
        retryable: false,
        scope,
      },
      retry: null,
    });
  }

  private surfaceReconciliationRecoveryFailure(
    error: ReconciliationRecoveryError,
    scope: "reconciliation" | "integration",
  ): void {
    const loaded = loadedDocument(error.durableDocument);
    this.snapshot = {
      document: loaded.document,
      ledger: loaded.ledger,
      state: loaded.state,
      version: loaded.version,
      persistenceState:
        error.code === "reconciliation_conflict" ? "conflict" : "saved",
      persistenceDetail:
        error.code === "stale_reconciliation"
          ? "Durable truth was reloaded after the canonical head advanced; no reconciliation was silently rebased or integrated."
          : error.code === "integration_gate_blocked"
            ? "The reconciliation remains durable, but its exact integration gate is closed."
            : "A concurrent reconciliation outcome was retained; no parallel proposal or integration was created.",
      operationState: "idle",
      agentRuntimeCapability: this.snapshot.agentRuntimeCapability,
      hostAttestedArtifactPromotionReceiptDigests: {},
      ...loaded.activity,
      error: {
        code: error.code,
        message: error.message,
        retryable: false,
        scope,
      },
      retry: null,
    };
    this.emit();
  }

  private async appendReplayEvidenceValidationWithConflictRecovery(input: {
    readonly request: ReplayEvidenceRequest;
    readonly response: ReplayEvidenceResponse;
    readonly eventId: string;
    readonly commandId: string;
    readonly occurredAt: string;
    readonly actor: typeof INDEPENDENT_REPLAY_VALIDATOR_ACTOR;
  }): Promise<WorldstateLedgerTransactionResult> {
    let current = this.requireLoaded();
    let lastConflict: LedgerConflictError | null = null;

    for (
      let attempt = 0;
      attempt < MAX_LEDGER_CONFLICT_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      const validationEvent = replayEvidenceValidationRecordedEvent({
        state: current.state,
        ...input,
      });
      const existingValidation =
        current.state.operational.validations[input.request.validationId];
      if (existingValidation) {
        const withoutFreshness = (
          validation: typeof validationEvent.payload.validation,
        ) => ({
          ...validation,
          observations: validation.observations.map((observation) => ({
            ...observation,
            freshness: null,
          })),
        });
        if (
          stableStringify(withoutFreshness(existingValidation)) !==
          stableStringify(withoutFreshness(validationEvent.payload.validation))
        ) {
          throw new ReplayEvidenceValidationCoherenceError([
            `Validation ${input.request.validationId} already exists with different durable meaning.`,
          ]);
        }
        return {
          document: current.document,
          ledger: current.ledger,
          state: current.state,
          version: current.version,
          appendedEventIds: [],
          replayedEventIds: current.state.eventOrder.includes(input.eventId)
            ? [input.eventId]
            : [],
        };
      }
      try {
        return await this.transaction.append({
          current: {
            document: current.document,
            expectedVersion: current.version,
          },
          events: [validationEvent],
        });
      } catch (error) {
        if (!(error instanceof LedgerConflictError)) throw error;
        lastConflict = error;
        const latest = await this.dependencies.store.get(HOME_MOVE_IDS.project);
        if (!latest) throw error;
        current = loadedDocument(latest);
      }
    }

    if (!lastConflict) {
      throw new Error("Ledger conflict recovery stopped without a conflict.");
    }
    throw lastConflict;
  }

  private async appendLiveEvidenceValidationWithConflictRecovery(input: {
    readonly request: LiveEvidenceRequest;
    readonly response: Extract<LiveEvidenceResponse, { ok: true }>;
    readonly eventId: string;
    readonly commandId: string;
    readonly occurredAt: string;
    readonly actor: typeof INDEPENDENT_LIVE_VALIDATOR_ACTOR;
  }): Promise<WorldstateLedgerTransactionResult> {
    let current = this.requireLoaded();
    let lastConflict: LedgerConflictError | null = null;

    for (
      let attempt = 0;
      attempt < MAX_LEDGER_CONFLICT_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      const validationEvent = liveEvidenceValidationRecordedEvent({
        state: current.state,
        ...input,
      });
      const existingValidation =
        current.state.operational.validations[input.request.validationId];
      if (existingValidation) {
        const withoutFreshness = (
          validation: typeof validationEvent.payload.validation,
        ) => ({
          ...validation,
          observations: validation.observations.map((observation) => ({
            ...observation,
            freshness: null,
          })),
        });
        if (
          stableStringify(withoutFreshness(existingValidation)) !==
          stableStringify(withoutFreshness(validationEvent.payload.validation))
        ) {
          throw new LiveEvidenceValidationCoherenceError([
            `Validation ${input.request.validationId} already exists with different durable meaning.`,
          ]);
        }
        return {
          document: current.document,
          ledger: current.ledger,
          state: current.state,
          version: current.version,
          appendedEventIds: [],
          replayedEventIds: current.state.eventOrder.includes(input.eventId)
            ? [input.eventId]
            : [],
        };
      }
      try {
        return await this.transaction.append({
          current: {
            document: current.document,
            expectedVersion: current.version,
          },
          events: [validationEvent],
        });
      } catch (error) {
        if (!(error instanceof LedgerConflictError)) throw error;
        lastConflict = error;
        const latest = await this.dependencies.store.get(HOME_MOVE_IDS.project);
        if (!latest) throw error;
        current = loadedDocument(latest);
      }
    }

    if (!lastConflict) {
      throw new Error("Ledger conflict recovery stopped without a conflict.");
    }
    throw lastConflict;
  }

  private async appendWithConflictRecovery(
    events: NonEmptyLedgerEvents,
  ): Promise<WorldstateLedgerTransactionResult> {
    let current = this.requireLoaded();
    let lastConflict: LedgerConflictError | null = null;

    for (
      let attempt = 0;
      attempt < MAX_LEDGER_CONFLICT_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.transaction.append({
          current: {
            document: current.document,
            expectedVersion: current.version,
          },
          events,
        });
      } catch (error) {
        if (!(error instanceof LedgerConflictError)) throw error;
        lastConflict = error;
        const latest = await this.dependencies.store.get(HOME_MOVE_IDS.project);
        if (!latest) throw error;
        current = loadedDocument(latest);
      }
    }

    if (!lastConflict) {
      throw new Error("Ledger conflict recovery stopped without a conflict.");
    }
    throw lastConflict;
  }

  private installTransaction(
    result: WorldstateLedgerTransactionResult,
    activity: Partial<ActivityProjection>,
    options: {
      readonly operationState?: WorldstateSessionOperationState;
      readonly persistenceDetail?: string;
    } = {},
  ): void {
    const derivedActivity = activityFromLedger(result.ledger);
    this.snapshot = {
      document: result.document,
      ledger: result.ledger,
      state: result.state,
      version: result.version,
      persistenceState: "saved",
      persistenceDetail: options.persistenceDetail ?? "Browser ledger saved.",
      operationState: options.operationState ?? "idle",
      agentRuntimeCapability: this.snapshot.agentRuntimeCapability,
      hostAttestedArtifactPromotionReceiptDigests:
        this.snapshot.hostAttestedArtifactPromotionReceiptDigests ?? {},
      ...derivedActivity,
      ...activity,
    };
    this.emit();
  }

  private install(
    input: unknown,
    persistenceState: WorldstateSessionPersistenceState,
    persistenceDetail: string,
  ): void {
    const loaded = loadedDocument(input);
    this.snapshot = {
      document: loaded.document,
      ledger: loaded.ledger,
      state: loaded.state,
      version: loaded.version,
      persistenceState,
      persistenceDetail,
      operationState: "idle",
      agentRuntimeCapability: this.snapshot.agentRuntimeCapability,
      hostAttestedArtifactPromotionReceiptDigests: {},
      ...loaded.activity,
    };
    this.emit();
  }

  private async surfaceWriteFailure(
    error: unknown,
    retry: WorldstateSessionRetry | null,
    scope: WorldstateSessionErrorScope,
  ): Promise<void> {
    if (error instanceof LedgerConflictError) {
      try {
        const current = await this.dependencies.store.get(
          HOME_MOVE_IDS.project,
        );
        if (!current) throw error;
        const loaded = loadedDocument(current);
        this.snapshot = {
          document: loaded.document,
          ledger: loaded.ledger,
          state: loaded.state,
          version: loaded.version,
          persistenceState: "conflict",
          persistenceDetail:
            "The ledger changed in another session. Durable state was reloaded.",
          operationState: "idle",
          agentRuntimeCapability: this.snapshot.agentRuntimeCapability,
          hostAttestedArtifactPromotionReceiptDigests: {},
          ...loaded.activity,
          error: {
            code: "ledger_conflict",
            message: error.message,
            retryable: true,
            scope,
          },
          retry,
        };
        this.emit();
        return;
      } catch (reloadError) {
        this.surfaceLoadFailure(reloadError);
        return;
      }
    }

    const corruption =
      error instanceof LedgerCorruptionError || error instanceof z.ZodError;
    this.patch({
      persistenceState: corruption ? "corrupt" : "unavailable",
      persistenceDetail: corruption
        ? "The browser ledger failed validation."
        : "The browser ledger could not save this operation.",
      operationState: "idle",
      error: {
        code: corruption ? "ledger_corrupt" : "storage_unavailable",
        message: errorMessage(error, "The browser ledger is unavailable."),
        retryable: !corruption,
        scope,
      },
      retry: corruption ? null : retry,
    });
  }

  private async surfaceResetFailure(error: unknown): Promise<void> {
    let durableDocument: WorldstateLedgerDocument | null = null;
    const conflict = error instanceof LedgerConflictError;

    try {
      durableDocument = await this.dependencies.store.get(
        HOME_MOVE_IDS.project,
      );
    } catch {
      // A failed read cannot confirm durable state. Continue to the truthful
      // empty-snapshot fallback below rather than retaining stale memory.
    }

    if (durableDocument) {
      try {
        const loaded = loadedDocument(durableDocument);
        this.snapshot = {
          document: loaded.document,
          ledger: loaded.ledger,
          state: loaded.state,
          version: loaded.version,
          persistenceState: conflict ? "conflict" : "unavailable",
          persistenceDetail: conflict
            ? "Atomic reset was blocked because the durable ledger changed; current truth was reloaded."
            : "Atomic reset failed; the prior durable ledger remains intact.",
          operationState: "idle",
          agentRuntimeCapability: this.snapshot.agentRuntimeCapability,
          hostAttestedArtifactPromotionReceiptDigests: {},
          ...loaded.activity,
          error: {
            code: conflict ? "ledger_conflict" : "storage_unavailable",
            message: errorMessage(error, "The local sandbox could not reset."),
            retryable: true,
            scope: "reset",
          },
        };
        this.emit();
        return;
      } catch {
        // Corrupt or unreadable durable content must not remain installed as
        // though it were the confirmed browser ledger.
      }
    }

    this.snapshot = {
      document: null,
      ledger: null,
      state: null,
      version: null,
      persistenceState: "unavailable",
      persistenceDetail:
        "Reset failed and no durable browser ledger could be confirmed.",
      operationState: "idle",
      agentRuntimeCapability: this.snapshot.agentRuntimeCapability,
      hostAttestedArtifactPromotionReceiptDigests: {},
      ...EMPTY_ACTIVITY,
      error: {
        code: "storage_unavailable",
        message: errorMessage(error, "The local sandbox could not reset."),
        retryable: true,
        scope: "reset",
      },
    };
    this.emit();
  }

  private async refreshAgentRuntimeCapability(): Promise<AgentRuntimeCapability> {
    let capability: AgentRuntimeCapability;
    try {
      capability = this.dependencies.agentRuntimeCapabilityGetter
        ? AgentRuntimeCapabilitySchema.parse(
            await this.dependencies.agentRuntimeCapabilityGetter(),
          )
        : defaultReplayRuntimeCapability();
    } catch {
      capability = AgentRuntimeCapabilitySchema.parse({
        requestedMode: "unknown",
        effectiveMode: null,
        status: "unavailable",
        artifactBaseRef: null,
        reason: "The agent runtime capability could not be observed.",
      });
    }
    this.patch({ agentRuntimeCapability: capability });
    return capability;
  }

  private surfaceLoadFailure(error: unknown): void {
    const corruption =
      error instanceof LedgerCorruptionError || error instanceof z.ZodError;
    this.patch({
      persistenceState: corruption ? "corrupt" : "unavailable",
      persistenceDetail: corruption
        ? "The browser ledger failed validation."
        : "The browser ledger is unavailable.",
      operationState: "idle",
      error: {
        code: corruption ? "ledger_corrupt" : "storage_unavailable",
        message: errorMessage(error, "The browser ledger is unavailable."),
        retryable: !corruption,
        scope: "persistence",
      },
      retry: null,
    });
  }

  private requireLoaded(): {
    readonly document: WorldstateLedgerDocument;
    readonly ledger: WorldstateLedger;
    readonly state: WorldstateState;
    readonly version: LedgerVersion;
  } {
    const { document, ledger, state, version } = this.snapshot;
    if (!document || !ledger || !state || !version) {
      throw new WorldstateSessionNotReadyError();
    }
    return { document, ledger, state, version };
  }

  private assertIdle(): void {
    if (this.snapshot.operationState !== "idle") {
      throw new WorldstateSessionBusyError(this.snapshot.operationState);
    }
  }

  private patch(patch: Partial<WorldstateSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createWorldstateSession(
  dependencies: WorldstateSessionDependencies,
): WorldstateSession {
  return new DurableWorldstateSession(dependencies);
}
