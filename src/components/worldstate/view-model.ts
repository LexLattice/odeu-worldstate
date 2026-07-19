import { artifactIdentitySha256Hex } from "@/adapters/artifact-promotion/identity";
import type {
  PlacementAttempt,
  PlacementExchange,
} from "@/integration/placement-evidence";
import {
  parsePlacementAttemptSource,
  parsePlacementExchangeSource,
} from "@/integration/placement-evidence";
import { isRegisteredMovingCostReplayTarget } from "@/integration/accepted-placement-to-agent-brief";
import {
  assertCodexRunResponseMatchesRun,
  CodexRunResponseCoherenceError,
  parseCodexRunAttemptSource,
  parseCodexRunExchangeSource,
  parseCodexRunNormalizationFailureSource,
} from "@/integration/codex-run-evidence";
import { parseCodexTransportObservationSource } from "@/integration/codex-transport-evidence";
import {
  parseReplayEvidenceValidationAttemptSource,
  parseReplayEvidenceValidationExchangeSource,
} from "@/integration/replay-evidence-validation";
import {
  parseLiveEvidenceValidationAttemptSource,
  parseLiveEvidenceValidationExchangeSource,
} from "@/integration/live-evidence-validation";
import {
  parseArtifactPromotionProposalSource,
  parseArtifactPromotionRequestSource,
  parseArtifactPromotionResponseSource,
} from "@/integration/artifact-promotion";
import {
  assertReconciliationDeltaMatchesCurrentState,
  parseResultReconciliationArtifactSource,
} from "@/integration/validated-closure-to-reconciliation";
import {
  evaluateIntegrationGate,
  stableStringify,
  type AgentBrief,
  type AgentRun,
  type ClosureWitness,
  type DeltaProjection,
  type LedgerEvent,
  type RevisionRecord,
  type WorldstateDelta,
  type WorldstateLedger,
  type WorldstateNode as KernelNode,
  type WorldstateNodeInput,
  type WorldstateRelationInput,
  type WorldstateState,
} from "@/domain";

import type {
  AgentBriefSurface,
  ArtifactPromotionSurface,
  CodexExchangeEvidenceSurface,
  CodexNormalizationFailureSurface,
  EvidenceValidationSurface,
  ReconciliationCandidateSurface,
  ReconciliationConsequenceSurface,
  ReconciliationGateCheckSurface,
  ReconciliationSurface,
  AgentResultSurface,
  AgentRunSurface,
  NodeKind,
  PersistenceSurfaceState,
  PlacementSurface,
  StatusSet,
  WorkSurface,
  WorkSurfaceState,
  WorkbenchViewModel,
  WorldEvent,
  WorldNode,
  WorldRelation,
} from "./types";

const DEFAULT_WORLD_LABEL = "My World";
const DEFAULT_PROJECT_LABEL = "Untitled project";
const DEFAULT_WORK_REASON =
  "Adopt a placement before preparing a bounded agent brief.";

export type PlacementOperationState = "idle" | "loading";
export type WorkOperationState =
  | "idle"
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
  | "persisting_promotion_receipt";

export interface BuildWorkbenchViewModelInput {
  readonly ledger: WorldstateLedger;
  readonly state: WorldstateState;
  readonly worldLabel?: string;
  readonly projectLabel?: string;
  readonly persistence?: {
    readonly state: PersistenceSurfaceState;
    readonly detail: string;
  };
  readonly placementOperation?: {
    readonly state: PlacementOperationState;
    readonly sourceId?: string | null;
  };
  readonly workOperation?: {
    readonly state: WorkOperationState;
    readonly activeBriefId?: string | null;
    readonly activeRunId?: string | null;
    readonly activeAgentRequestId?: string | null;
    readonly activeClosureId?: string | null;
    readonly activeValidationRequestId?: string | null;
    readonly activeReconciliationDeltaId?: string | null;
    readonly activeIntegratedRevisionId?: string | null;
    readonly activeArtifactPromotionId?: string | null;
    readonly hostAttestedArtifactPromotionReceiptDigests?: Readonly<
      Record<string, string>
    >;
    readonly error?: {
      readonly code: string;
      readonly message: string;
    } | null;
  };
  /** Used before a persisted exchange exists. Persisted manager metadata wins. */
  readonly runtimeFallback?: WorkbenchViewModel["runtime"];
  readonly workUnavailableReason?: string;
}

interface IndexedPlacementExchange {
  readonly exchange: PlacementExchange;
  readonly event: Extract<LedgerEvent, { type: "source.captured" }>;
  readonly index: number;
}

interface IndexedPlacementAttempt {
  readonly attempt: PlacementAttempt;
  readonly event: Extract<LedgerEvent, { type: "source.captured" }>;
  readonly index: number;
}

interface IndexedManagerFailure {
  readonly event: Extract<LedgerEvent, { type: "manager.failure_recorded" }>;
  readonly index: number;
}

type CodexRunExchange = NonNullable<
  ReturnType<typeof parseCodexRunExchangeSource>
>;
type CodexRunAttempt = NonNullable<
  ReturnType<typeof parseCodexRunAttemptSource>
>;
type CodexRunNormalizationFailure = NonNullable<
  ReturnType<typeof parseCodexRunNormalizationFailureSource>
>;

interface IndexedCodexRunAttempt {
  readonly attempt: CodexRunAttempt;
  readonly event: Extract<LedgerEvent, { type: "source.captured" }>;
  readonly index: number;
}

interface IndexedCodexRunNormalizationFailure {
  readonly failure: CodexRunNormalizationFailure;
  readonly event: Extract<LedgerEvent, { type: "source.captured" }>;
  readonly index: number;
}

interface IndexedCodexRunExchange {
  readonly exchange: CodexRunExchange;
  readonly event: Extract<LedgerEvent, { type: "source.captured" }>;
  readonly index: number;
}

interface OverlayRecords {
  readonly nodes: readonly WorldstateNodeInput[];
  readonly relations: readonly WorldstateRelationInput[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function titleCaseToken(value: string): string {
  return value
    .split("_")
    .map((token) => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`)
    .join(" ");
}

function displayRevision(revision: RevisionRecord): string {
  return `Revision ${revision.number} · ${revision.id}`;
}

function displayNodeKind(
  node: Pick<KernelNode | WorldstateNodeInput, "kind" | "data">,
): NodeKind {
  switch (node.kind) {
    case "World":
      return "world";
    case "Project":
      return "project";
    case "Goal":
      return "goal";
    case "Idea":
      return node.data.role === "area" ? "area" : "idea";
    case "Decision":
      return "decision";
    case "Constraint":
      return "constraint";
    case "OpenQuestion":
      return "question";
    case "Task":
      return "task";
    case "Artifact":
      return "artifact";
    case "AgentRun":
      return "agent-run";
    case "Evidence":
      return "evidence";
  }
}

function displayStatus(node: KernelNode | WorldstateNodeInput): StatusSet {
  const knowledge: StatusSet["knowledge"] =
    node.knowledge?.freshness === "stale"
      ? "Out of date"
      : node.knowledge?.standing === "supported"
        ? "Supported"
        : node.knowledge?.standing === "challenged"
          ? "Challenged"
          : node.knowledge?.standing === "open"
            ? "Open"
            : "Draft";

  const governance: StatusSet["governance"] =
    node.governance?.standing === "adopted"
      ? "Adopted"
      : node.governance?.standing === "restricted"
        ? "Restricted"
        : "Suggested";

  const work: StatusSet["work"] =
    node.work?.verification === "verified"
      ? "Verified"
      : node.work?.phase === "running"
        ? "Running"
        : node.work?.phase === "blocked"
          ? "Blocked"
          : node.work?.phase === "completed"
            ? "Completed"
            : "Planned";

  return { knowledge, governance, work };
}

function provisionalStatus(): StatusSet {
  return {
    knowledge: "Draft",
    governance: "Suggested",
    work: "Planned",
  };
}

function latestPlacementExchange(
  ledger: WorldstateLedger,
): IndexedPlacementExchange | null {
  let latest: IndexedPlacementExchange | null = null;

  ledger.events.forEach((event, index) => {
    if (
      event.type !== "source.captured" ||
      event.payload.source.visibility !== "shared"
    ) {
      return;
    }
    const exchange = parsePlacementExchangeSource(event.payload.source);
    if (exchange) latest = { exchange, event, index };
  });

  return latest;
}

function latestPlacementAttempt(
  ledger: WorldstateLedger,
): IndexedPlacementAttempt | null {
  let latest: IndexedPlacementAttempt | null = null;

  ledger.events.forEach((event, index) => {
    if (
      event.type !== "source.captured" ||
      event.payload.source.visibility !== "shared"
    ) {
      return;
    }
    const attempt = parsePlacementAttemptSource(event.payload.source);
    if (attempt) latest = { attempt, event, index };
  });

  return latest;
}

function placementExchangeForAttempt(
  ledger: WorldstateLedger,
  attempt: IndexedPlacementAttempt,
): IndexedPlacementExchange | null {
  let matching: IndexedPlacementExchange | null = null;

  ledger.events.forEach((event, index) => {
    if (
      index <= attempt.index ||
      event.type !== "source.captured" ||
      event.payload.source.visibility !== "shared"
    ) {
      return;
    }
    const exchange = parsePlacementExchangeSource(event.payload.source);
    if (exchange?.request.requestId === attempt.attempt.request.requestId) {
      matching = { exchange, event, index };
    }
  });

  return matching;
}

function latestManagerFailure(
  ledger: WorldstateLedger,
  input: { afterIndex: number; sourceId: string | null },
): IndexedManagerFailure | null {
  let latest: IndexedManagerFailure | null = null;

  ledger.events.forEach((event, index) => {
    if (
      index > input.afterIndex &&
      event.type === "manager.failure_recorded" &&
      (!event.payload.sourceId ||
        !input.sourceId ||
        event.payload.sourceId === input.sourceId)
    ) {
      latest = { event, index };
    }
  });

  return latest;
}

function latestCodexRunAttempt(
  ledger: WorldstateLedger,
  runId: string | null,
): IndexedCodexRunAttempt | null {
  if (!runId) return null;
  let latest: IndexedCodexRunAttempt | null = null;

  ledger.events.forEach((event, index) => {
    if (event.type !== "source.captured") return;
    const attempt = parseCodexRunAttemptSource(event.payload.source);
    if (attempt?.request.runId === runId) {
      latest = { attempt, event, index };
    }
  });

  return latest;
}

function latestCodexRunExchange(
  ledger: WorldstateLedger,
  runId: string | null,
): IndexedCodexRunExchange | null {
  if (!runId) return null;
  let latest: IndexedCodexRunExchange | null = null;

  ledger.events.forEach((event, index) => {
    if (event.type !== "source.captured") return;
    const exchange = parseCodexRunExchangeSource(event.payload.source);
    if (exchange?.request.runId === runId) {
      latest = { exchange, event, index };
    }
  });

  return latest;
}

function latestCodexRunNormalizationFailure(
  ledger: WorldstateLedger,
  runId: string | null,
): IndexedCodexRunNormalizationFailure | null {
  if (!runId) return null;
  let latest: IndexedCodexRunNormalizationFailure | null = null;

  ledger.events.forEach((event, index) => {
    if (event.type !== "source.captured") return;
    const failure = parseCodexRunNormalizationFailureSource(
      event.payload.source,
    );
    if (failure?.runId === runId) {
      latest = { failure, event, index };
    }
  });

  return latest;
}

function latestWorkIds(ledger: WorldstateLedger): {
  briefId: string | null;
  runId: string | null;
  closureId: string | null;
} {
  let briefId: string | null = null;
  let runId: string | null = null;
  let closureId: string | null = null;

  for (const event of ledger.events) {
    if (event.type === "brief.compiled") {
      briefId = event.payload.brief.id;
      runId = null;
      closureId = null;
    } else if (
      event.type === "run.authorized" &&
      event.payload.run.briefId === briefId
    ) {
      runId = event.payload.run.id;
      closureId = null;
    } else if (
      event.type === "closure.staged" &&
      event.payload.closure.runId === runId
    ) {
      closureId = event.payload.closure.id;
    }
  }

  return { briefId, runId, closureId };
}

function latestPlainSharedSource(ledger: WorldstateLedger): {
  event: Extract<LedgerEvent, { type: "source.captured" }>;
  index: number;
} | null {
  let latest: {
    event: Extract<LedgerEvent, { type: "source.captured" }>;
    index: number;
  } | null = null;
  ledger.events.forEach((event, index) => {
    if (
      event.type === "source.captured" &&
      event.payload.source.kind === "text" &&
      event.payload.source.visibility === "shared" &&
      !parsePlacementExchangeSource(event.payload.source)
    ) {
      latest = { event, index };
    }
  });
  return latest;
}

function sourceCapture(
  ledger: WorldstateLedger,
  sourceId: string | null,
): Extract<LedgerEvent, { type: "source.captured" }> | null {
  if (!sourceId) return null;
  return (
    ledger.events.find(
      (event): event is Extract<LedgerEvent, { type: "source.captured" }> =>
        event.type === "source.captured" &&
        event.payload.source.id === sourceId,
    ) ?? null
  );
}

function runtimeFromExchange(
  exchange: PlacementExchange,
): WorkbenchViewModel["runtime"] {
  const manager = exchange.response.manager;
  if (manager.status === "unavailable" || manager.effectiveMode === null) {
    return {
      mode: "unavailable",
      label: manager.model
        ? `Placement manager unavailable · ${manager.model}`
        : "Placement manager unavailable",
    };
  }
  if (manager.effectiveMode === "fixture") {
    return { mode: "fixture", label: "Deterministic fixture manager" };
  }
  const liveIdentity = [
    manager.provider === "openai" ? "OpenAI" : null,
    manager.model,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return {
    mode: "live",
    label:
      manager.status === "failed"
        ? `Live manager failed${liveIdentity ? ` · ${liveIdentity}` : ""}`
        : `Live manager${liveIdentity ? ` · ${liveIdentity}` : ""}`,
  };
}

function managerLabelFromRuntime(
  runtime: WorkbenchViewModel["runtime"],
): string {
  if (runtime.mode === "fixture") return "Fixture placement manager";
  if (runtime.mode === "live") return runtime.label;
  return "Placement manager unavailable";
}

function overlayFromProjection(
  projection: DeltaProjection | undefined,
): OverlayRecords {
  if (
    !projection ||
    projection.delta.purpose !== "placement" ||
    projection.disposition !== "pending"
  ) {
    return { nodes: [], relations: [] };
  }

  return {
    nodes: projection.delta.operations.flatMap((operation) =>
      operation.op === "node.add" && operation.node.visibility === "shared"
        ? [operation.node]
        : [],
    ),
    relations: projection.delta.operations.flatMap((operation) =>
      operation.op === "relation.add" ? [operation.relation] : [],
    ),
  };
}

function buildProjectionRecords(
  state: WorldstateState,
  overlay: OverlayRecords,
): { nodes: WorldNode[]; relations: WorldRelation[] } {
  const canonicalNodes = Object.values(state.canonical.nodes)
    .filter(
      (node) =>
        !node.retiredRevisionId &&
        node.visibility === "shared" &&
        node.scopeId === state.canonical.projectId,
    )
    .sort((left, right) => compareText(left.id, right.id));
  const visibleNodeIds = new Set(canonicalNodes.map((node) => node.id));
  const overlayNodes = [...overlay.nodes]
    .filter(
      (node) =>
        node.scopeId === state.canonical.projectId &&
        !visibleNodeIds.has(node.id),
    )
    .sort((left, right) => compareText(left.id, right.id));
  overlayNodes.forEach((node) => visibleNodeIds.add(node.id));

  const canonicalRelations = Object.values(state.canonical.relations)
    .filter(
      (relation) =>
        !relation.retiredRevisionId &&
        relation.scopeId === state.canonical.projectId &&
        visibleNodeIds.has(relation.fromNodeId) &&
        visibleNodeIds.has(relation.toNodeId),
    )
    .sort((left, right) => compareText(left.id, right.id));
  const canonicalRelationIds = new Set(
    canonicalRelations.map((relation) => relation.id),
  );
  const overlayRelations = [...overlay.relations]
    .filter(
      (relation) =>
        relation.scopeId === state.canonical.projectId &&
        !canonicalRelationIds.has(relation.id) &&
        visibleNodeIds.has(relation.fromNodeId) &&
        visibleNodeIds.has(relation.toNodeId),
    )
    .sort((left, right) => compareText(left.id, right.id));

  const belongsTo = [...canonicalRelations, ...overlayRelations]
    .filter((relation) => relation.kind === "belongs_to")
    .sort((left, right) => compareText(left.id, right.id));
  const parentByChild = new Map<string, string>();
  belongsTo.forEach((relation) => {
    if (!parentByChild.has(relation.fromNodeId)) {
      parentByChild.set(relation.fromNodeId, relation.toNodeId);
    }
  });

  const nodes = [
    ...canonicalNodes.map((node): WorldNode => ({
      id: node.id,
      label: node.title,
      kind: displayNodeKind(node),
      ...(parentByChild.has(node.id)
        ? { parentId: parentByChild.get(node.id) }
        : {}),
      eyebrow: `${titleCaseToken(node.kind)} · Canonical`,
      ...(node.description ? { description: node.description } : {}),
      status: displayStatus(node),
    })),
    ...overlayNodes.map((node): WorldNode => ({
      id: node.id,
      label: node.title,
      kind: displayNodeKind(node),
      ...(parentByChild.has(node.id)
        ? { parentId: parentByChild.get(node.id) }
        : {}),
      eyebrow: `${titleCaseToken(node.kind)} · Suggested`,
      ...(node.description ? { description: node.description } : {}),
      status: provisionalStatus(),
    })),
  ].sort((left, right) => compareText(left.id, right.id));

  const relations = [
    ...canonicalRelations.map((relation): WorldRelation => ({
      id: relation.id,
      source: relation.fromNodeId,
      target: relation.toNodeId,
      label: relation.label ?? titleCaseToken(relation.kind),
      posture: "canonical",
    })),
    ...overlayRelations.map((relation): WorldRelation => ({
      id: relation.id,
      source: relation.fromNodeId,
      target: relation.toNodeId,
      label: relation.label ?? titleCaseToken(relation.kind),
      posture: "proposed",
    })),
  ].sort((left, right) => compareText(left.id, right.id));

  return { nodes, relations };
}

function deltaCandidateId(
  delta: WorldstateDelta | undefined,
): string | undefined {
  return delta?.operations.find((operation) => operation.op === "node.add")
    ?.node.id;
}

function timelineEvent(
  event: LedgerEvent,
  state: WorldstateState,
): WorldEvent | null {
  switch (event.type) {
    case "source.captured": {
      if (event.payload.source.visibility !== "shared") return null;
      const attempt = parsePlacementAttemptSource(event.payload.source);
      if (attempt) {
        const selectedNodeId =
          attempt.request.projection.selectedNodeId ??
          attempt.request.projection.projectId;
        return {
          id: event.eventId,
          kind: "evidence",
          label: "Placement request persisted",
          detail: `Request ${attempt.request.requestId} was durably recorded before manager dispatch.`,
          time: event.occurredAt,
          ...(selectedNodeId ? { worldstateId: selectedNodeId } : {}),
        };
      }
      const exchange = parsePlacementExchangeSource(event.payload.source);
      if (exchange) {
        const label = exchange.response.ok
          ? exchange.response.receipt.decisionState === "reviewable"
            ? "Placement receipt persisted"
            : "Placement clarification persisted"
          : "Placement error exchange persisted";
        const detail = exchange.response.ok
          ? exchange.response.receipt.decisionState === "reviewable"
            ? `${exchange.response.receipt.location.label} → ${exchange.response.receipt.proposed.title}`
            : (exchange.response.receipt.clarificationQuestion ??
              "Clarification is required.")
          : `${exchange.response.error.code}: ${exchange.response.error.message}`;
        return {
          id: event.eventId,
          kind: "evidence",
          label,
          detail,
          time: event.occurredAt,
          ...(exchange.response.ok
            ? { worldstateId: exchange.response.receipt.proposed.nodeId }
            : { worldstateId: exchange.request.source.sourceId }),
        };
      }
      const codexAttempt = parseCodexRunAttemptSource(event.payload.source);
      if (codexAttempt) {
        const brief =
          state.operational.briefs[codexAttempt.request.brief.briefId];
        return {
          id: event.eventId,
          kind: "worker",
          label: "Codex request persisted",
          detail: `${codexAttempt.request.mode === "live" ? "Live Codex" : "Replay"} request ${codexAttempt.request.requestId} was recorded before dispatch.`,
          time: event.occurredAt,
          revision: codexAttempt.request.brief.sourceRevisionId,
          worldstateId:
            brief?.targetNodeId ?? codexAttempt.request.brief.briefId,
        };
      }
      const codexExchange = parseCodexRunExchangeSource(event.payload.source);
      if (codexExchange) {
        const brief =
          state.operational.briefs[codexExchange.request.brief.briefId];
        return {
          id: event.eventId,
          kind: "worker",
          label: "Codex exchange evidence persisted",
          detail: codexExchange.response.ok
            ? `Reported runtime: ${codexExchange.response.runtime.status} · ${codexExchange.response.runtime.replayIdentity ?? codexExchange.response.runtime.provider}`
            : `Reported failure: ${codexExchange.response.error.code}: ${codexExchange.response.error.message}`,
          time: event.occurredAt,
          revision: codexExchange.request.brief.sourceRevisionId,
          worldstateId:
            brief?.targetNodeId ?? codexExchange.request.brief.briefId,
        };
      }
      const normalizationFailure = parseCodexRunNormalizationFailureSource(
        event.payload.source,
      );
      if (normalizationFailure) {
        const brief = state.operational.briefs[normalizationFailure.briefId];
        return {
          id: event.eventId,
          kind: "worker",
          label:
            normalizationFailure.code === "coherence_rejected"
              ? "Codex normalization rejected"
              : "Codex normalization conflict",
          detail: `${normalizationFailure.code}: ${normalizationFailure.message}`,
          time: event.occurredAt,
          worldstateId: brief?.targetNodeId ?? normalizationFailure.briefId,
        };
      }
      const transportObservation = parseCodexTransportObservationSource(
        event.payload.source,
      );
      if (transportObservation) {
        const run = state.operational.runs[transportObservation.runId]?.run;
        const brief = run ? state.operational.briefs[run.briefId] : undefined;
        const bodyPosture = transportObservation.bodyDigest
          ? `${transportObservation.bodyDigest} · ${transportObservation.bodyTruncated ? "truncated" : "complete"}`
          : "body not observed";
        return {
          id: event.eventId,
          kind: "worker",
          label:
            transportObservation.outcome === "response_invalid"
              ? "Codex response rejected at transport boundary"
              : "Codex transport failed",
          detail: `${transportObservation.outcome} · HTTP ${transportObservation.httpStatus ?? "not observed"} · ${transportObservation.contentType ?? "content type not observed"} · ${bodyPosture}`,
          time: event.occurredAt,
          worldstateId: brief?.targetNodeId ?? transportObservation.runId,
        };
      }
      const validationAttempt =
        parseReplayEvidenceValidationAttemptSource(event.payload.source) ??
        parseLiveEvidenceValidationAttemptSource(event.payload.source);
      if (validationAttempt) {
        const request = validationAttempt.request;
        const brief = state.operational.briefs[request.briefId];
        return {
          id: event.eventId,
          kind: "evidence",
          label: "Independent validation request persisted",
          detail: `Validation request ${request.validationRequestId} binds closure ${request.closureId} to ${request.evidenceRequirements.length} registered requirement(s).`,
          time: event.occurredAt,
          revision: request.baseRevisionId,
          worldstateId: brief?.targetNodeId ?? request.closureId,
        };
      }
      const validationExchange =
        parseReplayEvidenceValidationExchangeSource(event.payload.source) ??
        parseLiveEvidenceValidationExchangeSource(event.payload.source);
      if (validationExchange) {
        const { request, response } = validationExchange;
        const brief = state.operational.briefs[request.briefId];
        return {
          id: event.eventId,
          kind: "evidence",
          label: response.ok
            ? "Independent validation exchange persisted"
            : "Independent validation failure persisted",
          detail: response.ok
            ? `${response.verifier.identity} reported ${response.status}; ${response.observations.filter((observation) => observation.result === "passed").length}/${response.observations.length} registered requirement observation(s) passed.`
            : `${response.error.code}; no validation verdict was inferred.`,
          time: event.occurredAt,
          revision: request.baseRevisionId,
          worldstateId: brief?.targetNodeId ?? request.closureId,
        };
      }
      const reconciliationArtifact = parseResultReconciliationArtifactSource(
        event.payload.source,
      );
      if (reconciliationArtifact) {
        return {
          id: event.eventId,
          kind: "evidence",
          label: "Reconciliation receipt persisted",
          detail: `Candidate ${reconciliationArtifact.bindings.deltaId} binds closure ${reconciliationArtifact.bindings.closureId} to validation ${reconciliationArtifact.bindings.validationId} under ${reconciliationArtifact.verificationScope}; causal execution ${reconciliationArtifact.causalExecutionEstablished ? "established" : "not established"}; artifact promotion ${reconciliationArtifact.artifactPromotion}; causal authorship not established.`,
          time: event.occurredAt,
          revision: reconciliationArtifact.bindings.baseRevisionId,
          worldstateId: reconciliationArtifact.bindings.targetNodeId,
        };
      }
      const promotionProposal = parseArtifactPromotionProposalSource(
        event.payload.source,
      );
      if (promotionProposal) {
        const proposal = promotionProposal.proposal;
        return {
          id: event.eventId,
          kind: "evidence",
          label: "Artifact-promotion proposal receipt persisted",
          detail: `${proposal.candidateId} may advance ${proposal.targetRef} from ${proposal.expectedBaseCommit} to ${proposal.candidateCommit}; no ref update was performed.`,
          time: event.occurredAt,
          revision: proposal.integratedRevisionId,
          worldstateId: proposal.reconciliationDeltaId,
        };
      }
      const promotionRequest = parseArtifactPromotionRequestSource(
        event.payload.source,
      );
      if (promotionRequest) {
        return {
          id: event.eventId,
          kind: "evidence",
          label: "Exact artifact-promotion request persisted",
          detail: `Request ${promotionRequest.promotionId} binds ${promotionRequest.targetRef} to one candidate/base compare-and-swap.`,
          time: event.occurredAt,
          revision: promotionRequest.integratedRevisionId,
          worldstateId: promotionRequest.promotionId,
        };
      }
      const promotionResponse = parseArtifactPromotionResponseSource(
        event.payload.source,
      );
      if (promotionResponse) {
        const receipt = promotionResponse.receipt;
        return {
          id: event.eventId,
          kind: "evidence",
          label: "Signed artifact-promotion outcome persisted",
          detail: `${receipt.outcome}: ${receipt.targetRef} observed ${receipt.observedRefAfter ?? "no established commit"}.`,
          time: event.occurredAt,
          worldstateId: receipt.promotionId,
        };
      }
      if (event.payload.source.id.startsWith("source-result-reconciliation:")) {
        return {
          id: event.eventId,
          kind: "evidence",
          label: "Reconciliation receipt rejected",
          detail:
            "The receipt failed schema or integrity validation; raw source content is withheld.",
          time: event.occurredAt,
          worldstateId: event.payload.source.id,
        };
      }
      if (event.payload.source.kind === "system") {
        return {
          id: event.eventId,
          kind: "evidence",
          label: "System evidence withheld",
          detail:
            "The system source was unrecognized or failed schema/integrity validation; raw content is withheld.",
          time: event.occurredAt,
          worldstateId: event.payload.source.id,
        };
      }
      return {
        id: event.eventId,
        kind: "source",
        label: "Source captured",
        detail: event.payload.source.content,
        time: event.occurredAt,
        worldstateId: event.payload.source.id,
      };
    }
    case "manager.failure_recorded": {
      const source = event.payload.sourceId
        ? state.operational.sources[event.payload.sourceId]
        : undefined;
      if (source?.visibility === "private") return null;
      return {
        id: event.eventId,
        kind: "evidence",
        label: "Placement manager failure recorded",
        detail: `${event.payload.code}: ${event.payload.message}`,
        time: event.occurredAt,
        ...(event.payload.sourceId
          ? { worldstateId: event.payload.sourceId }
          : {}),
      };
    }
    case "delta.proposed": {
      const reconciliation = event.payload.delta.purpose === "reconciliation";
      const targetNodeId = reconciliation
        ? event.payload.delta.operations.find(
            (operation) => operation.op === "node.patch",
          )?.nodeId
        : deltaCandidateId(event.payload.delta);
      return {
        id: event.eventId,
        kind: "evidence",
        label: reconciliation
          ? "Reconciliation candidate proposed"
          : `${titleCaseToken(event.payload.delta.purpose)} update proposed`,
        detail: event.payload.delta.visibleConsequence,
        time: event.occurredAt,
        revision: event.payload.delta.baseRevisionId,
        worldstateId: targetNodeId ?? event.payload.delta.id,
      };
    }
    case "delta.deferred":
    case "delta.rejected":
    case "delta.remanded":
      return {
        id: event.eventId,
        kind: "revision",
        label: `Update ${event.type.slice("delta.".length)}`,
        detail: event.payload.reason,
        time: event.occurredAt,
        revision: event.payload.baseRevisionId,
        worldstateId: event.payload.deltaId,
      };
    case "delta.superseded":
      return {
        id: event.eventId,
        kind: "revision",
        label: "Update superseded",
        detail: event.payload.reason,
        time: event.occurredAt,
        revision: event.payload.baseRevisionId,
        worldstateId:
          deltaCandidateId(event.payload.replacement) ?? event.payload.deltaId,
      };
    case "delta.accepted": {
      const projection = state.operational.deltas[event.payload.deltaId];
      const reconciliation = projection?.delta.purpose === "reconciliation";
      const targetNodeId = reconciliation
        ? projection.delta.operations.find(
            (operation) => operation.op === "node.patch",
          )?.nodeId
        : deltaCandidateId(projection?.delta);
      return {
        id: event.eventId,
        kind: "revision",
        label: reconciliation ? "Result integrated" : "Semantic update adopted",
        detail: reconciliation
          ? `${displayRevision(event.payload.revision)} integrated reviewed candidate ${event.payload.deltaId}.`
          : `${displayRevision(event.payload.revision)} adopted ${event.payload.deltaId}.`,
        time: event.occurredAt,
        revision: event.payload.revision.id,
        worldstateId: targetNodeId ?? event.payload.deltaId,
      };
    }
    case "projection.selected":
      return {
        id: event.eventId,
        kind: "evidence",
        label: "Projection selected",
        detail: `${titleCaseToken(event.payload.projection)} projection selected.`,
        time: event.occurredAt,
      };
    case "brief.compiled":
      return {
        id: event.eventId,
        kind: "worker",
        label: "Agent brief compiled",
        detail: event.payload.brief.goal,
        time: event.occurredAt,
        revision: event.payload.brief.baseRevisionId,
        worldstateId: event.payload.brief.targetNodeId,
      };
    case "run.authorized": {
      const brief = state.operational.briefs[event.payload.run.briefId];
      return {
        id: event.eventId,
        kind: "worker",
        label: "Agent run authorized",
        detail: `${event.payload.run.mode} run ${event.payload.run.id} authorized.`,
        time: event.occurredAt,
        revision: event.payload.run.baseRevisionId,
        worldstateId: brief?.targetNodeId ?? event.payload.run.id,
      };
    }
    case "run.lifecycle_recorded": {
      const run = state.operational.runs[event.payload.runId]?.run;
      const brief = run ? state.operational.briefs[run.briefId] : undefined;
      return {
        id: event.eventId,
        kind: "worker",
        label: `Agent run ${event.payload.status}`,
        detail:
          event.payload.message ??
          `Run ${event.payload.runId} is ${event.payload.status}.`,
        time: event.occurredAt,
        worldstateId: brief?.targetNodeId ?? event.payload.runId,
      };
    }
    case "closure.staged": {
      const brief = state.operational.briefs[event.payload.closure.briefId];
      return {
        id: event.eventId,
        kind: "worker",
        label: "Agent closure staged",
        detail: event.payload.closure.summary,
        time: event.occurredAt,
        revision: event.payload.closure.baseRevisionId,
        worldstateId: brief?.targetNodeId ?? event.payload.closure.runId,
      };
    }
    case "evidence.validation_recorded": {
      const brief = state.operational.briefs[event.payload.validation.briefId];
      return {
        id: event.eventId,
        kind: "evidence",
        label: "Evidence validation recorded",
        detail: `${event.payload.validation.observations.length} evidence observation(s) recorded.`,
        time: event.occurredAt,
        revision: event.payload.validation.baseRevisionId,
        worldstateId: brief?.targetNodeId ?? event.payload.validation.closureId,
      };
    }
    case "artifact.promotion_proposed":
      return {
        id: event.eventId,
        kind: "evidence",
        label: "Artifact promotion proposed",
        detail: `Candidate ${event.payload.proposal.candidateId} is staged for review; ${event.payload.proposal.targetRef} remains unchanged.`,
        time: event.occurredAt,
        revision: event.payload.proposal.integratedRevisionId,
        worldstateId: event.payload.proposal.id,
      };
    case "artifact.promotion_authorized":
      return {
        id: event.eventId,
        kind: "revision",
        label: "Artifact promotion authorized",
        detail: `Human authority was granted to the exact request ${event.payload.requestSourceId}; no success is inferred until a signed outcome is durable.`,
        time: event.occurredAt,
        revision: event.payload.integratedRevisionId,
        worldstateId: event.payload.promotionId,
      };
    case "artifact.promotion_outcome_recorded":
      return {
        id: event.eventId,
        kind: "revision",
        label:
          event.payload.outcome.outcome === "promoted"
            ? "Authoritative artifact ref promoted"
            : "Artifact promotion outcome recorded",
        detail: `${event.payload.outcome.outcome}: ${event.payload.outcome.targetRef} observed ${event.payload.outcome.observedTargetCommit ?? "no established commit"}.`,
        time: event.occurredAt,
        worldstateId: event.payload.outcome.promotionId,
      };
  }

  return null;
}

function blankPlacement(
  state: PlacementSurface["state"],
  managerLabel: string,
  gateReason: string,
): PlacementSurface {
  return {
    state,
    sourceId: null,
    sourceText: null,
    sourceCapturedAt: null,
    deltaId: null,
    candidateId: null,
    exchangeId: null,
    receiptId: null,
    locationLabel: null,
    breadcrumb: [],
    proposedKind: null,
    delegationProfileId: null,
    proposedTitle: null,
    proposedSummary: null,
    rationale: null,
    confidence: null,
    uncertainty: [],
    alternatives: [],
    conflicts: [],
    affectedTitles: [],
    visibleConsequence: null,
    clarificationQuestion: null,
    managerLabel,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    canAccept: false,
    gateReason,
  };
}

function persistenceGateReason(state: PersistenceSurfaceState): string {
  switch (state) {
    case "loading":
      return "The browser ledger is still loading. Semantic commit is unavailable.";
    case "saving":
      return "The browser ledger is still saving. Semantic commit is unavailable.";
    case "conflict":
      return "The browser ledger changed elsewhere. Reload before semantic commit.";
    case "unavailable":
      return "Browser persistence is unavailable. Semantic commit is unavailable.";
    case "corrupt":
      return "The persisted ledger could not be validated. Semantic commit is unavailable.";
    case "saved":
      return "Persisted source and placement evidence are ready for human semantic commit.";
  }
}

function buildPlacementSurface(input: {
  ledger: WorldstateLedger;
  state: WorldstateState;
  attempt: IndexedPlacementAttempt | null;
  exchange: IndexedPlacementExchange | null;
  failure: IndexedManagerFailure | null;
  operation: BuildWorkbenchViewModelInput["placementOperation"];
  persistence: WorkbenchViewModel["persistence"];
  runtime: WorkbenchViewModel["runtime"];
}): { placement: PlacementSurface; projection?: DeltaProjection } {
  const managerLabel = managerLabelFromRuntime(input.runtime);
  const operationSourceId = input.operation?.sourceId ?? null;
  const activeFailure =
    input.failure &&
    (!input.exchange || input.failure.index > input.exchange.index)
      ? input.failure
      : null;

  if (input.operation?.state === "loading") {
    const placement = blankPlacement(
      "loading",
      managerLabel,
      "Placement evidence is still being persisted. Semantic commit is unavailable.",
    );
    const capture = sourceCapture(input.ledger, operationSourceId);
    const source = operationSourceId
      ? input.state.operational.sources[operationSourceId]
      : undefined;
    return {
      placement: {
        ...placement,
        sourceId: source?.visibility === "shared" ? source.id : null,
        sourceText: source?.visibility === "shared" ? source.content : null,
        sourceCapturedAt:
          source?.visibility === "shared"
            ? (capture?.occurredAt ?? null)
            : null,
      },
    };
  }

  if (activeFailure) {
    const sourceId = activeFailure.event.payload.sourceId ?? null;
    const source = sourceId
      ? input.state.operational.sources[sourceId]
      : undefined;
    const capture = sourceCapture(input.ledger, sourceId);
    return {
      placement: {
        ...blankPlacement(
          "failed",
          managerLabel,
          activeFailure.event.payload.retriable
            ? "The persisted source can be retried; no semantic commit is available."
            : "The placement failure must be resolved before semantic commit.",
        ),
        sourceId: source?.visibility === "shared" ? source.id : null,
        sourceText: source?.visibility === "shared" ? source.content : null,
        sourceCapturedAt:
          source?.visibility === "shared"
            ? (capture?.occurredAt ?? null)
            : null,
        exchangeId: input.exchange?.event.payload.source.id ?? null,
        errorCode: activeFailure.event.payload.code,
        errorMessage: activeFailure.event.payload.message,
        retryable: activeFailure.event.payload.retriable,
      },
    };
  }

  if (!input.exchange) {
    if (input.attempt) {
      const request = input.attempt.attempt.request;
      const sourceId = request.source.sourceId;
      const source = input.state.operational.sources[sourceId];
      const capture = sourceCapture(input.ledger, sourceId);
      return {
        placement: {
          ...blankPlacement(
            "failed",
            managerLabel,
            "The durable placement request can be retried; no semantic commit is available.",
          ),
          sourceId,
          sourceText:
            source?.visibility === "shared"
              ? source.content
              : request.source.text,
          sourceCapturedAt: capture?.occurredAt ?? null,
          errorCode: "placement_incomplete",
          errorMessage:
            "The persisted placement request has no matching manager exchange.",
          retryable: true,
        },
      };
    }

    const placement = blankPlacement(
      "idle",
      managerLabel,
      "Capture a shared source to request a placement.",
    );
    const capture = sourceCapture(input.ledger, operationSourceId);
    const source = operationSourceId
      ? input.state.operational.sources[operationSourceId]
      : undefined;
    return {
      placement: {
        ...placement,
        sourceId: source?.visibility === "shared" ? source.id : null,
        sourceText: source?.visibility === "shared" ? source.content : null,
        sourceCapturedAt:
          source?.visibility === "shared"
            ? (capture?.occurredAt ?? null)
            : null,
      },
    };
  }

  const { exchange } = input.exchange;
  const sourceId = exchange.request.source.sourceId;
  const source = input.state.operational.sources[sourceId];
  const capture = sourceCapture(input.ledger, sourceId);

  if (!exchange.response.ok) {
    return {
      placement: {
        ...blankPlacement(
          "failed",
          managerLabel,
          exchange.response.error.retryable
            ? "The persisted source can be retried; no semantic commit is available."
            : "The placement failure must be resolved before semantic commit.",
        ),
        sourceId,
        sourceText:
          source?.visibility === "shared"
            ? source.content
            : exchange.request.source.text,
        sourceCapturedAt: capture?.occurredAt ?? null,
        exchangeId: input.exchange.event.payload.source.id,
        errorCode: exchange.response.error.code,
        errorMessage: exchange.response.error.message,
        retryable: exchange.response.error.retryable,
      },
    };
  }

  const receipt = exchange.response.receipt;
  const projection = exchange.response.delta
    ? input.state.operational.deltas[exchange.response.delta.deltaId]
    : undefined;
  const base = blankPlacement(
    "needs_clarification",
    managerLabel,
    "Answer the manager clarification before semantic commit.",
  );
  const receiptFields = {
    sourceId,
    sourceText:
      source?.visibility === "shared"
        ? source.content
        : exchange.request.source.text,
    sourceCapturedAt: capture?.occurredAt ?? null,
    deltaId: exchange.response.delta?.deltaId ?? null,
    candidateId: receipt.proposed.nodeId,
    exchangeId: input.exchange.event.payload.source.id,
    receiptId: receipt.receiptId,
    locationLabel: receipt.location.label,
    breadcrumb: [...receipt.location.breadcrumb],
    proposedKind: receipt.proposed.kind,
    delegationProfileId: receipt.proposed.delegationProfileId,
    proposedTitle: receipt.proposed.title,
    proposedSummary: receipt.proposed.summary,
    rationale: receipt.rationale,
    confidence: receipt.confidence,
    uncertainty: [...receipt.uncertainty],
    alternatives: receipt.alternatives
      .map((alternative) => ({
        title: alternative.targetTitle,
        rationale: alternative.rationale,
      }))
      .sort((left, right) => compareText(left.title, right.title)),
    conflicts: receipt.conflicts
      .map((conflict) => ({
        title: conflict.title,
        reason: conflict.reason,
        severity: conflict.severity,
      }))
      .sort((left, right) => compareText(left.title, right.title)),
    affectedTitles: receipt.affectedNodeIds
      .map((nodeId) => input.state.canonical.nodes[nodeId])
      .filter(
        (node): node is KernelNode =>
          Boolean(node) &&
          !node.retiredRevisionId &&
          node.visibility === "shared",
      )
      .map((node) => node.title)
      .sort(compareText),
    visibleConsequence: projection?.delta.visibleConsequence ?? null,
    clarificationQuestion: receipt.clarificationQuestion,
  };

  if (
    receipt.decisionState === "needs_clarification" ||
    exchange.response.delta === null
  ) {
    return { placement: { ...base, ...receiptFields } };
  }

  if (!projection) {
    return {
      placement: {
        ...base,
        ...receiptFields,
        state: "failed",
        errorCode: "placement_delta_missing",
        errorMessage:
          "The persisted placement receipt has no matching kernel delta.",
        gateReason:
          "The placement evidence is incomplete. Semantic commit is unavailable.",
      },
    };
  }

  if (projection.disposition === "accepted") {
    const acceptedRevision =
      projection.acceptedRevisionId ??
      input.state.provenance.deltaToRevisionId[projection.delta.id];
    return {
      placement: {
        ...base,
        ...receiptFields,
        state: "adopted",
        gateReason: acceptedRevision
          ? `Already adopted in ${acceptedRevision}.`
          : "This placement has already been adopted.",
      },
      projection,
    };
  }

  if (projection.disposition !== "pending") {
    return {
      placement: {
        ...base,
        ...receiptFields,
        state: "failed",
        errorCode: `delta_${projection.disposition}`,
        errorMessage:
          projection.reason ?? `The placement was ${projection.disposition}.`,
        gateReason: `The placement was ${projection.disposition}; semantic commit is unavailable.`,
      },
      projection,
    };
  }

  if (projection.delta.baseRevisionId !== input.state.canonical.head.id) {
    return {
      placement: {
        ...base,
        ...receiptFields,
        state: "stale",
        gateReason: `Placement base ${projection.delta.baseRevisionId} does not match current head ${input.state.canonical.head.id}. Request a fresh placement.`,
      },
      projection,
    };
  }

  const canAccept = input.persistence.state === "saved";
  return {
    placement: {
      ...base,
      ...receiptFields,
      state: "reviewable",
      canAccept,
      gateReason: persistenceGateReason(input.persistence.state),
    },
    projection,
  };
}

function projectBrief(
  brief: AgentBrief,
  headRevisionId: string,
): AgentBriefSurface {
  return {
    id: brief.id,
    baseRevisionId: brief.baseRevisionId,
    artifactBaseRef: brief.artifactBaseRef,
    targetNodeId: brief.targetNodeId,
    delegationProfileId: brief.delegationProfileId,
    goal: brief.goal,
    doneMeans: [...brief.doneMeans],
    unknowns: [...brief.unknowns],
    constraints: [...brief.constraints],
    expectedArtifacts: [...brief.expectedArtifacts],
    sharedContext: brief.sharedNodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.title,
      summary: node.description ?? node.title,
    })),
    sharedRelationCount: brief.sharedRelations.length,
    omittedContext: brief.omittedContext.map((item) => ({
      id: item.nodeId,
      label: item.title,
      reason: item.reason,
    })),
    environment: brief.environment,
    agentProfile: brief.agentProfile,
    allowedActions: [...brief.allowedActions],
    deniedActions: [...brief.deniedActions],
    confirmationRequired: [...brief.confirmationRequired],
    evidenceRequirements: brief.evidenceContract.requirements.map(
      (requirement) => ({
        id: requirement.id,
        label: requirement.label,
        kind: requirement.kind,
        required: requirement.required,
        command: requirement.command ?? null,
      }),
    ),
    blockIntegrationWithoutEvidence:
      brief.evidenceContract.policy.blockIntegration,
    escalationPath: brief.escalationPath,
    stale: brief.baseRevisionId !== headRevisionId,
  };
}

function projectRun(
  ledger: WorldstateLedger,
  run: AgentRun,
  status: AgentRunSurface["status"],
  headRevisionId: string,
): AgentRunSurface {
  const lifecycle: AgentRunSurface["lifecycle"] = [];
  for (const event of ledger.events) {
    if (event.type === "run.authorized" && event.payload.run.id === run.id) {
      lifecycle.push({
        id: event.eventId,
        status: "queued",
        at: event.occurredAt,
        message: `One ${run.mode} run was authorized from brief ${run.briefId}.`,
        evidenceRefs: [],
      });
    } else if (
      event.type === "run.lifecycle_recorded" &&
      event.payload.runId === run.id
    ) {
      lifecycle.push({
        id: event.eventId,
        status: event.payload.status,
        at: event.occurredAt,
        message:
          event.payload.message ??
          `Run ${run.id} entered ${event.payload.status}.`,
        evidenceRefs: [...event.payload.evidenceRefs],
      });
    }
  }

  return {
    id: run.id,
    briefId: run.briefId,
    mode: run.mode,
    status,
    lifecycle,
    stale: run.baseRevisionId !== headRevisionId,
  };
}

function normalizedClosureResult(
  closure: ClosureWitness,
  headRevisionId: string,
): AgentResultSurface {
  return {
    exchangeSourceId: null,
    closureId: closure.id,
    outcome: closure.outcome,
    summary: closure.summary,
    claimedDone: closure.claimedCompletion,
    criteriaClaimedSatisfied: [],
    claimedEffects: [...closure.changes],
    claimedArtifacts: closure.artifactRefs.map((reference) => ({
      path: reference,
      kind: "observed" as const,
      summary: "Artifact reference preserved in the normalized closure.",
      reference,
    })),
    claimedChecks: [],
    observedFiles: [],
    observedCommands: [],
    artifactCandidate:
      closure.artifactCandidateId && closure.artifactCandidateCommit
        ? {
            id: closure.artifactCandidateId,
            commit: closure.artifactCandidateCommit,
            tree: null,
            baseCommit: null,
            repositoryId: null,
            targetRef: null,
            manifestDigest: null,
            patchDigest: null,
            sealedAt: null,
            changedPaths: [],
          }
        : null,
    failures: [...closure.failures],
    unresolved: [...closure.unresolved],
    stale: closure.baseRevisionId !== headRevisionId,
  };
}

function projectExchangeEvidence(input: {
  indexed: IndexedCodexRunExchange;
  run: AgentRun;
  brief: AgentBrief;
  attempt: IndexedCodexRunAttempt | null;
  activeRequestId: string | null;
}): {
  evidence: CodexExchangeEvidenceSurface;
  coherent: boolean;
} {
  const { indexed, run, brief, attempt, activeRequestId } = input;
  const { request, response } = indexed.exchange;
  const issues: string[] = [];

  if (!activeRequestId) {
    issues.push("No active durable Codex request is bound to this run.");
  } else if (request.requestId !== activeRequestId) {
    issues.push(
      `exchange request ${request.requestId} does not match active request ${activeRequestId}`,
    );
  }

  if (!attempt) {
    issues.push(
      "No integrity-checked Codex request attempt exists for this run.",
    );
  } else if (
    stableStringify(attempt.attempt.request) !== stableStringify(request)
  ) {
    issues.push(
      "Exchange request does not equal the durable active request attempt.",
    );
  }

  try {
    assertCodexRunResponseMatchesRun({ run, brief, request, response });
  } catch (error) {
    if (error instanceof CodexRunResponseCoherenceError) {
      issues.push(...error.issues);
    } else {
      issues.push(
        "Exact exchange could not pass the response coherence check.",
      );
    }
  }

  const uniqueIssues = Array.from(new Set(issues));
  return {
    coherent: uniqueIssues.length === 0,
    evidence: {
      sourceId: indexed.event.payload.source.id,
      recordedAt: indexed.event.occurredAt,
      requestId: request.requestId,
      requestRunId: request.runId,
      requestBriefId: request.brief.briefId,
      sourceRevisionId: request.brief.sourceRevisionId,
      artifactBaseRef: request.brief.artifactBaseRef,
      requestedMode: request.mode,
      effectiveMode: response.runtime.effectiveMode,
      runtimeStatus: response.runtime.status,
      provider: response.runtime.provider,
      replayIdentity: response.runtime.replayIdentity,
      responseKind: response.ok ? "success" : "failure",
      disposition: uniqueIssues.length === 0 ? "accepted" : "quarantined",
      issues: uniqueIssues,
    },
  };
}

function projectNormalizationFailure(
  indexed: IndexedCodexRunNormalizationFailure,
): CodexNormalizationFailureSurface {
  return {
    sourceId: indexed.event.payload.source.id,
    recordedAt: indexed.event.occurredAt,
    requestId: indexed.failure.requestId,
    runId: indexed.failure.runId,
    briefId: indexed.failure.briefId,
    code: indexed.failure.code,
    message: indexed.failure.message,
  };
}

function exactExchangeResult(
  indexed: IndexedCodexRunExchange,
  closure: ClosureWitness | null,
  headRevisionId: string,
): AgentResultSurface | null {
  const response = indexed.exchange.response;
  const witness = response.ok ? response.closure : response.blockedRun;
  if (!witness)
    return closure ? normalizedClosureResult(closure, headRevisionId) : null;

  const { report, sdkObservations } = witness;
  const candidate = witness.artifactCandidate?.metadata ?? null;
  const candidatePaths = new Set(
    [
      ...indexed.exchange.request.brief.evidenceContract.expectedArtifacts,
      ...(candidate?.manifest.entries.map((entry) => entry.path) ?? []),
    ],
  );
  const authoredChecks = new Map(
    indexed.exchange.request.brief.evidenceContract.requiredChecks
      .filter((check) => check.command)
      .map((check) => [check.command, check.label]),
  );
  return {
    exchangeSourceId: indexed.event.payload.source.id,
    closureId: closure?.id ?? null,
    outcome: report.outcome,
    summary: closure?.summary ?? report.candidateReconciliationSummary,
    claimedDone: report.completionClaim.claimedDone,
    criteriaClaimedSatisfied: [
      ...report.completionClaim.criteriaClaimedSatisfied,
    ],
    claimedEffects: [...report.claimedEffects],
    claimedArtifacts: report.claimedArtifacts.map((artifact) => ({
      path: candidatePaths.has(artifact.path)
        ? artifact.path
        : "Worker-claimed path withheld",
      kind: artifact.kind,
      summary: artifact.summary,
      reference: artifact.reference,
    })),
    claimedChecks: report.claimedChecks.map((check) => ({
      id: check.checkId,
      label: check.label,
      status: check.status,
      detail: check.detail,
      reference: check.reference,
    })),
    observedFiles: sdkObservations.fileChanges.map((file) => ({
      id: file.itemId,
      path: candidatePaths.has(file.path)
        ? file.path
        : "Repository path withheld",
      kind: file.kind,
      status: file.status,
    })),
    observedCommands: sdkObservations.commands.map((command) => ({
      id: command.itemId,
      command: authoredChecks.has(command.command)
        ? `Registered check · ${authoredChecks.get(command.command)}`
        : "Command text withheld",
      status: command.status,
      exitCode: command.exitCode,
    })),
    artifactCandidate: candidate
      ? {
          id: candidate.candidateId,
          commit: candidate.git.candidateCommit,
          tree: candidate.git.candidateTree,
          baseCommit: candidate.git.baseCommit,
          repositoryId: candidate.repositoryId,
          targetRef: candidate.targetRef,
          manifestDigest: candidate.manifest.digest,
          patchDigest: candidate.patch.digest,
          sealedAt: candidate.sealedAt,
          changedPaths: candidate.manifest.entries.map((entry) => ({
            path: entry.path,
            status: entry.status,
            blob: entry.newBlob,
          })),
        }
      : null,
    failures: Array.from(
      new Set([...(closure?.failures ?? []), ...report.failures]),
    ),
    unresolved: [...report.unresolved],
    stale:
      witness.sourceRevisionIdUsed !== headRevisionId ||
      Boolean(closure && closure.baseRevisionId !== headRevisionId),
  };
}

function validationConsumedByRevision(
  state: WorldstateState,
  validationId: string,
  validationBaseRevisionId: string,
): string | null {
  for (const projection of Object.values(state.operational.deltas)) {
    if (
      projection.delta.purpose !== "reconciliation" ||
      projection.delta.validationRef !== validationId ||
      projection.disposition !== "accepted" ||
      !projection.acceptedRevisionId
    ) {
      continue;
    }
    const revision = state.canonical.revisions[projection.acceptedRevisionId];
    if (
      revision?.deltaId === projection.delta.id &&
      revision.parentRevisionId === validationBaseRevisionId
    ) {
      return projection.acceptedRevisionId;
    }
  }
  return null;
}

function projectEvidenceValidation(input: {
  state: WorldstateState;
  closure: ClosureWitness | null;
  brief: AgentBrief | null;
}): EvidenceValidationSurface | null {
  const { state, closure, brief } = input;
  if (!closure || !brief) return null;
  const validationId = state.operational.latestValidationByClosure[closure.id];
  const validation = validationId
    ? state.operational.validations[validationId]
    : undefined;
  if (
    !validation ||
    validation.closureId !== closure.id ||
    validation.briefId !== brief.id ||
    (validation.validator.kind !== "human" &&
      validation.validator.kind !== "system")
  ) {
    return null;
  }

  const byRequirement = new Map(
    validation.observations.map((observation) => [
      observation.requirementId,
      observation,
    ]),
  );
  const validationSource =
    state.operational.sources[validation.evidenceSourceId];
  const validationExchange = validationSource
    ? closure.mode === "live"
      ? parseLiveEvidenceValidationExchangeSource(validationSource)
      : parseReplayEvidenceValidationExchangeSource(validationSource)
    : null;
  const exactResponse =
    validationExchange?.response.ok === true &&
    validationExchange.request.validationId === validation.id &&
    validationExchange.request.closureId === validation.closureId &&
    validationExchange.request.briefId === validation.briefId &&
    validationExchange.request.baseRevisionId === validation.baseRevisionId &&
    validationExchange.response.bindings.validationId === validation.id &&
    validationExchange.response.bindings.closureId === validation.closureId
      ? validationExchange.response
      : null;
  const verifierObservations = new Map(
    exactResponse?.observations.map((observation) => [
      observation.requirementId,
      observation,
    ]),
  );
  const consumedByRevisionId = validationConsumedByRevision(
    state,
    validation.id,
    validation.baseRevisionId,
  );
  const baseIsDirectlyCurrent =
    validation.baseRevisionId === state.canonical.head.id &&
    validation.baseRevisionId === closure.baseRevisionId &&
    validation.baseRevisionId === brief.baseRevisionId;
  const baseIsCurrent = baseIsDirectlyCurrent || consumedByRevisionId !== null;
  const observations = brief.evidenceContract.requirements.map(
    (requirement) => {
      const observed = byRequirement.get(requirement.id);
      const verifierObservation = verifierObservations.get(requirement.id);
      const execution = verifierObservation?.execution;
      return {
        requirementId: requirement.id,
        label: requirement.label,
        kind: requirement.kind,
        required: requirement.required,
        command: requirement.command ?? null,
        result: observed?.result ?? ("missing" as const),
        freshness:
          observed && baseIsCurrent ? observed.freshness : ("stale" as const),
        evidenceRefs: observed ? [...observed.evidenceRefs] : [],
        verifierDetail: verifierObservation?.detail ?? null,
        execution: execution
          ? {
              kind: execution.executionKind,
              runnerId: execution.runnerId,
              declaredCommand: execution.declaredCommand,
              declaredCommandExecuted:
                execution.executionKind === "sandboxed_candidate",
              passedCount:
                "passedCount" in execution ? execution.passedCount : null,
              totalCount:
                "totalCount" in execution ? execution.totalCount : null,
              exitCode: "exitCode" in execution ? execution.exitCode : null,
              termination:
                "termination" in execution ? execution.termination : null,
            }
          : null,
      };
    },
  );
  const required = observations.filter((observation) => observation.required);
  const requiredPassed = required.filter(
    (observation) =>
      observation.result === "passed" &&
      observation.freshness === "current" &&
      observation.evidenceRefs.length > 0,
  ).length;
  const stale =
    !baseIsCurrent ||
    required.some((observation) => observation.freshness === "stale");
  const verdict = stale
    ? "stale"
    : requiredPassed === required.length
      ? "verified"
      : "not_verified";
  const issues = observations.flatMap((observation) => {
    if (!observation.required) return [];
    if (observation.freshness === "stale") {
      return [`${observation.label} was observed against a stale base.`];
    }
    if (observation.result !== "passed") {
      return [`${observation.label} is ${observation.result}.`];
    }
    if (observation.evidenceRefs.length === 0) {
      return [`${observation.label} has no grounded evidence reference.`];
    }
    return [];
  });
  const validator = {
    id: validation.validator.id,
    kind: validation.validator.kind as "human" | "system",
    label: validation.validator.label,
  };

  return {
    id: validation.id,
    closureId: validation.closureId,
    briefId: validation.briefId,
    baseRevisionId: validation.baseRevisionId,
    evidenceSourceId: validation.evidenceSourceId,
    validator,
    observedAt: validation.observedAt,
    verdict,
    consumedByRevisionId,
    verifierExchangeGrounded: exactResponse !== null,
    requiredPassed,
    requiredTotal: required.length,
    observations,
    issues,
  };
}

function reconciliationProjectionForClosure(input: {
  ledger: WorldstateLedger;
  state: WorldstateState;
  closureId: string | null;
  requestedDeltaId?: string | null;
}): DeltaProjection | null {
  const requested = input.requestedDeltaId
    ? input.state.operational.deltas[input.requestedDeltaId]
    : undefined;
  if (
    requested?.delta.purpose === "reconciliation" &&
    requested.delta.closureRef === input.closureId
  ) {
    return requested;
  }
  if (!input.closureId) return null;
  for (const event of [...input.ledger.events].reverse()) {
    if (
      event.type !== "delta.proposed" ||
      event.payload.delta.purpose !== "reconciliation" ||
      event.payload.delta.closureRef !== input.closureId
    ) {
      continue;
    }
    return input.state.operational.deltas[event.payload.delta.id] ?? null;
  }
  return null;
}

function reconciliationArtifactForProjection(
  state: WorldstateState,
  projection: DeltaProjection,
) {
  try {
    assertReconciliationDeltaMatchesCurrentState(state, projection.delta.id);
  } catch {
    return null;
  }
  for (const source of Object.values(state.operational.sources)) {
    const artifact = parseResultReconciliationArtifactSource(source);
    if (
      artifact?.delta.id === projection.delta.id &&
      stableStringify(artifact.delta) === stableStringify(projection.delta)
    ) {
      return artifact;
    }
  }
  return null;
}

function sentenceCase(value: string): string {
  const words = value.replaceAll("_", " ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

function reconciliationConsequences(
  state: WorldstateState,
  delta: WorldstateDelta,
  briefId: string,
): ReconciliationConsequenceSurface[] {
  const brief = state.operational.briefs[briefId];
  const briefNodes = new Map(
    brief?.sharedNodes.map((node) => [node.id, node]) ?? [],
  );
  const addedNodeLabels = new Map(
    delta.operations.flatMap((operation) =>
      operation.op === "node.add"
        ? ([[operation.node.id, operation.node.title]] as const)
        : [],
    ),
  );
  const nodeLabel = (nodeId: string) =>
    state.canonical.nodes[nodeId]?.title ??
    addedNodeLabels.get(nodeId) ??
    nodeId;
  const relationLabel = (relationId: string) =>
    state.canonical.relations[relationId]?.label ?? relationId;

  return delta.operations.map((operation, index) => {
    const id = `${delta.id}:operation:${index + 1}`;
    switch (operation.op) {
      case "node.patch": {
        const details: string[] = [];
        const before = briefNodes.get(operation.nodeId);
        if (operation.patch.knowledge) {
          const standing = operation.patch.knowledge.standing;
          const freshness = operation.patch.knowledge.freshness;
          details.push(
            `Knowledge · ${before?.knowledge ? `${sentenceCase(before.knowledge.standing)} / ${sentenceCase(before.knowledge.freshness)}` : "Unspecified"} → ${sentenceCase(standing ?? before?.knowledge?.standing ?? "unchanged")} / ${sentenceCase(freshness ?? before?.knowledge?.freshness ?? "unchanged")}`,
          );
        }
        if (operation.patch.governance) {
          const standing = operation.patch.governance.standing;
          const approval = operation.patch.governance.approval;
          details.push(
            `Governance · ${before?.governance ? `${sentenceCase(before.governance.standing)} / ${sentenceCase(before.governance.approval)}` : "Unspecified"} → ${sentenceCase(standing ?? before?.governance?.standing ?? "unchanged")} / ${sentenceCase(approval ?? before?.governance?.approval ?? "unchanged")}`,
          );
        }
        if (operation.patch.work) {
          const phase = operation.patch.work.phase;
          const verification = operation.patch.work.verification;
          details.push(
            `Work · ${before?.work ? `${sentenceCase(before.work.phase)} / ${sentenceCase(before.work.verification)}` : "Unspecified"} → ${sentenceCase(phase ?? before?.work?.phase ?? "unchanged")} / ${sentenceCase(verification ?? before?.work?.verification ?? "unchanged")}`,
          );
        }
        if (operation.patch.sourceRefs) {
          details.push(
            `${operation.patch.sourceRefs.length} durable provenance source(s) linked`,
          );
        }
        if (operation.patch.data) {
          const data = operation.patch.data;
          if (typeof data.resultClosureId === "string") {
            details.push(`Closure ${data.resultClosureId} linked`);
          }
          if (typeof data.resultValidationId === "string") {
            details.push(`Validation ${data.resultValidationId} consumed`);
          }
          if (data.artifactPromotion === "not_performed") {
            details.push("Artifact promotion not performed");
          }
        }
        return {
          id,
          operation: operation.op,
          targetId: operation.nodeId,
          targetLabel: nodeLabel(operation.nodeId),
          summary: `Update ${nodeLabel(operation.nodeId)}`,
          details,
        };
      }
      case "node.add":
        return {
          id,
          operation: operation.op,
          targetId: operation.node.id,
          targetLabel: operation.node.title,
          summary: `Add ${sentenceCase(operation.node.kind)} · ${operation.node.title}`,
          details: [
            operation.node.knowledge
              ? `Knowledge · ${sentenceCase(operation.node.knowledge.standing)} · ${sentenceCase(operation.node.knowledge.freshness)}`
              : "No knowledge posture declared",
            `${operation.node.sourceRefs.length} durable evidence source(s) linked`,
          ],
        };
      case "node.retire":
        return {
          id,
          operation: operation.op,
          targetId: operation.nodeId,
          targetLabel: nodeLabel(operation.nodeId),
          summary: `Retire ${nodeLabel(operation.nodeId)} from the current projection`,
          details: ["History and lineage remain addressable"],
        };
      case "relation.add":
        return {
          id,
          operation: operation.op,
          targetId: operation.relation.id,
          targetLabel:
            operation.relation.label ?? sentenceCase(operation.relation.kind),
          summary: `Link ${nodeLabel(operation.relation.fromNodeId)} → ${nodeLabel(operation.relation.toNodeId)}`,
          details: [
            `Relation · ${sentenceCase(operation.relation.kind)}`,
            `${operation.relation.sourceRefs.length} durable evidence source(s) linked`,
          ],
        };
      case "relation.patch":
        return {
          id,
          operation: operation.op,
          targetId: operation.relationId,
          targetLabel: relationLabel(operation.relationId),
          summary: `Update relation ${relationLabel(operation.relationId)}`,
          details: ["Only the displayed relation fields would change"],
        };
      case "relation.retire":
        return {
          id,
          operation: operation.op,
          targetId: operation.relationId,
          targetLabel: relationLabel(operation.relationId),
          summary: `Retire relation ${relationLabel(operation.relationId)}`,
          details: ["History and lineage remain addressable"],
        };
    }
  });
}

function buildReconciliationSurface(input: {
  ledger: WorldstateLedger;
  state: WorldstateState;
  brief: AgentBrief | null;
  closure: ClosureWitness | null;
  validation: EvidenceValidationSurface | null;
  persistence: WorkbenchViewModel["persistence"];
  operationState: WorkOperationState;
  requestedDeltaId?: string | null;
  activeIntegratedRevisionId?: string | null;
}): ReconciliationSurface {
  const projection = reconciliationProjectionForClosure({
    ledger: input.ledger,
    state: input.state,
    closureId: input.closure?.id ?? null,
    requestedDeltaId: input.requestedDeltaId,
  });
  const artifact = projection
    ? reconciliationArtifactForProjection(input.state, projection)
    : null;
  const acceptedRevisionId =
    projection?.acceptedRevisionId ?? input.activeIntegratedRevisionId ?? null;
  const candidate: ReconciliationCandidateSurface | null =
    projection && artifact
      ? {
          id: projection.delta.id,
          disposition: projection.disposition,
          baseRevisionId: projection.delta.baseRevisionId,
          closureId: artifact.bindings.closureId,
          validationId: artifact.bindings.validationId,
          acceptedRevisionId,
          proposedBy: { ...projection.delta.proposedBy },
          visibleConsequence: projection.delta.visibleConsequence,
          consequences: reconciliationConsequences(
            input.state,
            projection.delta,
            artifact.bindings.briefId,
          ),
          rationale: [...projection.delta.rationale],
          uncertainty: [...projection.delta.uncertainty],
          alternatives: [...projection.delta.alternatives],
          artifactBaseRef: artifact.bindings.artifactBaseRef,
          codexExchangeSourceId: artifact.bindings.codexExchangeSourceId,
          validationExchangeSourceId:
            artifact.bindings.validationExchangeSourceId,
          verificationScope: artifact.verificationScope,
          causalExecutionEstablished: artifact.causalExecutionEstablished,
          causalAuthorshipEstablished: false,
          artifactPromotion: artifact.artifactPromotion,
        }
      : null;
  const integrated = Boolean(
    candidate?.acceptedRevisionId &&
    projection?.disposition === "accepted" &&
    input.state.canonical.revisions[candidate.acceptedRevisionId]?.deltaId ===
      candidate.id,
  );
  let gate = { allowed: false, verified: false, reasons: [] as string[] };
  if (candidate && integrated) {
    gate = { allowed: true, verified: true, reasons: [] };
  } else if (candidate) {
    try {
      const evaluated = evaluateIntegrationGate(input.state, candidate.id);
      gate = {
        allowed: evaluated.allowed,
        verified: evaluated.verified,
        reasons: [...evaluated.reasons],
      };
    } catch (error) {
      gate = {
        allowed: false,
        verified: false,
        reasons: [
          error instanceof Error && error.message.trim()
            ? error.message
            : "integration_gate_unavailable",
        ],
      };
    }
  }
  const baseCurrent = Boolean(
    candidate && candidate.baseRevisionId === input.state.canonical.head.id,
  );
  const lineageCurrent = Boolean(
    candidate &&
    input.closure?.id === candidate.closureId &&
    input.validation?.id === candidate.validationId,
  );
  const artifactCurrent = Boolean(
    candidate &&
    input.closure?.artifactBaseRef === candidate.artifactBaseRef &&
    input.brief?.artifactBaseRef === candidate.artifactBaseRef,
  );
  const evidenceCurrent = Boolean(
    input.validation?.verdict === "verified" &&
    (input.validation.consumedByRevisionId === null || integrated),
  );
  const dispositionReady = projection?.disposition === "pending";
  const consumedEvidenceRefs = candidate
    ? [candidate.validationExchangeSourceId, candidate.codexExchangeSourceId]
    : [];
  const checks: ReconciliationGateCheckSurface[] = candidate
    ? [
        {
          id: "worldstate-base",
          label: "Worldstate base",
          status: integrated ? "consumed" : baseCurrent ? "passed" : "stale",
          detail: integrated
            ? `Base ${candidate.baseRevisionId} was consumed by revision ${candidate.acceptedRevisionId}.`
            : baseCurrent
              ? `Candidate and canonical head both name ${candidate.baseRevisionId}.`
              : `Candidate base ${candidate.baseRevisionId} does not match current head ${input.state.canonical.head.id}.`,
          evidenceRefs: [candidate.baseRevisionId],
        },
        {
          id: "closure-lineage",
          label: "Closure lineage",
          status: integrated
            ? "consumed"
            : lineageCurrent
              ? "passed"
              : "blocked",
          detail: lineageCurrent
            ? `Closure ${candidate.closureId} and validation ${candidate.validationId} are bound to this candidate.`
            : "The displayed closure and validation do not match the candidate lineage.",
          evidenceRefs: [candidate.closureId, candidate.validationId],
        },
        {
          id: "artifact-base",
          label: "Artifact base",
          status: integrated
            ? "consumed"
            : artifactCurrent
              ? "passed"
              : "blocked",
          detail: artifactCurrent
            ? `Brief and closure both name ${candidate.artifactBaseRef}.`
            : "Brief, closure, and candidate artifact bases do not match.",
          evidenceRefs: [candidate.artifactBaseRef],
        },
        {
          id: "independent-evidence",
          label: "Independent evidence",
          status: integrated
            ? "consumed"
            : evidenceCurrent
              ? "passed"
              : "blocked",
          detail: integrated
            ? `Validation ${candidate.validationId} was consumed by the accepted revision.`
            : evidenceCurrent
              ? `Validation ${candidate.validationId} satisfies every required check on the candidate base.`
              : "Current independent evidence does not satisfy the candidate.",
          evidenceRefs: consumedEvidenceRefs,
        },
        {
          id: "integration-policy",
          label: "Integration policy",
          status: integrated
            ? "consumed"
            : gate.allowed && gate.verified
              ? "passed"
              : "blocked",
          detail: gate.allowed
            ? gate.verified
              ? "The evidence-blocking policy is satisfied with verified evidence."
              : "Policy alone permits unverified integration, but this candidate marks work verified and therefore requires a verified gate."
            : `Integration remains blocked${gate.reasons.length ? `: ${gate.reasons.join(", ")}` : "."}`,
          evidenceRefs: consumedEvidenceRefs,
        },
        {
          id: "candidate-disposition",
          label: "Candidate disposition",
          status: integrated
            ? "consumed"
            : dispositionReady
              ? "passed"
              : "blocked",
          detail: integrated
            ? `Candidate accepted in ${candidate.acceptedRevisionId}.`
            : `Candidate is ${candidate.disposition}; only a pending candidate may be integrated.`,
          evidenceRefs: [candidate.id],
        },
      ]
    : [];

  const persistenceReady = input.persistence.state === "saved";
  const operationIdle = input.operationState === "idle";
  const currentValidatedResult = Boolean(
    input.closure?.outcome === "returned" &&
    input.validation?.verdict === "verified" &&
    input.validation.verifierExchangeGrounded &&
    input.validation.consumedByRevisionId === null &&
    input.closure.baseRevisionId === input.state.canonical.head.id &&
    input.brief?.baseRevisionId === input.state.canonical.head.id,
  );
  const canPropose =
    !projection &&
    currentValidatedResult &&
    persistenceReady &&
    operationIdle &&
    !input.requestedDeltaId;
  const canIntegrate = Boolean(
    candidate &&
    !integrated &&
    dispositionReady &&
    baseCurrent &&
    gate.allowed &&
    gate.verified &&
    persistenceReady &&
    operationIdle,
  );
  const proposalGateReason = projection
    ? !candidate
      ? "The durable reconciliation receipt is invalid or missing; raw source content is withheld and canonical worldstate remains unchanged."
      : integrated
        ? `Reconciliation ${projection.delta.id} was accepted in ${acceptedRevisionId}.`
        : `Reconciliation ${projection.delta.id} is durable and ${projection.disposition}. Canonical worldstate is unchanged.`
    : !input.closure || input.closure.outcome !== "returned"
      ? "A coherent returned closure is required before reconciliation can be prepared."
      : !input.validation
        ? "Independent evidence validation must be recorded before reconciliation can be prepared."
        : input.validation.verdict === "stale"
          ? "The independent validation is stale. Reconciliation cannot silently rebase it."
          : input.validation.verdict !== "verified"
            ? "Every required evidence condition must be verified before this registered reconciliation candidate can be compiled."
            : !input.validation.verifierExchangeGrounded
              ? "The validation is not grounded in the exact registered replay-verifier exchange required by the reconciliation compiler."
              : !persistenceReady
                ? `The browser ledger is ${input.persistence.state}; reconciliation preparation remains unavailable.`
                : input.operationState === "proposing_reconciliation"
                  ? "The deterministic candidate and its integrity-bound receipt are being saved without canonical mutation."
                  : "Prepare a deterministic reconciliation candidate from the displayed closure and independent evidence. This changes no canonical state.";
  const integrationGateReason = !candidate
    ? projection
      ? "The durable reconciliation receipt is invalid or missing; raw source content is not projected."
      : "Prepare and review a reconciliation candidate before human integration."
    : integrated
      ? `Human integration accepted this candidate in revision ${candidate.acceptedRevisionId}.`
      : !baseCurrent
        ? `Candidate base ${candidate.baseRevisionId} is stale against current head ${input.state.canonical.head.id}. It cannot be silently rebased.`
        : projection?.disposition !== "pending"
          ? `Candidate disposition is ${projection?.disposition}; integration requires a pending candidate.`
          : !gate.allowed || !gate.verified
            ? `The kernel integration gate is blocked${gate.reasons.length ? `: ${gate.reasons.join(", ")}` : gate.verified ? "." : ": this candidate requires verified evidence."}`
            : !persistenceReady
              ? `The browser ledger is ${input.persistence.state}; human integration remains unavailable.`
              : input.operationState === "integrating_result"
                ? "The reviewed candidate is being committed by the human integration boundary."
                : "All displayed gate checks pass. Integrating creates one canonical revision; it does not promote or deploy artifact files.";
  const state: ReconciliationSurface["state"] =
    input.operationState === "proposing_reconciliation"
      ? "proposing"
      : input.operationState === "integrating_result"
        ? "integrating"
        : integrated
          ? "integrated"
          : projection && !artifact
            ? "failed"
            : candidate && !baseCurrent
              ? "stale"
              : candidate &&
                  (!gate.allowed ||
                    !gate.verified ||
                    projection?.disposition !== "pending")
                ? "blocked"
                : candidate
                  ? "candidate"
                  : canPropose
                    ? "eligible"
                    : "unavailable";

  return {
    state,
    candidate,
    gate: { ...gate, checks },
    canPropose,
    canIntegrate,
    proposalGateReason,
    integrationGateReason,
  };
}

function buildArtifactPromotionSurface(input: {
  readonly state: WorldstateState;
  readonly reconciliation: ReconciliationSurface;
  readonly persistence: WorkbenchViewModel["persistence"];
  readonly operationState: WorkOperationState;
  readonly requestedPromotionId?: string | null;
  readonly hostAttestedPromotionReceiptDigests?: Readonly<
    Record<string, string>
  >;
}): ArtifactPromotionSurface {
  const reconciliationId = input.reconciliation.candidate?.id ?? null;
  const inferred = reconciliationId
    ? Object.values(input.state.operational.artifactPromotions).find(
        (projection) =>
          projection.proposal.reconciliationDeltaId === reconciliationId,
      )
    : undefined;
  const selected =
    input.requestedPromotionId !== undefined
      ? input.requestedPromotionId
        ? input.state.operational.artifactPromotions[
            input.requestedPromotionId
          ]
        : undefined
      : inferred;
  const proposal = selected?.proposal;
  const terminalReceiptSource = selected?.latestOutcome
    ? input.state.operational.sources[selected.latestOutcome.responseSourceId]
    : undefined;
  const terminalReceipt = terminalReceiptSource
    ? parseArtifactPromotionResponseSource(terminalReceiptSource)?.receipt
    : null;
  const terminalReceiptDigest = terminalReceipt
    ? `sha256:${artifactIdentitySha256Hex(stableStringify(terminalReceipt))}`
    : null;
  const hostAttested = Boolean(
    proposal &&
      terminalReceipt &&
      terminalReceiptDigest &&
      input.hostAttestedPromotionReceiptDigests?.[proposal.id] ===
        terminalReceiptDigest,
  );
  const terminalClaim = Boolean(
    selected &&
      (selected.status === "promoted" ||
        selected.status === "stale" ||
        selected.status === "failed" ||
        selected.status === "outcome_unknown"),
  );
  const currentHead = input.state.canonical.head.id;
  const semanticallyIntegrated = Boolean(
    input.reconciliation.state === "integrated" &&
      input.reconciliation.candidate?.verificationScope ===
        "sealed_live_candidate" &&
      input.reconciliation.candidate.causalExecutionEstablished &&
      input.reconciliation.candidate.acceptedRevisionId === currentHead,
  );
  const stale = Boolean(
    proposal && proposal.integratedRevisionId !== currentHead,
  );
  const persistenceReady = input.persistence.state === "saved";
  const idle = input.operationState === "idle";
  const canPropose =
    !selected && semanticallyIntegrated && persistenceReady && idle;
  const canPromote = Boolean(
    selected &&
      (selected.status === "proposed" || selected.status === "authorized") &&
      !stale &&
      persistenceReady &&
      idle,
  );
  const candidate = proposal
    ? {
        id: proposal.id,
        candidateId: proposal.candidateId,
        repositoryId: proposal.repositoryId,
        targetRef: proposal.targetRef,
        expectedBaseCommit: proposal.expectedBaseCommit,
        candidateCommit: proposal.candidateCommit,
        candidateTree: proposal.candidateTree,
        manifestDigest: proposal.manifestDigest,
        patchDigest: proposal.patchDigest,
        changedPaths: proposal.changedPaths.map((entry) => ({ ...entry })),
        integratedRevisionId: proposal.integratedRevisionId,
        status: selected.status,
        observedTargetCommit:
          selected.latestOutcome?.observedTargetCommit ?? null,
        observedAt: terminalReceipt?.observedAt ?? null,
      }
    : null;

  const state: ArtifactPromotionSurface["state"] =
    input.operationState === "proposing_promotion"
      ? "proposing"
      : input.operationState === "authorizing_promotion"
        ? "authorizing"
        : input.operationState === "promoting_artifact"
          ? "promoting"
          : input.operationState === "persisting_promotion_receipt"
            ? "persisting"
            : terminalClaim && !hostAttested
              ? "unattested"
            : stale || selected?.status === "stale"
              ? "stale"
              : selected?.status === "promoted"
                ? "promoted"
                : selected?.status === "failed"
                  ? "failed"
                  : selected?.status === "outcome_unknown"
                    ? "outcome_unknown"
                    : selected?.status === "authorized"
                      ? "authorized"
                      : selected?.status === "proposed"
                        ? "proposed"
                        : canPropose
                          ? "eligible"
                          : "unavailable";
  const gateReason = candidate
    ? state === "unattested"
      ? "The browser ledger contains a terminal promotion claim that the host journal has not re-attested. Authoritative success and failure rendering are suppressed."
      : state === "promoted"
      ? `A host-attested receipt observed ${candidate.targetRef} at ${candidate.candidateCommit}${candidate.observedAt ? ` on ${candidate.observedAt}` : ""}. This is historical evidence, not a claim about the ref's current value. Semantic head ${currentHead} was not changed by promotion.`
      : state === "stale"
        ? `Promotion ${candidate.id} is stale against semantic head ${currentHead}; no rebase or ref update is permitted.`
        : state === "failed"
          ? "The signed server outcome records that the candidate was not promoted."
          : state === "outcome_unknown"
            ? "The signed server journal cannot establish the target-ref outcome. No authoritative success is shown."
            : state === "authorized"
              ? "The exact request and human authorization are durable. An explicit retry may read or recover the server journal before any further CAS decision."
              : state === "proposed"
                ? "Review the exact candidate, base, target ref, and changed paths. Promotion requires a separate human action and server-side revalidation."
                : "The promotion boundary is processing this exact candidate; no success is shown until a signed receipt is durable."
    : semanticallyIntegrated
      ? "The integrated live result is eligible for a separate artifact-promotion proposal. Preparing it does not move a Git ref."
      : input.reconciliation.state === "integrated"
        ? "This integrated result has no independently executed sealed live candidate, so artifact promotion is unavailable."
        : "Integrate an independently validated sealed live candidate before proposing artifact promotion.";

  return { state, candidate, canPropose, canPromote, gateReason };
}

function workRuntime(
  indexed: IndexedCodexRunExchange | null,
  run: AgentRunSurface | null,
  exchangeDisposition: CodexExchangeEvidenceSurface["disposition"] | null,
): WorkSurface["runtime"] {
  if (run?.status === "outcome_unknown") {
    return {
      mode: indexed?.exchange.response.runtime.effectiveMode ?? run.mode,
      requestedMode:
        indexed?.exchange.response.runtime.requestedMode ?? run.mode,
      effectiveMode: indexed?.exchange.response.runtime.effectiveMode ?? null,
      status: run.status,
      provider: indexed?.exchange.response.runtime.provider ?? "codex",
      replayIdentity: null,
      replayKind: null,
      label: "Codex outcome not observed",
    };
  }
  if (!indexed) {
    if (!run) {
      return {
        mode: "unavailable",
        requestedMode: null,
        effectiveMode: null,
        status: "not_authorized",
        provider: null,
        replayIdentity: null,
        replayKind: null,
        label: "No worker runtime authorized",
      };
    }
    if (exchangeDisposition === "quarantined") {
      return {
        mode: run.mode,
        requestedMode: run.mode,
        effectiveMode: null,
        status: "quarantined",
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
        label: "Codex exchange quarantined",
      };
    }
    return {
      mode: run.mode,
      requestedMode: run.mode,
      effectiveMode: null,
      status: run.status,
      provider: "codex",
      replayIdentity: null,
      replayKind: null,
      label:
        run.mode === "replay"
          ? "Fixture replay authorized · response pending"
          : "Live Codex run authorized · response pending",
    };
  }

  const runtime = indexed.exchange.response.runtime;
  const mode = runtime.effectiveMode ?? run?.mode ?? "unavailable";
  const replayIdentity = runtime.replayIdentity;
  return {
    mode,
    requestedMode: runtime.requestedMode,
    effectiveMode: runtime.effectiveMode,
    status: runtime.status,
    provider: runtime.provider,
    replayIdentity,
    replayKind: runtime.replayKind,
    label: replayIdentity
      ? `Fixture replay · ${replayIdentity}`
      : runtime.effectiveMode === "live"
        ? `Live Codex · ${runtime.status}`
        : `Codex ${runtime.status}`,
  };
}

function workAuthority(
  brief: AgentBriefSurface | null,
  run: AgentRunSurface | null,
  exchangeDisposition: CodexExchangeEvidenceSurface["disposition"] | null,
): WorkSurface["authority"] {
  if (!brief) {
    return {
      state: "absent",
      label: "Not granted",
      detail: "No durable brief or worker permission exists.",
    };
  }
  if (!run) {
    return {
      state: "prepared",
      label: "Prepared · not granted",
      detail: `Brief ${brief.id} can be reviewed without starting work.`,
    };
  }
  if (
    exchangeDisposition === "quarantined" ||
    ["blocked", "outcome_unknown", "returned", "failed", "cancelled"].includes(
      run.status,
    )
  ) {
    return {
      state: "used",
      label: "Used",
      detail:
        exchangeDisposition === "quarantined"
          ? `One-run authority was used by ${run.id}; its returned exchange was quarantined.`
          : `One-run authority was used by ${run.id}; status is ${run.status}.`,
    };
  }
  return {
    state: "granted",
    label: "Granted once",
    detail: `${run.mode === "replay" ? "Fixture replay" : "Live Codex"} run ${run.id} only.`,
  };
}

function buildWorkSurface(input: {
  ledger: WorldstateLedger;
  state: WorldstateState;
  placement: PlacementSurface;
  persistence: WorkbenchViewModel["persistence"];
  operation?: BuildWorkbenchViewModelInput["workOperation"];
  unavailableReason?: string;
}): WorkSurface {
  const inferred = latestWorkIds(input.ledger);
  const requestedBriefId =
    input.operation?.activeBriefId !== undefined
      ? input.operation.activeBriefId
      : inferred.briefId;
  const requestedRunId =
    input.operation?.activeRunId !== undefined
      ? input.operation.activeRunId
      : inferred.runId;
  const requestedClosureId =
    input.operation?.activeClosureId !== undefined
      ? input.operation.activeClosureId
      : inferred.closureId;
  const briefRecord = requestedBriefId
    ? (input.state.operational.briefs[requestedBriefId] ?? null)
    : null;
  const runProjection = requestedRunId
    ? (input.state.operational.runs[requestedRunId] ?? null)
    : null;
  const closure = requestedClosureId
    ? (input.state.operational.closures[requestedClosureId] ?? null)
    : null;
  const projectedBrief = briefRecord
    ? projectBrief(briefRecord, input.state.canonical.head.id)
    : null;
  const projectedRun = runProjection
    ? projectRun(
        input.ledger,
        runProjection.run,
        runProjection.status,
        input.state.canonical.head.id,
      )
    : null;
  const indexedExchange = latestCodexRunExchange(
    input.ledger,
    projectedRun?.id ?? null,
  );
  const indexedAttempt = latestCodexRunAttempt(
    input.ledger,
    projectedRun?.id ?? null,
  );
  const indexedNormalizationFailure = latestCodexRunNormalizationFailure(
    input.ledger,
    projectedRun?.id ?? null,
  );
  const normalizationFailure = indexedNormalizationFailure
    ? projectNormalizationFailure(indexedNormalizationFailure)
    : null;
  const activeRequestId =
    input.operation?.activeAgentRequestId !== undefined
      ? input.operation.activeAgentRequestId
      : (indexedAttempt?.attempt.request.requestId ?? null);
  const projectedExchange =
    indexedExchange && runProjection && briefRecord
      ? projectExchangeEvidence({
          indexed: indexedExchange,
          run: runProjection.run,
          brief: briefRecord,
          attempt: indexedAttempt,
          activeRequestId,
        })
      : null;
  const exchangeEvidence = projectedExchange?.evidence ?? null;
  const projectedResult = (() => {
    if (normalizationFailure?.code === "coherence_rejected") return null;
    if (projectedExchange) {
      return projectedExchange.coherent && indexedExchange
        ? exactExchangeResult(
            indexedExchange,
            closure,
            input.state.canonical.head.id,
          )
        : null;
    }
    return closure
      ? normalizedClosureResult(closure, input.state.canonical.head.id)
      : null;
  })();
  const validation = projectEvidenceValidation({
    state: input.state,
    closure,
    brief: briefRecord,
  });
  const adoptedTargetId =
    input.placement.state === "adopted" ? input.placement.candidateId : null;
  const adoptedTarget = adoptedTargetId
    ? input.state.canonical.nodes[adoptedTargetId]
    : undefined;
  const replayScenarioSupported =
    isRegisteredMovingCostReplayTarget(adoptedTarget);
  const eligibleTargetId = replayScenarioSupported ? adoptedTargetId : null;
  const targetNodeId = projectedBrief?.targetNodeId ?? adoptedTargetId;
  const targetLabel = targetNodeId
    ? (input.state.canonical.nodes[targetNodeId]?.title ??
      input.placement.proposedTitle)
    : null;
  const operationState = input.operation?.state ?? "idle";
  const reconciliation = buildReconciliationSurface({
    ledger: input.ledger,
    state: input.state,
    brief: briefRecord,
    closure,
    validation,
    persistence: input.persistence,
    operationState,
    requestedDeltaId: input.operation?.activeReconciliationDeltaId,
    activeIntegratedRevisionId: input.operation?.activeIntegratedRevisionId,
  });
  const artifactPromotion = buildArtifactPromotionSurface({
    state: input.state,
    reconciliation,
    persistence: input.persistence,
    operationState,
    requestedPromotionId: input.operation?.activeArtifactPromotionId,
    hostAttestedPromotionReceiptDigests:
      input.operation?.hostAttestedArtifactPromotionReceiptDigests,
  });
  const consumedByIntegration = reconciliation.state === "integrated";
  const brief =
    projectedBrief && consumedByIntegration
      ? { ...projectedBrief, stale: false }
      : projectedBrief;
  const run =
    projectedRun && consumedByIntegration
      ? { ...projectedRun, stale: false }
      : projectedRun;
  const result =
    projectedResult && consumedByIntegration
      ? { ...projectedResult, stale: false }
      : projectedResult;
  const stale = Boolean(brief?.stale || run?.stale || result?.stale);
  const quarantined = exchangeEvidence?.disposition === "quarantined";

  let state: WorkSurfaceState;
  if (run?.status === "outcome_unknown") state = "outcome_unknown";
  else if (quarantined) state = "quarantined";
  else if (stale) state = "stale";
  else if (operationState === "preparing_brief") state = "preparing";
  else if (operationState === "authorizing_run") state = "authorizing";
  else if (operationState === "dispatching_run") state = "dispatching";
  else if (operationState === "persisting_run_result")
    state = "persisting_result";
  else if (run) state = run.status;
  else if (brief) state = "previewable";
  else if (eligibleTargetId) state = "eligible";
  else state = "ineligible";

  const persistenceReady = input.persistence.state === "saved";
  const canPrepare =
    state === "eligible" && persistenceReady && operationState === "idle";
  const canAuthorize =
    state === "previewable" &&
    persistenceReady &&
    operationState === "idle" &&
    !brief?.stale;
  const canRetryDispatch =
    run?.mode === "live" &&
    run.status === "queued" &&
    persistenceReady &&
    operationState === "idle" &&
    !stale &&
    input.operation?.error?.code === "delegation_not_started" &&
    Boolean(indexedAttempt?.attempt.request.authorization) &&
    indexedAttempt?.attempt.request.requestId === activeRequestId;
  const canRetryUnobservedValidation =
    input.operation?.error?.code === "validation_outcome_unobserved" &&
    Boolean(input.operation.activeValidationRequestId);
  const canValidate =
    state === "returned" &&
    persistenceReady &&
    operationState === "idle" &&
    validation === null &&
    closure?.outcome === "returned" &&
    closure.baseRevisionId === input.state.canonical.head.id &&
    briefRecord?.baseRevisionId === input.state.canonical.head.id &&
    projectedExchange?.coherent === true &&
    ((exchangeEvidence?.effectiveMode === "replay" &&
      Boolean(exchangeEvidence.replayIdentity)) ||
      (exchangeEvidence?.effectiveMode === "live" &&
        Boolean(result?.artifactCandidate))) &&
    (!input.operation?.activeValidationRequestId ||
      canRetryUnobservedValidation);
  const prepareGateReason =
    state === "ineligible"
      ? adoptedTargetId && !replayScenarioSupported
        ? "This Task does not match the registered moving-cost fixture replay scenario."
        : (input.unavailableReason ?? DEFAULT_WORK_REASON)
      : !persistenceReady
        ? `The browser ledger is ${input.persistence.state}; brief preparation remains unavailable.`
        : state === "eligible"
          ? "Preparing a brief saves a reviewable projection only. It grants no worker authority."
          : state === "preparing"
            ? "The bounded brief is being compiled and saved before it can be reviewed."
            : brief
              ? `Brief ${brief.id} is durable and bound to ${brief.baseRevisionId}.`
              : "Brief preparation is unavailable while another work transition is active.";
  const dispatchGateReason = !brief
    ? "Prepare and inspect a durable brief before authorizing any worker."
    : stale
      ? `Brief base ${brief.baseRevisionId} no longer matches current head ${input.state.canonical.head.id}. No new authority can be granted.`
      : !persistenceReady
        ? `The browser ledger is ${input.persistence.state}; dispatch authority remains unavailable.`
        : operationState === "authorizing_run"
          ? "Saving one-run replay authority before the worker request is sent."
          : operationState === "dispatching_run"
            ? "The durable replay run is authorized and the bounded request is in flight."
            : operationState === "persisting_run_result"
              ? "The exact replay exchange, lifecycle, and any lawful closure are being saved."
              : canRetryDispatch
                ? `The private server confirms request ${activeRequestId} never started. Retry that exact durable signed request without granting new authority.`
              : quarantined
                ? "The persisted exchange failed coherence checks. Its one-run authority is spent and no report or closure is projected."
                : run
                  ? `Run ${run.id} already used the displayed one-run authority and is ${run.status}.`
                  : "All displayed brief evidence is durable. Authorize one fixture replay; canonical worldstate will remain unchanged.";
  const validationGateReason = validation
    ? validation.verdict === "verified"
      ? validation.consumedByRevisionId
        ? `${validation.requiredPassed}/${validation.requiredTotal} required checks were independently observed and consumed by revision ${validation.consumedByRevisionId}.`
        : `${validation.requiredPassed}/${validation.requiredTotal} required checks were independently observed on current bases. Evidence is recorded; canonical worldstate is unchanged.`
      : validation.verdict === "stale"
        ? "Independent evidence is recorded, but its base is stale and cannot satisfy the current evidence posture."
        : `${validation.requiredPassed}/${validation.requiredTotal} required checks passed independent fixture verification. Canonical worldstate remains unchanged.`
    : !closure || closure.outcome !== "returned"
      ? "A coherent returned closure is required before independent validation can run."
      : stale
        ? "The closure or brief is stale; independent validation cannot silently rebase it."
        : quarantined || projectedExchange?.coherent !== true
          ? "The exact worker exchange is not coherent, so no independent validation request can be bound to it."
          : !(
                (exchangeEvidence?.effectiveMode === "replay" &&
                  Boolean(exchangeEvidence.replayIdentity)) ||
                (exchangeEvidence?.effectiveMode === "live" &&
                  Boolean(result?.artifactCandidate))
              )
            ? "Independent validation requires either the registered fixture bundle or an exact sealed live candidate."
            : input.operation?.activeValidationRequestId &&
                !canRetryUnobservedValidation
              ? `Validation request ${input.operation.activeValidationRequestId} already has an observed response or cannot be retried safely.`
              : !persistenceReady
                ? `The browser ledger is ${input.persistence.state}; validation remains unavailable.`
                : operationState === "validating_evidence"
                  ? "The independent fixture verifier is inspecting the replay artifact and running fixed checks."
                  : operationState === "persisting_validation"
                    ? "The exact verifier response is durable; the evidence-validation record is being saved."
                    : canRetryUnobservedValidation
                      ? `Retry exact durable validation request ${input.operation?.activeValidationRequestId}; no new request identity or authority will be created.`
                      : "Run the independent verifier against the exact registered fixture bundle or sealed live candidate; worker claims are never accepted as proof.";
  const runtime = workRuntime(
    projectedExchange?.coherent ? indexedExchange : null,
    run,
    exchangeEvidence?.disposition ?? null,
  );
  const reason =
    input.operation?.error?.message ??
    (state === "quarantined"
      ? "The exact Codex exchange failed immutable run coherence checks. Its evidence is preserved, but no worker report or closure is projected."
      : state === "outcome_unknown"
        ? "The run reached outcome_unknown. No trustworthy terminal outcome or closure can be inferred."
        : state === "returned"
          ? "A worker closure is staged for review. It is a claim, not verified worldstate."
          : state === "blocked"
            ? "The worker is blocked. Its report is preserved without a closure witness."
            : state === "failed"
              ? "The worker run failed. Any returned evidence remains non-canonical."
              : state === "cancelled"
                ? "The worker run was cancelled without changing canonical worldstate."
                : brief
                  ? dispatchGateReason
                  : prepareGateReason);

  return {
    state,
    available: state !== "ineligible",
    reason,
    targetNodeId,
    targetLabel,
    brief,
    run,
    exchangeEvidence,
    normalizationFailure,
    result,
    validation,
    reconciliation,
    artifactPromotion,
    canPrepare,
    canAuthorize,
    canRetryDispatch,
    canValidate,
    prepareGateReason,
    dispatchGateReason,
    validationGateReason,
    authority: workAuthority(brief, run, exchangeEvidence?.disposition ?? null),
    runtime,
    errorCode: input.operation?.error?.code ?? null,
    errorMessage: input.operation?.error?.message ?? null,
  };
}

/**
 * Projects immutable ledger truth into the workbench's read model. The adapter
 * may expose a pending placement as provisional, but it never turns that
 * proposal into canonical state; only the reducer's accepted revision can.
 */
export function buildWorkbenchViewModel(
  input: BuildWorkbenchViewModelInput,
): WorkbenchViewModel {
  const persistence = input.persistence ?? {
    state: "saved" as const,
    detail: "Browser ledger is persisted.",
  };
  const latestExchange = latestPlacementExchange(input.ledger);
  const latestAttempt = latestPlacementAttempt(input.ledger);
  const plainSource = latestPlainSharedSource(input.ledger);
  const latestPlainSourceIndex = plainSource?.index ?? -1;
  const activeAttempt =
    latestAttempt && latestAttempt.index > latestPlainSourceIndex
      ? latestAttempt
      : null;
  const activeExchange = activeAttempt
    ? placementExchangeForAttempt(input.ledger, activeAttempt)
    : latestExchange && latestPlainSourceIndex < latestExchange.index
      ? latestExchange
      : null;
  const activeSourceId =
    activeAttempt?.attempt.request.source.sourceId ??
    activeExchange?.exchange.request.source.sourceId ??
    plainSource?.event.payload.source.id ??
    null;
  const activeBoundary = Math.max(
    latestPlainSourceIndex,
    activeAttempt?.index ?? -1,
    activeExchange?.index ?? -1,
  );
  const activeFailure = latestManagerFailure(input.ledger, {
    afterIndex: activeBoundary,
    sourceId: activeSourceId,
  });
  const runtime = activeExchange
    ? runtimeFromExchange(activeExchange.exchange)
    : activeFailure
      ? {
          mode: "unavailable" as const,
          label: `Placement manager unavailable · ${activeFailure.event.payload.code}`,
        }
      : latestExchange
        ? runtimeFromExchange(latestExchange.exchange)
        : (input.runtimeFallback ?? {
            mode: "unavailable" as const,
            label: "Placement manager has not been observed in this ledger.",
          });
  const placementResult = buildPlacementSurface({
    ledger: input.ledger,
    state: input.state,
    attempt: activeAttempt,
    exchange: activeExchange,
    failure: activeFailure,
    operation: input.placementOperation ?? {
      state: "idle",
      sourceId: activeExchange ? null : activeSourceId,
    },
    persistence,
    runtime,
  });
  const overlay = overlayFromProjection(placementResult.projection);
  const projection = buildProjectionRecords(input.state, overlay);
  const projectNode = projection.nodes.find((node) => node.kind === "project");
  const worldNode = projection.nodes.find((node) => node.kind === "world");
  const work = buildWorkSurface({
    ledger: input.ledger,
    state: input.state,
    placement: placementResult.placement,
    persistence,
    operation: input.workOperation,
    unavailableReason: input.workUnavailableReason,
  });

  return {
    world: input.worldLabel ?? worldNode?.label ?? DEFAULT_WORLD_LABEL,
    project: input.projectLabel ?? projectNode?.label ?? DEFAULT_PROJECT_LABEL,
    revision: displayRevision(input.state.canonical.head),
    projectId: input.state.canonical.projectId,
    projectNodeId: projectNode?.id ?? input.state.canonical.projectId,
    nodes: projection.nodes,
    relations: projection.relations,
    events: input.ledger.events.flatMap((event) => {
      const projected = timelineEvent(event, input.state);
      return projected ? [projected] : [];
    }),
    placement: placementResult.placement,
    persistence,
    runtime,
    work,
  };
}
