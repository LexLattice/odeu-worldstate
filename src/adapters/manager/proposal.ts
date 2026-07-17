import { createHash } from "node:crypto";

import {
  PlacementDeltaSchema,
  PlacementReceiptSchema,
  type ManagerPlacementInterpretation,
  type PlacementDelta,
  type PlacementReceipt,
  type PlacementRequest,
} from "./schema";

export class PlacementInterpretationError extends Error {
  readonly code = "interpretation_out_of_scope" as const;

  constructor(message: string) {
    super(message);
    this.name = "PlacementInterpretationError";
  }
}

function stableToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function freezePlacementArtifact<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((nestedValue) =>
      freezePlacementArtifact(nestedValue),
    );
  }

  return value;
}

function assertInterpretationIsBounded(
  request: PlacementRequest,
  interpretation: ManagerPlacementInterpretation,
): void {
  const nodesById = new Map(
    request.projection.nodes.map((node) => [node.id, node] as const),
  );

  const referencedNodeIds = [
    interpretation.projectId,
    interpretation.locationTargetNodeId,
    ...interpretation.affectedNodeIds,
    ...interpretation.relations.map((relation) => relation.targetNodeId),
    ...interpretation.conflicts.map((conflict) => conflict.nodeId),
    ...interpretation.alternatives.map(
      (alternative) => alternative.targetNodeId,
    ),
  ].filter((nodeId): nodeId is string => nodeId !== null);

  const missingNodeId = referencedNodeIds.find(
    (nodeId) => !nodesById.has(nodeId),
  );

  if (missingNodeId) {
    throw new PlacementInterpretationError(
      `The manager referenced node ${missingNodeId}, which is outside the supplied projection.`,
    );
  }

  if (
    interpretation.projectId !== null &&
    request.projection.projectId !== null &&
    interpretation.projectId !== request.projection.projectId
  ) {
    throw new PlacementInterpretationError(
      "The manager selected a project outside the requested project boundary.",
    );
  }
}

export function materializePlacementProposal(
  request: PlacementRequest,
  interpretation: ManagerPlacementInterpretation,
): Readonly<{
  receipt: PlacementReceipt;
  delta: PlacementDelta | null;
}> {
  assertInterpretationIsBounded(request, interpretation);

  const identitySeed = [
    request.requestId,
    request.source.sourceId,
    request.baseRevisionId,
  ].join("\u0000");
  const token = stableToken(identitySeed);
  const proposedNodeId = `candidate-${token}`;

  const receipt = PlacementReceiptSchema.parse({
    receiptId: `receipt-${token}`,
    requestId: request.requestId,
    sourceId: request.source.sourceId,
    baseRevisionId: request.baseRevisionId,
    scopeId: request.projection.scopeId,
    projectId: interpretation.projectId,
    decisionState: interpretation.clarificationNeeded
      ? "needs_clarification"
      : "reviewable",
    location: {
      targetNodeId: interpretation.locationTargetNodeId,
      label: interpretation.locationLabel,
      breadcrumb: interpretation.breadcrumb,
    },
    proposed: {
      nodeId: proposedNodeId,
      kind: interpretation.proposedKind,
      title: interpretation.proposedTitle,
      summary: interpretation.proposedSummary,
    },
    rationale: interpretation.rationale,
    confidence: interpretation.confidence,
    uncertainty: interpretation.uncertainty,
    conflicts: interpretation.conflicts,
    alternatives: interpretation.alternatives,
    affectedNodeIds: interpretation.affectedNodeIds,
    proposedRelations: interpretation.relations,
    clarificationQuestion: interpretation.clarificationQuestion,
  });

  if (interpretation.clarificationNeeded) {
    return freezePlacementArtifact({ receipt, delta: null });
  }

  const relationOperations = interpretation.relations.map(
    (relation, index) => {
      const relationId = `relation-${token}-${index + 1}`;
      const fromNodeId =
        relation.direction === "from_proposed"
          ? proposedNodeId
          : relation.targetNodeId;
      const toNodeId =
        relation.direction === "from_proposed"
          ? relation.targetNodeId
          : proposedNodeId;

      return {
        operationId: `operation-${token}-${index + 2}`,
        op: "relation.add" as const,
        relation: {
          id: relationId,
          kind: relation.kind,
          scopeId: request.projection.scopeId,
          fromNodeId,
          toNodeId,
          originSourceId: request.source.sourceId,
        },
      };
    },
  );

  const delta = PlacementDeltaSchema.parse({
    deltaId: `delta-${token}`,
    baseRevisionId: request.baseRevisionId,
    sourceId: request.source.sourceId,
    purpose: "placement",
    disposition: "pending_review",
    mutability: "immutable",
    operations: [
      {
        operationId: `operation-${token}-1`,
        op: "node.add",
        node: {
          id: proposedNodeId,
          kind: interpretation.proposedKind,
          scopeId: request.projection.scopeId,
          title: interpretation.proposedTitle,
          summary: interpretation.proposedSummary,
          originSourceId: request.source.sourceId,
        },
      },
      ...relationOperations,
    ],
  });

  return freezePlacementArtifact({ receipt, delta });
}
