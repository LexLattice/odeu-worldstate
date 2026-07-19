import {
  PlacementSuccessResponseSchema,
  type PlacementSuccessResponse,
} from "@/adapters/manager/schema";
import {
  WorldstateDeltaSchema,
  type DeltaOperation,
  type WorldstateDelta,
} from "@/domain/schema";

const managerActor = {
  id: "manager:worldstate-placement",
  kind: "manager" as const,
  label: "Worldstate placement manager",
};

type PlacementRelationIdentity = {
  readonly kind: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly scopeId: string;
  readonly originSourceId: string;
};

function relationIdentityKey(relation: PlacementRelationIdentity): string {
  return JSON.stringify([
    relation.kind,
    relation.fromNodeId,
    relation.toNodeId,
    relation.scopeId,
    relation.originSourceId,
  ]);
}

function relationMultiplicity(
  relations: readonly PlacementRelationIdentity[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const relation of relations) {
    const key = relationIdentityKey(relation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameRelationMultiset(
  actual: readonly PlacementRelationIdentity[],
  expected: readonly PlacementRelationIdentity[],
): boolean {
  if (actual.length !== expected.length) return false;

  const actualCounts = relationMultiplicity(actual);
  const expectedCounts = relationMultiplicity(expected);
  if (actualCounts.size !== expectedCounts.size) return false;

  return [...actualCounts].every(
    ([key, count]) => expectedCounts.get(key) === count,
  );
}

/**
 * Crosses the untrusted model-adapter boundary into the kernel contract.
 * The manager response remains evidence; this function only creates a pending,
 * schema-validated delta and never appends or accepts it.
 */
export function placementResponseToKernelDelta(
  response: PlacementSuccessResponse,
  options: { evidenceSourceId?: string } = {},
): WorldstateDelta | null {
  const parsed = PlacementSuccessResponseSchema.parse(response);
  if (parsed.delta === null) {
    if (parsed.receipt.decisionState !== "needs_clarification") {
      throw new Error("A reviewable placement receipt must carry its exact candidate delta.");
    }
    return null;
  }

  if (parsed.receipt.decisionState !== "reviewable") {
    throw new Error("A clarification receipt cannot carry a committable delta.");
  }
  if (
    parsed.delta.sourceId !== parsed.receipt.sourceId ||
    parsed.delta.baseRevisionId !== parsed.receipt.baseRevisionId
  ) {
    throw new Error("The placement receipt and delta disagree about source or base revision.");
  }

  const nodeOperations = parsed.delta.operations.filter(
    (operation) => operation.op === "node.add",
  );
  if (nodeOperations.length !== 1) {
    throw new Error("A placement receipt must bind exactly one proposed node operation.");
  }
  const proposedNode = nodeOperations[0].node;
  if (
    proposedNode.id !== parsed.receipt.proposed.nodeId ||
    proposedNode.scopeId !== parsed.receipt.scopeId ||
    proposedNode.kind !== parsed.receipt.proposed.kind ||
    proposedNode.delegationProfileId !==
      parsed.receipt.proposed.delegationProfileId ||
    proposedNode.title !== parsed.receipt.proposed.title ||
    proposedNode.summary !== parsed.receipt.proposed.summary ||
    proposedNode.originSourceId !== parsed.receipt.sourceId
  ) {
    throw new Error("The visible proposed node does not match the delta operation.");
  }

  const relationOperations = parsed.delta.operations.filter(
    (operation) => operation.op === "relation.add",
  );
  const expectedRelations = parsed.receipt.proposedRelations.map((relation) => ({
    kind: relation.kind,
    fromNodeId:
      relation.direction === "from_proposed"
        ? parsed.receipt.proposed.nodeId
        : relation.targetNodeId,
    toNodeId:
      relation.direction === "from_proposed"
        ? relation.targetNodeId
        : parsed.receipt.proposed.nodeId,
    scopeId: parsed.receipt.scopeId,
    originSourceId: parsed.receipt.sourceId,
  }));
  if (!sameRelationMultiset(relationOperations.map(({ relation }) => relation), expectedRelations)) {
    throw new Error("The visible proposed relations do not match the delta operations.");
  }

  const managerProvenance = {
    requestedMode: parsed.manager.requestedMode,
    effectiveMode: parsed.manager.effectiveMode,
    provider: parsed.manager.provider,
    model: parsed.manager.model,
    responseId: parsed.manager.responseId,
  };
  const operations: DeltaOperation[] = parsed.delta.operations.map((operation) => {
    if (operation.op === "node.add") {
      return {
        op: "node.add",
        node: {
          id: operation.node.id,
          scopeId: operation.node.scopeId,
          kind: operation.node.kind,
          ...(operation.node.delegationProfileId === null
            ? {}
            : { delegationProfileId: operation.node.delegationProfileId }),
          title: operation.node.title,
          description: operation.node.summary,
          visibility: "shared",
          knowledge: { standing: "draft", freshness: "current" },
          governance: { standing: "adopted", approval: "granted" },
          work: { phase: "planned", verification: "unverified" },
          sourceRefs: [operation.node.originSourceId],
          data: {
            managerOperationId: operation.operationId,
            placementReceiptId: parsed.receipt.receiptId,
            managerProvenance,
          },
        },
      };
    }

    return {
      op: "relation.add",
      relation: {
        id: operation.relation.id,
        scopeId: operation.relation.scopeId,
        kind: operation.relation.kind,
        fromNodeId: operation.relation.fromNodeId,
        toNodeId: operation.relation.toNodeId,
        sourceRefs: [operation.relation.originSourceId],
        data: {
          managerOperationId: operation.operationId,
          placementReceiptId: parsed.receipt.receiptId,
          managerProvenance,
        },
      },
    };
  });

  const rationales = [
    parsed.receipt.rationale,
    ...parsed.receipt.proposedRelations.map((relation) => relation.rationale),
  ].filter((rationale, index, all) => all.indexOf(rationale) === index);

  return WorldstateDeltaSchema.parse({
    id: parsed.delta.deltaId,
    baseRevisionId: parsed.delta.baseRevisionId,
    scopeId: parsed.receipt.scopeId,
    purpose: "placement",
    proposedBy: managerActor,
    operations,
    rationale: rationales,
    sourceRefs: [
      parsed.delta.sourceId,
      ...(options.evidenceSourceId ? [options.evidenceSourceId] : []),
    ],
    uncertainty: parsed.receipt.uncertainty,
    alternatives: parsed.receipt.alternatives.map(
      (alternative) => `${alternative.targetTitle}: ${alternative.rationale}`,
    ),
    conflicts: parsed.receipt.conflicts.flatMap((conflict) =>
      conflict.nodeId === null ? [] : [conflict.nodeId],
    ),
    visibleConsequence: `Add “${parsed.receipt.proposed.title}” at ${parsed.receipt.location.label} and preserve its source lineage.`,
  });
}
