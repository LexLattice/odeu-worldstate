import type {
  PlacementAttempt,
  PlacementExchange,
} from "@/integration/placement-evidence";
import {
  parsePlacementAttemptSource,
  parsePlacementExchangeSource,
} from "@/integration/placement-evidence";
import type {
  DeltaProjection,
  LedgerEvent,
  RevisionRecord,
  WorldstateDelta,
  WorldstateLedger,
  WorldstateNode as KernelNode,
  WorldstateNodeInput,
  WorldstateRelationInput,
  WorldstateState,
} from "@/domain";

import type {
  NodeKind,
  PersistenceSurfaceState,
  PlacementSurface,
  StatusSet,
  WorkbenchViewModel,
  WorldEvent,
  WorldNode,
  WorldRelation,
} from "./types";

const DEFAULT_WORLD_LABEL = "My World";
const DEFAULT_PROJECT_LABEL = "Untitled project";
const DEFAULT_WORK_REASON =
  "Agent execution is not wired for this persisted source yet.";

export type PlacementOperationState = "idle" | "loading";

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

function displayNodeKind(node: Pick<KernelNode | WorldstateNodeInput, "kind" | "data">): NodeKind {
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

function latestPlacementExchange(ledger: WorldstateLedger): IndexedPlacementExchange | null {
  let latest: IndexedPlacementExchange | null = null;

  ledger.events.forEach((event, index) => {
    if (event.type !== "source.captured" || event.payload.source.visibility !== "shared") {
      return;
    }
    const exchange = parsePlacementExchangeSource(event.payload.source);
    if (exchange) latest = { exchange, event, index };
  });

  return latest;
}

function latestPlacementAttempt(ledger: WorldstateLedger): IndexedPlacementAttempt | null {
  let latest: IndexedPlacementAttempt | null = null;

  ledger.events.forEach((event, index) => {
    if (event.type !== "source.captured" || event.payload.source.visibility !== "shared") {
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

function latestPlainSharedSource(
  ledger: WorldstateLedger,
): { event: Extract<LedgerEvent, { type: "source.captured" }>; index: number } | null {
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
        event.type === "source.captured" && event.payload.source.id === sourceId,
    ) ?? null
  );
}

function runtimeFromExchange(exchange: PlacementExchange): WorkbenchViewModel["runtime"] {
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
  const liveIdentity = [manager.provider === "openai" ? "OpenAI" : null, manager.model]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return {
    mode: "live",
    label: manager.status === "failed"
      ? `Live manager failed${liveIdentity ? ` · ${liveIdentity}` : ""}`
      : `Live manager${liveIdentity ? ` · ${liveIdentity}` : ""}`,
  };
}

function managerLabelFromRuntime(runtime: WorkbenchViewModel["runtime"]): string {
  if (runtime.mode === "fixture") return "Fixture placement manager";
  if (runtime.mode === "live") return runtime.label;
  return "Placement manager unavailable";
}

function overlayFromProjection(projection: DeltaProjection | undefined): OverlayRecords {
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
        node.scopeId === state.canonical.projectId && !visibleNodeIds.has(node.id),
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
  const canonicalRelationIds = new Set(canonicalRelations.map((relation) => relation.id));
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
      ...(parentByChild.has(node.id) ? { parentId: parentByChild.get(node.id) } : {}),
      eyebrow: `${titleCaseToken(node.kind)} · Canonical`,
      ...(node.description ? { description: node.description } : {}),
      status: displayStatus(node),
    })),
    ...overlayNodes.map((node): WorldNode => ({
      id: node.id,
      label: node.title,
      kind: displayNodeKind(node),
      ...(parentByChild.has(node.id) ? { parentId: parentByChild.get(node.id) } : {}),
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

function deltaCandidateId(delta: WorldstateDelta | undefined): string | undefined {
  return delta?.operations.find((operation) => operation.op === "node.add")?.node.id;
}

function timelineEvent(event: LedgerEvent, state: WorldstateState): WorldEvent | null {
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
            : exchange.response.receipt.clarificationQuestion ?? "Clarification is required."
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
        ...(event.payload.sourceId ? { worldstateId: event.payload.sourceId } : {}),
      };
    }
    case "delta.proposed":
      return {
        id: event.eventId,
        kind: "evidence",
        label: `${titleCaseToken(event.payload.delta.purpose)} update proposed`,
        detail: event.payload.delta.visibleConsequence,
        time: event.occurredAt,
        revision: event.payload.delta.baseRevisionId,
        worldstateId: deltaCandidateId(event.payload.delta) ?? event.payload.delta.id,
      };
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
        worldstateId: deltaCandidateId(event.payload.replacement) ?? event.payload.deltaId,
      };
    case "delta.accepted": {
      const projection = state.operational.deltas[event.payload.deltaId];
      return {
        id: event.eventId,
        kind: "revision",
        label: "Semantic update adopted",
        detail: `${displayRevision(event.payload.revision)} adopted ${event.payload.deltaId}.`,
        time: event.occurredAt,
        revision: event.payload.revision.id,
        worldstateId: deltaCandidateId(projection?.delta) ?? event.payload.deltaId,
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
    case "run.authorized":
      return {
        id: event.eventId,
        kind: "worker",
        label: "Agent run authorized",
        detail: `${event.payload.run.mode} run ${event.payload.run.id} authorized.`,
        time: event.occurredAt,
        revision: event.payload.run.baseRevisionId,
        worldstateId: event.payload.run.id,
      };
    case "run.lifecycle_recorded":
      return {
        id: event.eventId,
        kind: "worker",
        label: `Agent run ${event.payload.status}`,
        detail: event.payload.message ?? `Run ${event.payload.runId} is ${event.payload.status}.`,
        time: event.occurredAt,
        worldstateId: event.payload.runId,
      };
    case "closure.staged":
      return {
        id: event.eventId,
        kind: "worker",
        label: "Agent closure staged",
        detail: event.payload.closure.summary,
        time: event.occurredAt,
        revision: event.payload.closure.baseRevisionId,
        worldstateId: event.payload.closure.runId,
      };
    case "evidence.validation_recorded":
      return {
        id: event.eventId,
        kind: "evidence",
        label: "Evidence validation recorded",
        detail: `${event.payload.validation.observations.length} evidence observation(s) recorded.`,
        time: event.occurredAt,
        revision: event.payload.validation.baseRevisionId,
        worldstateId: event.payload.validation.closureId,
      };
  }
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
    const source = operationSourceId ? input.state.operational.sources[operationSourceId] : undefined;
    return {
      placement: {
        ...placement,
        sourceId: source?.visibility === "shared" ? source.id : null,
        sourceText: source?.visibility === "shared" ? source.content : null,
        sourceCapturedAt: source?.visibility === "shared" ? capture?.occurredAt ?? null : null,
      },
    };
  }

  if (activeFailure) {
    const sourceId = activeFailure.event.payload.sourceId ?? null;
    const source = sourceId ? input.state.operational.sources[sourceId] : undefined;
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
        sourceCapturedAt: source?.visibility === "shared" ? capture?.occurredAt ?? null : null,
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
            source?.visibility === "shared" ? source.content : request.source.text,
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
    const source = operationSourceId ? input.state.operational.sources[operationSourceId] : undefined;
    return {
      placement: {
        ...placement,
        sourceId: source?.visibility === "shared" ? source.id : null,
        sourceText: source?.visibility === "shared" ? source.content : null,
        sourceCapturedAt: source?.visibility === "shared" ? capture?.occurredAt ?? null : null,
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
        sourceText: source?.visibility === "shared" ? source.content : exchange.request.source.text,
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
    sourceText: source?.visibility === "shared" ? source.content : exchange.request.source.text,
    sourceCapturedAt: capture?.occurredAt ?? null,
    deltaId: exchange.response.delta?.deltaId ?? null,
    candidateId: receipt.proposed.nodeId,
    exchangeId: input.exchange.event.payload.source.id,
    receiptId: receipt.receiptId,
    locationLabel: receipt.location.label,
    breadcrumb: [...receipt.location.breadcrumb],
    proposedKind: receipt.proposed.kind,
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
          Boolean(node) && !node.retiredRevisionId && node.visibility === "shared",
      )
      .map((node) => node.title)
      .sort(compareText),
    visibleConsequence: projection?.delta.visibleConsequence ?? null,
    clarificationQuestion: receipt.clarificationQuestion,
  };

  if (receipt.decisionState === "needs_clarification" || exchange.response.delta === null) {
    return { placement: { ...base, ...receiptFields } };
  }

  if (!projection) {
    return {
      placement: {
        ...base,
        ...receiptFields,
        state: "failed",
        errorCode: "placement_delta_missing",
        errorMessage: "The persisted placement receipt has no matching kernel delta.",
        gateReason: "The placement evidence is incomplete. Semantic commit is unavailable.",
      },
    };
  }

  if (projection.disposition === "accepted") {
    const acceptedRevision = projection.acceptedRevisionId ?? input.state.provenance.deltaToRevisionId[projection.delta.id];
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
        errorMessage: projection.reason ?? `The placement was ${projection.disposition}.`,
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
  const activeExchange =
    activeAttempt
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
  const runtime =
    activeExchange
      ? runtimeFromExchange(activeExchange.exchange)
      : activeFailure
      ? {
          mode: "unavailable" as const,
          label: `Placement manager unavailable · ${activeFailure.event.payload.code}`,
        }
      : latestExchange
        ? runtimeFromExchange(latestExchange.exchange)
        : input.runtimeFallback ?? {
            mode: "unavailable" as const,
            label: "Placement manager has not been observed in this ledger.",
          };
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
    work: {
      available: false,
      reason: input.workUnavailableReason ?? DEFAULT_WORK_REASON,
    },
  };
}
