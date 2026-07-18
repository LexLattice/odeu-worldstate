import { ZodError } from "zod";

import { deepFreeze, fingerprint, stableStringify } from "./determinism";
import { KernelError, invariant } from "./errors";
import {
  IdentifierSchema,
  LedgerEventSchema,
  RevisionRecordSchema,
  TimestampSchema,
  WorldstateDeltaSchema,
  type LedgerEvent,
  type LedgerEventOf,
  type RevisionRecord,
  type SourceRecord,
  type WorldstateDelta,
  type WorldstateNode,
  type WorldstateRelation,
} from "./schema";
import type {
  AppendEventResult,
  CanonicalProjection,
  DeltaProjection,
  OperationalProjection,
  ProvenanceProjection,
  RunProjection,
  WorldstateLedger,
  WorldstateState,
} from "./types";

function parseEvent(event: LedgerEvent): LedgerEvent {
  try {
    return LedgerEventSchema.parse(event);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new KernelError("schema_invalid", "The ledger event does not match the kernel schema.", {
        issues: error.issues,
      });
    }
    throw error;
  }
}

function emptyOperationalProjection(): OperationalProjection {
  return {
    sources: {},
    managerFailures: [],
    deltas: {},
    briefs: {},
    runs: {},
    closures: {},
    validations: {},
    latestValidationByClosure: {},
    artifactPromotions: {},
    selectedProjection: "outline",
  };
}

function emptyProvenanceProjection(): ProvenanceProjection {
  return {
    sourceToDeltaIds: {},
    deltaToRevisionId: {},
    supersession: {},
  };
}

export function createWorldstateLedger(input: {
  projectId: string;
  createdAt: string;
}): WorldstateLedger {
  const projectId = IdentifierSchema.parse(input.projectId);
  const createdAt = TimestampSchema.parse(input.createdAt);
  const stateHash = fingerprint({ nodes: {}, relations: {} });
  const genesisFingerprint = fingerprint({ projectId, createdAt, stateHash });
  const genesisRevision = RevisionRecordSchema.parse({
    id: `rev-0000-${genesisFingerprint.slice(-12)}`,
    number: 0,
    parentRevisionId: null,
    deltaId: null,
    stateHash,
    committedAt: createdAt,
  });

  return deepFreeze({ projectId, genesisRevision, events: [] });
}

function initialState(ledger: WorldstateLedger): WorldstateState {
  return {
    canonical: {
      projectId: ledger.projectId,
      head: ledger.genesisRevision,
      revisions: { [ledger.genesisRevision.id]: ledger.genesisRevision },
      revisionOrder: [ledger.genesisRevision.id],
      nodes: {},
      relations: {},
    },
    operational: emptyOperationalProjection(),
    provenance: emptyProvenanceProjection(),
    eventOrder: [],
  };
}

function assertSourceRefs(state: WorldstateState, refs: readonly string[]): void {
  for (const sourceId of refs) {
    invariant(
      Boolean(state.operational.sources[sourceId]),
      "reference_missing",
      `Source ${sourceId} is not present in the ledger.`,
      { sourceId },
    );
  }
}

function hasValidSemanticIntegrity(source: SourceRecord): boolean {
  if (source.integrity?.algorithm !== "fnv1a64") return false;

  let semanticContent: unknown;
  try {
    semanticContent = JSON.parse(source.content);
  } catch {
    return false;
  }

  return source.integrity.digest === fingerprint(semanticContent);
}

function deltaSourceRefs(delta: WorldstateDelta): readonly string[] {
  const refs = new Set(delta.sourceRefs);
  for (const operation of delta.operations) {
    if (operation.op === "node.add" || operation.op === "relation.add") {
      for (const sourceId of
        operation.op === "node.add" ? operation.node.sourceRefs : operation.relation.sourceRefs) {
        refs.add(sourceId);
      }
    }
    if (
      (operation.op === "node.patch" || operation.op === "relation.patch") &&
      operation.patch.sourceRefs
    ) {
      for (const sourceId of operation.patch.sourceRefs) {
        refs.add(sourceId);
      }
    }
  }
  return [...refs];
}

function activeNode(
  nodes: Readonly<Record<string, WorldstateNode>>,
  nodeId: string,
): WorldstateNode {
  const node = nodes[nodeId];
  invariant(node, "reference_missing", `Node ${nodeId} does not exist.`, { nodeId });
  invariant(
    !node.retiredRevisionId,
    "record_retired",
    `Node ${nodeId} is retired and cannot be changed.`,
    { nodeId, retiredRevisionId: node.retiredRevisionId },
  );
  return node;
}

function activeRelation(
  relations: Readonly<Record<string, WorldstateRelation>>,
  relationId: string,
): WorldstateRelation {
  const relation = relations[relationId];
  invariant(
    relation,
    "reference_missing",
    `Relation ${relationId} does not exist.`,
    { relationId },
  );
  invariant(
    !relation.retiredRevisionId,
    "record_retired",
    `Relation ${relationId} is retired and cannot be changed.`,
    { relationId, retiredRevisionId: relation.retiredRevisionId },
  );
  return relation;
}

function applyNodePatch(node: WorldstateNode, patch: Extract<WorldstateDelta["operations"][number], { op: "node.patch" }>["patch"]): WorldstateNode {
  return {
    ...node,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined
      ? {}
      : patch.description === null
        ? { description: undefined }
        : { description: patch.description }),
    ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
    ...(patch.knowledge === undefined
      ? {}
      : {
          knowledge: {
            ...(node.knowledge ?? { standing: "draft" as const, freshness: "unknown" as const }),
            ...patch.knowledge,
          },
        }),
    ...(patch.governance === undefined
      ? {}
      : {
          governance: {
            ...(node.governance ?? {
              standing: "suggested" as const,
              approval: "not_required" as const,
            }),
            ...patch.governance,
          },
        }),
    ...(patch.work === undefined
      ? {}
      : {
          work: {
            ...(node.work ?? { phase: "planned" as const, verification: "unverified" as const }),
            ...patch.work,
          },
        }),
    ...(patch.sourceRefs === undefined ? {} : { sourceRefs: [...patch.sourceRefs] }),
    ...(patch.data === undefined ? {} : { data: { ...node.data, ...patch.data } }),
  };
}

function applyRelationPatch(
  relation: WorldstateRelation,
  patch: Extract<WorldstateDelta["operations"][number], { op: "relation.patch" }>["patch"],
): WorldstateRelation {
  return {
    ...relation,
    ...(patch.label === undefined
      ? {}
      : patch.label === null
        ? { label: undefined }
        : { label: patch.label }),
    ...(patch.sourceRefs === undefined ? {} : { sourceRefs: [...patch.sourceRefs] }),
    ...(patch.data === undefined ? {} : { data: { ...relation.data, ...patch.data } }),
  };
}

function applyDeltaOperations(
  canonical: CanonicalProjection,
  delta: WorldstateDelta,
  revisionId: string,
): Pick<CanonicalProjection, "nodes" | "relations"> {
  invariant(
    delta.scopeId === canonical.projectId,
    "scope_violation",
    `Delta ${delta.id} targets scope ${delta.scopeId}, not project ${canonical.projectId}.`,
    { deltaId: delta.id, scopeId: delta.scopeId, projectId: canonical.projectId },
  );

  const nodes: Record<string, WorldstateNode> = { ...canonical.nodes };
  const relations: Record<string, WorldstateRelation> = { ...canonical.relations };

  for (const operation of delta.operations) {
    switch (operation.op) {
      case "node.add": {
        invariant(
          operation.node.scopeId === canonical.projectId,
          "scope_violation",
          `Node ${operation.node.id} is outside the project scope.`,
          { nodeId: operation.node.id },
        );
        invariant(
          !nodes[operation.node.id],
          "identity_conflict",
          `Node ID ${operation.node.id} has already been used.`,
          { nodeId: operation.node.id },
        );
        nodes[operation.node.id] = {
          ...operation.node,
          sourceRefs: [...operation.node.sourceRefs],
          data: { ...operation.node.data },
          createdRevisionId: revisionId,
        };
        break;
      }
      case "node.patch": {
        nodes[operation.nodeId] = applyNodePatch(activeNode(nodes, operation.nodeId), operation.patch);
        break;
      }
      case "node.retire": {
        const node = activeNode(nodes, operation.nodeId);
        const activeRelationReference = Object.values(relations).find(
          (relation) =>
            !relation.retiredRevisionId &&
            (relation.fromNodeId === operation.nodeId || relation.toNodeId === operation.nodeId),
        );
        invariant(
          !activeRelationReference,
          "reference_missing",
          `Retire relations involving ${operation.nodeId} before retiring the node.`,
          { nodeId: operation.nodeId, relationId: activeRelationReference?.id },
        );
        nodes[operation.nodeId] = { ...node, retiredRevisionId: revisionId };
        break;
      }
      case "relation.add": {
        invariant(
          operation.relation.scopeId === canonical.projectId,
          "scope_violation",
          `Relation ${operation.relation.id} is outside the project scope.`,
          { relationId: operation.relation.id },
        );
        invariant(
          !relations[operation.relation.id],
          "identity_conflict",
          `Relation ID ${operation.relation.id} has already been used.`,
          { relationId: operation.relation.id },
        );
        activeNode(nodes, operation.relation.fromNodeId);
        activeNode(nodes, operation.relation.toNodeId);
        relations[operation.relation.id] = {
          ...operation.relation,
          sourceRefs: [...operation.relation.sourceRefs],
          data: { ...operation.relation.data },
          createdRevisionId: revisionId,
        };
        break;
      }
      case "relation.patch": {
        relations[operation.relationId] = applyRelationPatch(
          activeRelation(relations, operation.relationId),
          operation.patch,
        );
        break;
      }
      case "relation.retire": {
        const relation = activeRelation(relations, operation.relationId);
        relations[operation.relationId] = { ...relation, retiredRevisionId: revisionId };
        break;
      }
    }
  }

  return { nodes, relations };
}

function revisionIdFor(canonical: CanonicalProjection, delta: WorldstateDelta): string {
  const number = canonical.head.number + 1;
  const identityHash = fingerprint({
    number,
    parentRevisionId: canonical.head.id,
    delta,
  });
  return `rev-${number.toString().padStart(4, "0")}-${identityHash.slice(-12)}`;
}

export function deriveRevisionRecord(
  state: WorldstateState,
  deltaId: string,
  committedAt: string,
): RevisionRecord {
  const deltaProjection = state.operational.deltas[deltaId];
  invariant(
    deltaProjection,
    "reference_missing",
    `Delta ${deltaId} has not been proposed.`,
    { deltaId },
  );
  const delta = deltaProjection.delta;
  invariant(
    delta.baseRevisionId === state.canonical.head.id,
    "revision_conflict",
    `Delta ${delta.id} is based on ${delta.baseRevisionId}; current head is ${state.canonical.head.id}.`,
    { deltaId, baseRevisionId: delta.baseRevisionId, headRevisionId: state.canonical.head.id },
  );
  const revisionId = revisionIdFor(state.canonical, delta);
  const projection = applyDeltaOperations(state.canonical, delta, revisionId);
  return RevisionRecordSchema.parse({
    id: revisionId,
    number: state.canonical.head.number + 1,
    parentRevisionId: state.canonical.head.id,
    deltaId: delta.id,
    stateHash: fingerprint(projection),
    committedAt,
  });
}

function validateDeltaReferences(state: WorldstateState, delta: WorldstateDelta): void {
  invariant(
    delta.baseRevisionId === state.canonical.head.id,
    "revision_conflict",
    `Delta ${delta.id} is based on ${delta.baseRevisionId}; current head is ${state.canonical.head.id}.`,
    { deltaId: delta.id, baseRevisionId: delta.baseRevisionId, headRevisionId: state.canonical.head.id },
  );
  invariant(
    delta.scopeId === state.canonical.projectId,
    "scope_violation",
    `Delta ${delta.id} targets a different project.`,
    { deltaId: delta.id, scopeId: delta.scopeId },
  );
  assertSourceRefs(state, deltaSourceRefs(delta));
  for (const conflictId of delta.conflicts) {
    activeNode(state.canonical.nodes, conflictId);
  }
  applyDeltaOperations(state.canonical, delta, revisionIdFor(state.canonical, delta));
}

function validateReconciliationReference(state: WorldstateState, delta: WorldstateDelta): void {
  if (delta.purpose !== "reconciliation") {
    return;
  }
  invariant(
    delta.closureRef && state.operational.closures[delta.closureRef],
    "reference_missing",
    `Reconciliation delta ${delta.id} must reference a staged closure.`,
    { deltaId: delta.id, closureRef: delta.closureRef },
  );
  invariant(
    state.operational.closures[delta.closureRef].baseRevisionId === delta.baseRevisionId,
    "revision_conflict",
    `Reconciliation delta ${delta.id} does not match its closure revision.`,
    { deltaId: delta.id, closureRef: delta.closureRef },
  );
  const closure = state.operational.closures[delta.closureRef];
  invariant(
    closure.outcome === "returned",
    "evidence_gate_blocked",
    `Reconciliation delta ${delta.id} requires a returned closure.`,
    { deltaId: delta.id, closureRef: closure.id, outcome: closure.outcome },
  );
  const validation = delta.validationRef
    ? state.operational.validations[delta.validationRef]
    : undefined;
  invariant(
    validation,
    "reference_missing",
    `Reconciliation delta ${delta.id} must reference an evidence validation.`,
    { deltaId: delta.id, validationRef: delta.validationRef },
  );
  invariant(
    validation.closureId === closure.id &&
      validation.briefId === closure.briefId &&
      validation.baseRevisionId === delta.baseRevisionId,
    "evidence_gate_blocked",
    `Reconciliation delta ${delta.id} names a validation from another closure lineage.`,
    {
      deltaId: delta.id,
      closureRef: closure.id,
      validationRef: validation.id,
    },
  );
  invariant(
    delta.sourceRefs.includes(validation.evidenceSourceId),
    "evidence_gate_blocked",
    `Reconciliation delta ${delta.id} must retain its validation evidence source.`,
    { deltaId: delta.id, evidenceSourceId: validation.evidenceSourceId },
  );
  const omittedDurableClosureSource = closure.evidenceRefs.find(
    (sourceId) =>
      state.operational.sources[sourceId] && !delta.sourceRefs.includes(sourceId),
  );
  invariant(
    !omittedDurableClosureSource,
    "evidence_gate_blocked",
    `Reconciliation delta ${delta.id} omits durable closure evidence.`,
    { deltaId: delta.id, sourceId: omittedDurableClosureSource },
  );
}

function validateBriefProjection(
  state: WorldstateState,
  brief: WorldstateState["operational"]["briefs"][string],
): void {
  const sharedIds = new Set<string>();
  const visibleSourceRefs = (sourceRefs: readonly string[]): string[] =>
    sourceRefs.filter((sourceId) => state.operational.sources[sourceId]?.visibility === "shared");

  for (const projectedNode of brief.sharedNodes) {
    invariant(
      !sharedIds.has(projectedNode.id),
      "identity_conflict",
      `Brief ${brief.id} contains node ${projectedNode.id} twice.`,
      { briefId: brief.id, nodeId: projectedNode.id },
    );
    sharedIds.add(projectedNode.id);
    const canonicalNode = activeNode(state.canonical.nodes, projectedNode.id);
    invariant(
      canonicalNode.visibility === "shared",
      "scope_violation",
      `Brief ${brief.id} cannot share private node ${projectedNode.id}.`,
      { briefId: brief.id, nodeId: projectedNode.id },
    );
    const expected = {
      ...canonicalNode,
      sourceRefs: visibleSourceRefs(canonicalNode.sourceRefs),
    };
    invariant(
      stableStringify(projectedNode) === stableStringify(expected),
      "revision_conflict",
      `Brief ${brief.id} rewrites node ${projectedNode.id} instead of projecting it.`,
      { briefId: brief.id, nodeId: projectedNode.id },
    );
  }
  invariant(
    sharedIds.has(brief.targetNodeId),
    "reference_missing",
    `Brief ${brief.id} omits its own target node.`,
    { briefId: brief.id, targetNodeId: brief.targetNodeId },
  );

  const expectedRelations = Object.values(state.canonical.relations)
    .filter(
      (relation) =>
        !relation.retiredRevisionId &&
        sharedIds.has(relation.fromNodeId) &&
        sharedIds.has(relation.toNodeId),
    )
    .map((relation) => ({
      ...relation,
      sourceRefs: visibleSourceRefs(relation.sourceRefs),
    }));
  const projectedRelations = new Map(
    brief.sharedRelations.map((relation) => [relation.id, relation]),
  );
  invariant(
    projectedRelations.size === brief.sharedRelations.length &&
      projectedRelations.size === expectedRelations.length,
    "scope_violation",
    `Brief ${brief.id} relation projection is incomplete or duplicated.`,
    { briefId: brief.id },
  );
  for (const expected of expectedRelations) {
    invariant(
      stableStringify(projectedRelations.get(expected.id)) === stableStringify(expected),
      "revision_conflict",
      `Brief ${brief.id} rewrites or omits relation ${expected.id}.`,
      { briefId: brief.id, relationId: expected.id },
    );
  }

  const expectedOmissions = Object.values(state.canonical.nodes)
    .filter((node) => !node.retiredRevisionId && !sharedIds.has(node.id))
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      reason: node.visibility === "private" ? "private" : "out_of_scope",
    }));
  const omissions = new Map(brief.omittedContext.map((item) => [item.nodeId, item]));
  invariant(
    omissions.size === brief.omittedContext.length && omissions.size === expectedOmissions.length,
    "scope_violation",
    `Brief ${brief.id} omission receipt is incomplete or duplicated.`,
    { briefId: brief.id },
  );
  for (const expected of expectedOmissions) {
    invariant(
      stableStringify(omissions.get(expected.nodeId)) === stableStringify(expected),
      "scope_violation",
      `Brief ${brief.id} has an inaccurate omission receipt for ${expected.nodeId}.`,
      { briefId: brief.id, nodeId: expected.nodeId },
    );
  }
}

function deltaWorkClaims(delta: WorldstateDelta): {
  completesWork: boolean;
  verifiesWork: boolean;
} {
  let completesWork = false;
  let verifiesWork = false;
  for (const operation of delta.operations) {
    const work =
      operation.op === "node.add"
        ? operation.node.work
        : operation.op === "node.patch"
          ? operation.patch.work
          : undefined;
    completesWork ||= work?.phase === "completed";
    verifiesWork ||= work?.verification === "verified";
  }
  return { completesWork, verifiesWork };
}

function updateDelta(
  operational: OperationalProjection,
  deltaId: string,
  updater: (projection: DeltaProjection) => DeltaProjection,
): OperationalProjection {
  const projection = operational.deltas[deltaId];
  invariant(
    projection,
    "reference_missing",
    `Delta ${deltaId} has not been proposed.`,
    { deltaId },
  );
  return {
    ...operational,
    deltas: { ...operational.deltas, [deltaId]: updater(projection) },
  };
}

function assertDisposition(
  projection: DeltaProjection,
  allowed: readonly DeltaProjection["disposition"][],
  eventType: string,
): void {
  invariant(
    allowed.includes(projection.disposition),
    "disposition_conflict",
    `${eventType} cannot apply to a ${projection.disposition} delta.`,
    { deltaId: projection.delta.id, disposition: projection.disposition, eventType },
  );
}

const TRANSITIONS: Readonly<Record<RunProjection["status"], readonly RunProjection["status"][]>> = {
  queued: ["received", "outcome_unknown", "failed", "cancelled"],
  received: ["working", "blocked", "outcome_unknown", "failed", "cancelled"],
  working: ["blocked", "outcome_unknown", "returned", "failed", "cancelled"],
  blocked: ["working", "outcome_unknown", "returned", "failed", "cancelled"],
  outcome_unknown: [],
  returned: [],
  failed: [],
  cancelled: [],
};

function assertOwnerOrSystemAuthority(
  actor: LedgerEvent["actor"],
  eventType: "delta.accepted" | "run.authorized",
): void {
  invariant(
    actor.kind === "human" || actor.kind === "system",
    "authority_violation",
    `${eventType} requires human or system authority.`,
    { eventType, actorId: actor.id, actorKind: actor.kind },
  );
}

function assertEvidenceValidationAuthority(
  event: LedgerEventOf<"evidence.validation_recorded">,
): void {
  const { validator } = event.payload.validation;
  invariant(
    event.actor.id === validator.id && event.actor.kind === validator.kind,
    "authority_violation",
    "The evidence-validation event actor must be the validator named in its payload.",
    {
      actorId: event.actor.id,
      actorKind: event.actor.kind,
      validatorId: validator.id,
      validatorKind: validator.kind,
    },
  );
  invariant(
    validator.kind === "human" || validator.kind === "system",
    "authority_violation",
    "Evidence validation requires an independent human or system validator.",
    { validatorId: validator.id, validatorKind: validator.kind },
  );
}

function assertSystemObservationAuthority(
  actor: LedgerEvent["actor"],
  eventType: "run.lifecycle_recorded" | "closure.staged",
): void {
  invariant(
    actor.kind === "system",
    "authority_violation",
    `${eventType} must be recorded by the trusted orchestration boundary.`,
    { eventType, actorId: actor.id, actorKind: actor.kind },
  );
}

function requiredEvidencePosture(
  state: WorldstateState,
  delta: WorldstateDelta,
): { allowed: boolean; verified: boolean; reasons: string[] } {
  if (delta.purpose !== "reconciliation" || !delta.closureRef) {
    return { allowed: true, verified: false, reasons: [] };
  }

  const reasons: string[] = [];
  const closure = state.operational.closures[delta.closureRef];
  if (!closure) {
    return { allowed: false, verified: false, reasons: ["closure_missing"] };
  }
  const brief = state.operational.briefs[closure.briefId];
  if (!brief) {
    return { allowed: false, verified: false, reasons: ["brief_missing"] };
  }
  if (
    delta.baseRevisionId !== state.canonical.head.id ||
    closure.baseRevisionId !== state.canonical.head.id ||
    brief.baseRevisionId !== state.canonical.head.id
  ) {
    reasons.push("worldstate_revision_stale");
  }
  if (closure.artifactBaseRef !== brief.artifactBaseRef) {
    reasons.push("artifact_base_mismatch");
  }

  const validation = delta.validationRef
    ? state.operational.validations[delta.validationRef]
    : undefined;
  if (!validation) {
    reasons.push("validation_missing");
  } else if (
    validation.closureId !== closure.id ||
    validation.briefId !== closure.briefId ||
    validation.baseRevisionId !== delta.baseRevisionId
  ) {
    reasons.push("validation_mismatch");
  }
  const observations = new Map(
    validation?.observations.map((observation) => [observation.requirementId, observation]),
  );
  const required = brief.evidenceContract.requirements.filter((requirement) => requirement.required);
  const unmet = required.filter((requirement) => {
    const observation = observations.get(requirement.id);
    return !observation || observation.result !== "passed" || observation.freshness !== "current";
  });
  if (unmet.length > 0) {
    reasons.push(...unmet.map((requirement) => `evidence_unmet:${requirement.id}`));
  }

  const hardReasons = reasons.filter((reason) => !reason.startsWith("evidence_unmet:"));
  const evidenceBlocks = brief.evidenceContract.policy.blockIntegration && unmet.length > 0;
  return {
    allowed: hardReasons.length === 0 && !evidenceBlocks,
    verified: hardReasons.length === 0 && unmet.length === 0,
    reasons,
  };
}

export function evaluateIntegrationGate(
  state: WorldstateState,
  deltaId: string,
): { allowed: boolean; verified: boolean; reasons: readonly string[] } {
  const proposal = state.operational.deltas[deltaId];
  invariant(proposal, "reference_missing", `Delta ${deltaId} has not been proposed.`, { deltaId });
  return requiredEvidencePosture(state, proposal.delta);
}

function applyEvent(state: WorldstateState, event: LedgerEvent): WorldstateState {
  let next = state;

  switch (event.type) {
    case "source.captured": {
      const { source } = event.payload;
      if (source.kind === "system") {
        invariant(
          event.actor.kind === "system",
          "authority_violation",
          "System evidence sources must be recorded by the trusted orchestration boundary.",
          {
            sourceId: source.id,
            actorId: event.actor.id,
            actorKind: event.actor.kind,
          },
        );
      }
      invariant(
        !state.operational.sources[source.id],
        "identity_conflict",
        `Source ID ${source.id} has already been used.`,
        { sourceId: source.id },
      );
      next = {
        ...state,
        operational: {
          ...state.operational,
          sources: { ...state.operational.sources, [source.id]: source },
        },
      };
      break;
    }
    case "manager.failure_recorded": {
      if (event.payload.sourceId) {
        invariant(
          state.operational.sources[event.payload.sourceId],
          "reference_missing",
          `Source ${event.payload.sourceId} does not exist.`,
          { sourceId: event.payload.sourceId },
        );
      }
      next = {
        ...state,
        operational: {
          ...state.operational,
          managerFailures: [
            ...state.operational.managerFailures,
            { eventId: event.eventId, ...event.payload },
          ],
        },
      };
      break;
    }
    case "delta.proposed": {
      const delta = WorldstateDeltaSchema.parse(event.payload.delta);
      invariant(
        !state.operational.deltas[delta.id],
        "identity_conflict",
        `Delta ID ${delta.id} has already been used.`,
        { deltaId: delta.id },
      );
      validateDeltaReferences(state, delta);
      if (delta.supersedesDeltaId) {
        invariant(
          state.operational.deltas[delta.supersedesDeltaId],
          "reference_missing",
          `Superseded delta ${delta.supersedesDeltaId} does not exist.`,
          { deltaId: delta.id, supersedesDeltaId: delta.supersedesDeltaId },
        );
      }
      validateReconciliationReference(state, delta);
      const sourceToDeltaIds = { ...state.provenance.sourceToDeltaIds };
      for (const sourceId of deltaSourceRefs(delta)) {
        sourceToDeltaIds[sourceId] = [...(sourceToDeltaIds[sourceId] ?? []), delta.id];
      }
      next = {
        ...state,
        operational: {
          ...state.operational,
          deltas: {
            ...state.operational.deltas,
            [delta.id]: {
              delta,
              disposition: "pending",
              proposedEventId: event.eventId,
              dispositionEventIds: [],
            },
          },
        },
        provenance: { ...state.provenance, sourceToDeltaIds },
      };
      break;
    }
    case "delta.deferred":
    case "delta.rejected":
    case "delta.remanded": {
      const projection = state.operational.deltas[event.payload.deltaId];
      invariant(projection, "reference_missing", `Delta ${event.payload.deltaId} does not exist.`);
      invariant(
        projection.delta.baseRevisionId === event.payload.baseRevisionId,
        "revision_conflict",
        `${event.type} names the wrong base revision.`,
        { deltaId: event.payload.deltaId },
      );
      assertDisposition(projection, ["pending", "deferred"], event.type);
      const disposition = event.type.slice("delta.".length) as "deferred" | "rejected" | "remanded";
      next = {
        ...state,
        operational: updateDelta(state.operational, event.payload.deltaId, (current) => ({
          ...current,
          disposition,
          reason: event.payload.reason,
          dispositionEventIds: [...current.dispositionEventIds, event.eventId],
        })),
      };
      break;
    }
    case "delta.superseded": {
      const projection = state.operational.deltas[event.payload.deltaId];
      invariant(projection, "reference_missing", `Delta ${event.payload.deltaId} does not exist.`);
      invariant(
        projection.delta.baseRevisionId === event.payload.baseRevisionId,
        "revision_conflict",
        "The supersession names the wrong base revision.",
        { deltaId: event.payload.deltaId },
      );
      assertDisposition(projection, ["pending", "deferred", "remanded"], event.type);
      const replacement = event.payload.replacement;
      invariant(
        replacement.supersedesDeltaId === event.payload.deltaId,
        "reference_missing",
        "The replacement must link back to the delta it supersedes.",
        { deltaId: event.payload.deltaId, replacementDeltaId: replacement.id },
      );
      invariant(
        replacement.baseRevisionId === state.canonical.head.id,
        "revision_conflict",
        "The replacement must be based on the current worldstate revision.",
        { replacementDeltaId: replacement.id },
      );
      invariant(
        !state.operational.deltas[replacement.id],
        "identity_conflict",
        `Delta ID ${replacement.id} has already been used.`,
        { replacementDeltaId: replacement.id },
      );
      validateDeltaReferences(state, replacement);
      validateReconciliationReference(state, replacement);
      const sourceToDeltaIds = { ...state.provenance.sourceToDeltaIds };
      for (const sourceId of deltaSourceRefs(replacement)) {
        sourceToDeltaIds[sourceId] = [...(sourceToDeltaIds[sourceId] ?? []), replacement.id];
      }
      next = {
        ...state,
        operational: {
          ...updateDelta(state.operational, projection.delta.id, (current) => ({
            ...current,
            disposition: "superseded",
            reason: event.payload.reason,
            supersededByDeltaId: replacement.id,
            dispositionEventIds: [...current.dispositionEventIds, event.eventId],
          })),
          deltas: {
            ...state.operational.deltas,
            [projection.delta.id]: {
              ...projection,
              disposition: "superseded",
              reason: event.payload.reason,
              supersededByDeltaId: replacement.id,
              dispositionEventIds: [...projection.dispositionEventIds, event.eventId],
            },
            [replacement.id]: {
              delta: replacement,
              disposition: "pending",
              proposedEventId: event.eventId,
              dispositionEventIds: [],
            },
          },
        },
        provenance: {
          ...state.provenance,
          sourceToDeltaIds,
          supersession: {
            ...state.provenance.supersession,
            [projection.delta.id]: replacement.id,
          },
        },
      };
      break;
    }
    case "delta.accepted": {
      assertOwnerOrSystemAuthority(event.actor, event.type);
      const promotionHoldingSemanticHead = Object.values(
        state.operational.artifactPromotions,
      ).find(
        (promotion) => promotion.status === "authorized",
      );
      invariant(
        !promotionHoldingSemanticHead,
        "revision_conflict",
        "The semantic head is reserved by an unresolved artifact promotion.",
        {
          promotionId: promotionHoldingSemanticHead?.proposal.id,
          reservedRevisionId:
            promotionHoldingSemanticHead?.proposal.integratedRevisionId,
          headRevisionId: state.canonical.head.id,
        },
      );
      const projection = state.operational.deltas[event.payload.deltaId];
      invariant(projection, "reference_missing", `Delta ${event.payload.deltaId} does not exist.`);
      assertDisposition(projection, ["pending", "deferred"], event.type);
      invariant(
        projection.delta.baseRevisionId === event.payload.baseRevisionId &&
          event.payload.baseRevisionId === state.canonical.head.id,
        "revision_conflict",
        `Delta ${projection.delta.id} is stale and cannot be accepted.`,
        {
          deltaId: projection.delta.id,
          baseRevisionId: event.payload.baseRevisionId,
          headRevisionId: state.canonical.head.id,
        },
      );

      const gate = requiredEvidencePosture(state, projection.delta);
      const { completesWork, verifiesWork } = deltaWorkClaims(projection.delta);
      invariant(
        (!completesWork && !verifiesWork) || projection.delta.purpose === "reconciliation",
        "evidence_gate_blocked",
        "Completion and verification claims require an evidence-bound reconciliation delta.",
        { deltaId: projection.delta.id },
      );
      invariant(
        gate.allowed,
        gate.reasons.includes("artifact_base_mismatch") ? "artifact_drift" : "evidence_gate_blocked",
        `Delta ${projection.delta.id} is blocked by its integration gate.`,
        { deltaId: projection.delta.id, reasons: gate.reasons },
      );
      if (projection.delta.purpose === "reconciliation") {
        invariant(
          event.actor.kind === "human",
          "authority_violation",
          "Reconciliation integration requires explicit human authority.",
          {
            deltaId: projection.delta.id,
            actorId: event.actor.id,
            actorKind: event.actor.kind,
          },
        );
        const closure = state.operational.closures[projection.delta.closureRef!];
        invariant(
          event.payload.artifactBaseRef === closure.artifactBaseRef,
          "artifact_drift",
          "The integration command must attest the artifact base used by the closure.",
          {
            expectedArtifactBaseRef: closure.artifactBaseRef,
            observedArtifactBaseRef: event.payload.artifactBaseRef,
          },
        );
        invariant(
          !completesWork || (closure.outcome === "returned" && closure.claimedCompletion),
          "evidence_gate_blocked",
          "A returned closure with an explicit completion claim is required to mark work completed.",
          { closureId: closure.id },
        );
        invariant(
          !verifiesWork || gate.verified,
          "evidence_gate_blocked",
          "All required evidence must pass while current before work can be marked verified.",
          { closureId: closure.id, reasons: gate.reasons },
        );
      }

      const expected = deriveRevisionRecord(state, projection.delta.id, event.occurredAt);
      invariant(
        stableStringify(expected) === stableStringify(event.payload.revision),
        "revision_record_invalid",
        `Revision record ${event.payload.revision.id} is not the deterministic result of this commit.`,
        { expected, received: event.payload.revision },
      );
      const projectionResult = applyDeltaOperations(
        state.canonical,
        projection.delta,
        expected.id,
      );
      next = {
        ...state,
        canonical: {
          ...state.canonical,
          ...projectionResult,
          head: expected,
          revisions: { ...state.canonical.revisions, [expected.id]: expected },
          revisionOrder: [...state.canonical.revisionOrder, expected.id],
        },
        operational: updateDelta(state.operational, projection.delta.id, (current) => ({
          ...current,
          disposition: "accepted",
          acceptedRevisionId: expected.id,
          dispositionEventIds: [...current.dispositionEventIds, event.eventId],
        })),
        provenance: {
          ...state.provenance,
          deltaToRevisionId: {
            ...state.provenance.deltaToRevisionId,
            [projection.delta.id]: expected.id,
          },
        },
      };
      break;
    }
    case "projection.selected": {
      next = {
        ...state,
        operational: { ...state.operational, selectedProjection: event.payload.projection },
      };
      break;
    }
    case "brief.compiled": {
      const { brief } = event.payload;
      invariant(
        brief.baseRevisionId === state.canonical.head.id,
        "revision_conflict",
        `Brief ${brief.id} is based on a stale worldstate revision.`,
        { briefId: brief.id, baseRevisionId: brief.baseRevisionId, headRevisionId: state.canonical.head.id },
      );
      invariant(
        !state.operational.briefs[brief.id],
        "identity_conflict",
        `Brief ID ${brief.id} has already been used.`,
        { briefId: brief.id },
      );
      activeNode(state.canonical.nodes, brief.targetNodeId);
      validateBriefProjection(state, brief);
      next = {
        ...state,
        operational: {
          ...state.operational,
          briefs: { ...state.operational.briefs, [brief.id]: brief },
        },
      };
      break;
    }
    case "run.authorized": {
      assertOwnerOrSystemAuthority(event.actor, event.type);
      const { run } = event.payload;
      const brief = state.operational.briefs[run.briefId];
      invariant(brief, "reference_missing", `Brief ${run.briefId} does not exist.`, { briefId: run.briefId });
      invariant(
        run.baseRevisionId === brief.baseRevisionId && run.baseRevisionId === state.canonical.head.id,
        "revision_conflict",
        `Run ${run.id} cannot start from a stale brief.`,
        { runId: run.id, baseRevisionId: run.baseRevisionId },
      );
      invariant(
        run.artifactBaseRef === brief.artifactBaseRef,
        "artifact_drift",
        `Run ${run.id} does not match the brief's artifact base.`,
        { runId: run.id },
      );
      invariant(
        run.mode === brief.executionMode,
        "authority_violation",
        `Run ${run.id} cannot change the immutable brief execution mode.`,
        {
          runId: run.id,
          runMode: run.mode,
          briefExecutionMode: brief.executionMode,
        },
      );
      invariant(!state.operational.runs[run.id], "identity_conflict", `Run ID ${run.id} is already used.`);
      next = {
        ...state,
        operational: {
          ...state.operational,
          runs: {
            ...state.operational.runs,
            [run.id]: { run, status: "queued", lifecycleEventIds: [event.eventId] },
          },
        },
      };
      break;
    }
    case "run.lifecycle_recorded": {
      assertSystemObservationAuthority(event.actor, event.type);
      const runProjection = state.operational.runs[event.payload.runId];
      invariant(
        runProjection,
        "reference_missing",
        `Run ${event.payload.runId} does not exist.`,
        { runId: event.payload.runId },
      );
      invariant(
        TRANSITIONS[runProjection.status].includes(event.payload.status),
        "lifecycle_conflict",
        `Run ${event.payload.runId} cannot move from ${runProjection.status} to ${event.payload.status}.`,
        { runId: event.payload.runId, from: runProjection.status, to: event.payload.status },
      );
      next = {
        ...state,
        operational: {
          ...state.operational,
          runs: {
            ...state.operational.runs,
            [event.payload.runId]: {
              ...runProjection,
              status: event.payload.status,
              lifecycleEventIds: [...runProjection.lifecycleEventIds, event.eventId],
            },
          },
        },
      };
      break;
    }
    case "closure.staged": {
      assertSystemObservationAuthority(event.actor, event.type);
      const { closure } = event.payload;
      const runProjection = state.operational.runs[closure.runId];
      invariant(runProjection, "reference_missing", `Run ${closure.runId} does not exist.`, { runId: closure.runId });
      invariant(
        runProjection.status === closure.outcome,
        "lifecycle_conflict",
        `Closure ${closure.id} does not match run ${closure.runId}'s terminal state.`,
        { closureId: closure.id, runStatus: runProjection.status, outcome: closure.outcome },
      );
      invariant(
        closure.briefId === runProjection.run.briefId &&
          closure.baseRevisionId === runProjection.run.baseRevisionId,
        "revision_conflict",
        `Closure ${closure.id} does not match its immutable run brief.`,
        { closureId: closure.id, runId: closure.runId },
      );
      invariant(
        closure.artifactBaseRef === runProjection.run.artifactBaseRef,
        "artifact_drift",
        `Closure ${closure.id} reports a different artifact base.`,
        { closureId: closure.id },
      );
      invariant(
        closure.mode === runProjection.run.mode,
        "lifecycle_conflict",
        `Closure ${closure.id} cannot change a run's live/replay identity.`,
        { closureId: closure.id },
      );
      invariant(
        !state.operational.closures[closure.id] &&
          !Object.values(state.operational.closures).some((item) => item.runId === closure.runId),
        "identity_conflict",
        `Run ${closure.runId} already has a closure witness.`,
        { closureId: closure.id, runId: closure.runId },
      );
      next = {
        ...state,
        operational: {
          ...state.operational,
          closures: { ...state.operational.closures, [closure.id]: closure },
        },
      };
      break;
    }
    case "evidence.validation_recorded": {
      assertEvidenceValidationAuthority(event);
      const { validation } = event.payload;
      const closure = state.operational.closures[validation.closureId];
      invariant(
        closure,
        "reference_missing",
        `Closure ${validation.closureId} does not exist.`,
        { closureId: validation.closureId },
      );
      invariant(
        validation.briefId === closure.briefId && validation.baseRevisionId === closure.baseRevisionId,
        "revision_conflict",
        `Validation ${validation.id} does not match the closure's revision and brief.`,
        { validationId: validation.id },
      );
      const evidenceSource = state.operational.sources[validation.evidenceSourceId];
      invariant(
        evidenceSource,
        "reference_missing",
        `Validation ${validation.id} evidence source ${validation.evidenceSourceId} does not exist.`,
        {
          validationId: validation.id,
          evidenceSourceId: validation.evidenceSourceId,
        },
      );
      invariant(
        evidenceSource.kind === "system" &&
          evidenceSource.visibility === "shared",
        "evidence_gate_blocked",
        `Validation ${validation.id} must be grounded in shared system evidence.`,
        {
          validationId: validation.id,
          evidenceSourceId: validation.evidenceSourceId,
          sourceKind: evidenceSource.kind,
          sourceVisibility: evidenceSource.visibility,
        },
      );
      invariant(
        hasValidSemanticIntegrity(evidenceSource),
        "evidence_gate_blocked",
        `Validation ${validation.id} must be grounded in semantically intact fnv1a64 evidence.`,
        {
          validationId: validation.id,
          evidenceSourceId: validation.evidenceSourceId,
          integrityAlgorithm: evidenceSource.integrity?.algorithm ?? null,
          integrityDigest: evidenceSource.integrity?.digest ?? null,
        },
      );
      invariant(
        !state.operational.validations[validation.id],
        "identity_conflict",
        `Validation ID ${validation.id} has already been used.`,
        { validationId: validation.id },
      );
      const brief = state.operational.briefs[validation.briefId];
      invariant(brief, "reference_missing", `Brief ${validation.briefId} does not exist.`);
      const requirementIds = new Set(brief.evidenceContract.requirements.map((item) => item.id));
      const observed = new Set<string>();
      for (const observation of validation.observations) {
        invariant(
          requirementIds.has(observation.requirementId),
          "reference_missing",
          `Evidence requirement ${observation.requirementId} is not declared by the brief.`,
          { validationId: validation.id, requirementId: observation.requirementId },
        );
        invariant(
          observation.evidenceRefs.includes(validation.evidenceSourceId),
          "evidence_gate_blocked",
          `Evidence requirement ${observation.requirementId} is not grounded in validation source ${validation.evidenceSourceId}.`,
          {
            validationId: validation.id,
            requirementId: observation.requirementId,
            evidenceSourceId: validation.evidenceSourceId,
          },
        );
        invariant(
          !observed.has(observation.requirementId),
          "identity_conflict",
          `Evidence requirement ${observation.requirementId} was observed twice.`,
          { validationId: validation.id, requirementId: observation.requirementId },
        );
        observed.add(observation.requirementId);
      }
      next = {
        ...state,
        operational: {
          ...state.operational,
          validations: {
            ...state.operational.validations,
            [validation.id]: validation,
          },
          latestValidationByClosure: {
            ...state.operational.latestValidationByClosure,
            [validation.closureId]: validation.id,
          },
        },
      };
      break;
    }
    case "artifact.promotion_proposed": {
      invariant(
        event.actor.kind === "manager",
        "authority_violation",
        "Artifact promotion proposals must be compiled by the manager boundary.",
        { actorId: event.actor.id, actorKind: event.actor.kind },
      );
      const { proposal } = event.payload;
      invariant(
        !state.operational.artifactPromotions[proposal.id],
        "identity_conflict",
        `Artifact promotion ${proposal.id} has already been proposed.`,
        { promotionId: proposal.id },
      );
      const competing = Object.values(
        state.operational.artifactPromotions,
      ).find(
        (candidate) =>
          candidate.proposal.closureId === proposal.closureId &&
          candidate.status !== "failed" &&
          candidate.status !== "stale",
      );
      invariant(
        !competing,
        "identity_conflict",
        `Closure ${proposal.closureId} already has active artifact promotion ${competing?.proposal.id}.`,
        {
          closureId: proposal.closureId,
          promotionId: proposal.id,
          competingPromotionId: competing?.proposal.id,
        },
      );
      const closure = state.operational.closures[proposal.closureId];
      const runProjection = state.operational.runs[proposal.runId];
      const brief = state.operational.briefs[proposal.briefId];
      const validation = state.operational.validations[proposal.validationId];
      const reconciliation =
        state.operational.deltas[proposal.reconciliationDeltaId];
      const candidateSource =
        state.operational.sources[proposal.candidateEvidenceSourceId];
      const proposalSource =
        state.operational.sources[proposal.proposalSourceId];
      invariant(
        closure &&
          closure.outcome === "returned" &&
          closure.mode === "live" &&
          closure.runId === proposal.runId &&
          closure.briefId === proposal.briefId &&
          closure.artifactBaseRef === proposal.artifactBaseRef &&
          closure.artifactCandidateId === proposal.candidateId &&
          closure.artifactCandidateCommit === proposal.candidateCommit,
        "reference_missing",
        "Artifact promotion requires the exact returned live closure lineage.",
        { promotionId: proposal.id, closureId: proposal.closureId },
      );
      invariant(
        runProjection &&
          runProjection.status === "returned" &&
          runProjection.run.mode === "live" &&
          runProjection.run.briefId === proposal.briefId &&
          runProjection.run.artifactBaseRef === proposal.artifactBaseRef,
        "lifecycle_conflict",
        "Artifact promotion requires the exact returned live run.",
        { promotionId: proposal.id, runId: proposal.runId },
      );
      invariant(
        brief &&
          brief.executionMode === "live" &&
          brief.artifactBaseRef === proposal.artifactBaseRef,
        "reference_missing",
        "Artifact promotion requires the exact immutable live brief.",
        { promotionId: proposal.id, briefId: proposal.briefId },
      );
      invariant(
        validation &&
          validation.closureId === proposal.closureId &&
          validation.briefId === proposal.briefId,
        "evidence_gate_blocked",
        "Artifact promotion requires an independent validation for the exact closure.",
        { promotionId: proposal.id, validationId: proposal.validationId },
      );
      invariant(
        reconciliation &&
          reconciliation.disposition === "accepted" &&
          reconciliation.delta.purpose === "reconciliation" &&
          reconciliation.delta.closureRef === proposal.closureId &&
          reconciliation.delta.validationRef === proposal.validationId &&
          reconciliation.acceptedRevisionId === proposal.integratedRevisionId &&
          state.provenance.deltaToRevisionId[proposal.reconciliationDeltaId] ===
            proposal.integratedRevisionId &&
          state.canonical.head.id === proposal.integratedRevisionId,
        "evidence_gate_blocked",
        "Artifact promotion requires the exact accepted reconciliation at the current semantic head.",
        {
          promotionId: proposal.id,
          reconciliationDeltaId: proposal.reconciliationDeltaId,
          integratedRevisionId: proposal.integratedRevisionId,
        },
      );
      invariant(
        candidateSource &&
          candidateSource.kind === "system" &&
          candidateSource.visibility === "shared" &&
          hasValidSemanticIntegrity(candidateSource),
        "evidence_gate_blocked",
        "Artifact promotion requires an intact, shared staged-candidate source.",
        {
          promotionId: proposal.id,
          sourceId: proposal.candidateEvidenceSourceId,
        },
      );
      invariant(
        proposalSource &&
          proposalSource.kind === "system" &&
          proposalSource.visibility === "shared" &&
          hasValidSemanticIntegrity(proposalSource),
        "evidence_gate_blocked",
        "Artifact promotion requires an intact proposal receipt.",
        { promotionId: proposal.id, sourceId: proposal.proposalSourceId },
      );
      invariant(
        brief.expectedArtifacts.some((path) =>
          proposal.changedPaths.some((change) => change.path === path),
        ),
        "evidence_gate_blocked",
        "The staged candidate does not change any artifact declared by the brief.",
        { promotionId: proposal.id },
      );
      next = {
        ...state,
        operational: {
          ...state.operational,
          artifactPromotions: {
            ...state.operational.artifactPromotions,
            [proposal.id]: {
              proposal,
              status: "proposed",
              proposedEventId: event.eventId,
              outcomeEventIds: [],
            },
          },
        },
      };
      break;
    }
    case "artifact.promotion_authorized": {
      invariant(
        event.actor.kind === "human",
        "authority_violation",
        "Only a human may authorize an authoritative artifact promotion.",
        { actorId: event.actor.id, actorKind: event.actor.kind },
      );
      const projection =
        state.operational.artifactPromotions[event.payload.promotionId];
      invariant(
        projection,
        "reference_missing",
        `Artifact promotion ${event.payload.promotionId} has not been proposed.`,
        { promotionId: event.payload.promotionId },
      );
      invariant(
        projection.status === "proposed",
        "lifecycle_conflict",
        `Artifact promotion ${event.payload.promotionId} cannot be authorized from ${projection.status}.`,
        { promotionId: event.payload.promotionId, status: projection.status },
      );
      invariant(
        event.payload.integratedRevisionId ===
          projection.proposal.integratedRevisionId &&
          state.canonical.head.id === projection.proposal.integratedRevisionId,
        "revision_conflict",
        "Artifact promotion authority is stale against the semantic head.",
        { promotionId: event.payload.promotionId },
      );
      const requestSource =
        state.operational.sources[event.payload.requestSourceId];
      invariant(
        requestSource &&
          requestSource.kind === "system" &&
          requestSource.visibility === "shared" &&
          hasValidSemanticIntegrity(requestSource),
        "evidence_gate_blocked",
        "Artifact promotion authority must retain its exact integrity-bound request.",
        {
          promotionId: event.payload.promotionId,
          sourceId: event.payload.requestSourceId,
        },
      );
      next = {
        ...state,
        operational: {
          ...state.operational,
          artifactPromotions: {
            ...state.operational.artifactPromotions,
            [projection.proposal.id]: {
              ...projection,
              status: "authorized",
              authorizedEventId: event.eventId,
              requestSourceId: event.payload.requestSourceId,
            },
          },
        },
      };
      break;
    }
    case "artifact.promotion_outcome_recorded": {
      invariant(
        event.actor.kind === "system",
        "authority_violation",
        "Artifact promotion outcomes must be observed by the trusted system boundary.",
        { actorId: event.actor.id, actorKind: event.actor.kind },
      );
      const { outcome } = event.payload;
      const projection = state.operational.artifactPromotions[outcome.promotionId];
      invariant(
        projection,
        "reference_missing",
        `Artifact promotion ${outcome.promotionId} has not been proposed.`,
        { promotionId: outcome.promotionId },
      );
      invariant(
        projection.status === "authorized" ||
          projection.status === "outcome_unknown",
        "lifecycle_conflict",
        `Artifact promotion ${outcome.promotionId} cannot record an outcome from ${projection.status}.`,
        { promotionId: outcome.promotionId, status: projection.status },
      );
      invariant(
        state.canonical.head.id === projection.proposal.integratedRevisionId,
        "revision_conflict",
        "Artifact promotion outcome evidence is stale against the semantic head.",
        {
          promotionId: outcome.promotionId,
          authorizedRevisionId: projection.proposal.integratedRevisionId,
          headRevisionId: state.canonical.head.id,
        },
      );
      invariant(
        outcome.repositoryId === projection.proposal.repositoryId &&
          outcome.targetRef === projection.proposal.targetRef &&
          outcome.expectedBaseCommit ===
            projection.proposal.expectedBaseCommit &&
          outcome.candidateCommit === projection.proposal.candidateCommit,
        "artifact_drift",
        "The artifact promotion outcome does not match the exact reviewed candidate.",
        { promotionId: outcome.promotionId },
      );
      const responseSource =
        state.operational.sources[outcome.responseSourceId];
      invariant(
        responseSource &&
          responseSource.kind === "system" &&
          responseSource.visibility === "shared" &&
          hasValidSemanticIntegrity(responseSource),
        "evidence_gate_blocked",
        "Artifact promotion outcome must retain an intact system receipt.",
        {
          promotionId: outcome.promotionId,
          sourceId: outcome.responseSourceId,
        },
      );
      next = {
        ...state,
        operational: {
          ...state.operational,
          artifactPromotions: {
            ...state.operational.artifactPromotions,
            [projection.proposal.id]: {
              ...projection,
              status: outcome.outcome,
              outcomeEventIds: [
                ...projection.outcomeEventIds,
                event.eventId,
              ],
              latestOutcome: outcome,
            },
          },
        },
      };
      break;
    }
  }

  return { ...next, eventOrder: [...next.eventOrder, event.eventId] };
}

export function reduceWorldstateLedger(ledger: WorldstateLedger): WorldstateState {
  let state = initialState(ledger);
  const eventIds = new Set<string>();
  const commandIds = new Set<string>();

  for (const rawEvent of ledger.events) {
    const event = parseEvent(rawEvent);
    invariant(
      !eventIds.has(event.eventId),
      "event_id_conflict",
      `Event ID ${event.eventId} appears more than once in the ledger.`,
      { eventId: event.eventId },
    );
    invariant(
      !commandIds.has(event.commandId),
      "command_id_conflict",
      `Command ID ${event.commandId} appears more than once in the ledger.`,
      { commandId: event.commandId },
    );
    eventIds.add(event.eventId);
    commandIds.add(event.commandId);
    state = applyEvent(state, event);
  }

  return deepFreeze(state);
}

export function appendLedgerEvent(
  ledger: WorldstateLedger,
  rawEvent: LedgerEvent,
): AppendEventResult {
  const event = deepFreeze(parseEvent(rawEvent));
  const eventWithId = ledger.events.find((candidate) => candidate.eventId === event.eventId);
  if (eventWithId) {
    invariant(
      stableStringify(eventWithId) === stableStringify(event),
      "event_id_conflict",
      `Event ID ${event.eventId} was reused with different content.`,
      { eventId: event.eventId },
    );
    return { ledger, emittedEventIds: [eventWithId.eventId], replayed: true };
  }

  const commandEvent = ledger.events.find((candidate) => candidate.commandId === event.commandId);
  invariant(
    !commandEvent,
    "command_id_conflict",
    `Command ID ${event.commandId} was reused with different content.`,
    { commandId: event.commandId, originalEventId: commandEvent?.eventId },
  );

  const candidate = deepFreeze({
    ...ledger,
    events: [...ledger.events, event],
  });
  reduceWorldstateLedger(candidate);
  return { ledger: candidate, emittedEventIds: [event.eventId], replayed: false };
}

export function buildDeltaAcceptedEvent(
  state: WorldstateState,
  input: Omit<LedgerEventOf<"delta.accepted">, "type" | "payload"> & {
    deltaId: string;
    artifactBaseRef?: string;
  },
): LedgerEventOf<"delta.accepted"> {
  const delta = state.operational.deltas[input.deltaId];
  invariant(delta, "reference_missing", `Delta ${input.deltaId} has not been proposed.`);
  return LedgerEventSchema.parse({
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
    type: "delta.accepted",
    payload: {
      deltaId: input.deltaId,
      baseRevisionId: delta.delta.baseRevisionId,
      revision: deriveRevisionRecord(state, input.deltaId, input.occurredAt),
      ...(input.artifactBaseRef ? { artifactBaseRef: input.artifactBaseRef } : {}),
    },
  }) as LedgerEventOf<"delta.accepted">;
}
