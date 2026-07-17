import { z } from "zod";

export const ManagerModeSchema = z.enum(["fixture", "live"]);
export type ManagerMode = z.infer<typeof ManagerModeSchema>;

export const WorldstateNodeKindSchema = z.enum([
  "World",
  "Project",
  "Goal",
  "Idea",
  "Decision",
  "Constraint",
  "OpenQuestion",
  "Task",
  "Artifact",
  "AgentRun",
  "Evidence",
]);
export type WorldstateNodeKind = z.infer<typeof WorldstateNodeKindSchema>;

export const WorldstateRelationKindSchema = z.enum([
  "belongs_to",
  "refines",
  "depends_on",
  "conflicts_with",
  "supersedes",
  "implements",
  "evidenced_by",
  "originated_from",
]);
export type WorldstateRelationKind = z.infer<
  typeof WorldstateRelationKindSchema
>;

const IdentifierSchema = z.string().trim().min(1).max(240);
const HumanTextSchema = z.string().trim().min(1).max(4_000);

export const PlacementContextNodeSchema = z
  .object({
    id: IdentifierSchema,
    kind: WorldstateNodeKindSchema,
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().max(2_000).nullable().default(null),
    scopeId: IdentifierSchema,
    visibility: z.enum(["shared", "private"]).default("shared"),
  })
  .strict();

export const PlacementContextRelationSchema = z
  .object({
    id: IdentifierSchema,
    kind: WorldstateRelationKindSchema,
    fromNodeId: IdentifierSchema,
    toNodeId: IdentifierSchema,
  })
  .strict();

export const PlacementRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    source: z
      .object({
        sourceId: IdentifierSchema,
        text: HumanTextSchema,
      })
      .strict(),
    baseRevisionId: IdentifierSchema,
    projection: z
      .object({
        scopeId: IdentifierSchema,
        projectId: IdentifierSchema.nullable().default(null),
        selectedNodeId: IdentifierSchema.nullable().default(null),
        nodes: z.array(PlacementContextNodeSchema).max(250),
        relations: z.array(PlacementContextRelationSchema).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const nodeIds = new Set(request.projection.nodes.map((node) => node.id));

    request.projection.nodes.forEach((node, index) => {
      if (node.visibility === "private") {
        context.addIssue({
          code: "custom",
          message:
            "private nodes must be omitted before calling the placement gateway",
          path: ["projection", "nodes", index, "visibility"],
        });
      }
    });

    if (
      request.projection.projectId !== null &&
      !nodeIds.has(request.projection.projectId)
    ) {
      context.addIssue({
        code: "custom",
        message: "projectId must name a node in the bounded projection",
        path: ["projection", "projectId"],
      });
    }

    if (
      request.projection.selectedNodeId !== null &&
      !nodeIds.has(request.projection.selectedNodeId)
    ) {
      context.addIssue({
        code: "custom",
        message: "selectedNodeId must name a node in the bounded projection",
        path: ["projection", "selectedNodeId"],
      });
    }

    request.projection.relations.forEach((relation, index) => {
      if (!nodeIds.has(relation.fromNodeId)) {
        context.addIssue({
          code: "custom",
          message: "relation source must be present in the bounded projection",
          path: ["projection", "relations", index, "fromNodeId"],
        });
      }

      if (!nodeIds.has(relation.toNodeId)) {
        context.addIssue({
          code: "custom",
          message: "relation target must be present in the bounded projection",
          path: ["projection", "relations", index, "toNodeId"],
        });
      }
    });
  });

export type PlacementRequest = z.infer<typeof PlacementRequestSchema>;

const ProposedRelationSchema = z
  .object({
    kind: WorldstateRelationKindSchema,
    targetNodeId: IdentifierSchema,
    direction: z.enum(["from_proposed", "to_proposed"]),
    rationale: z.string().trim().min(1).max(1_000),
  })
  .strict();

/**
 * Exact structured output requested from the model. Identity, provenance, and
 * revision binding are deliberately added by the adapter rather than entrusted
 * to generated text.
 */
export const ManagerPlacementInterpretationSchema = z
  .object({
    projectId: IdentifierSchema.nullable(),
    locationTargetNodeId: IdentifierSchema.nullable(),
    locationLabel: z.string().trim().min(1).max(300),
    breadcrumb: z.array(z.string().trim().min(1).max(300)).max(12),
    proposedKind: WorldstateNodeKindSchema,
    proposedTitle: z.string().trim().min(1).max(300),
    proposedSummary: z.string().trim().min(1).max(2_000),
    rationale: z.string().trim().min(1).max(2_000),
    confidence: z.enum(["high", "medium", "low"]),
    uncertainty: z.array(z.string().trim().min(1).max(1_000)).max(12),
    conflicts: z
      .array(
        z
          .object({
            nodeId: IdentifierSchema.nullable(),
            title: z.string().trim().min(1).max(300),
            reason: z.string().trim().min(1).max(1_000),
            severity: z.enum(["notice", "material"]),
          })
          .strict(),
      )
      .max(12),
    alternatives: z
      .array(
        z
          .object({
            targetNodeId: IdentifierSchema.nullable(),
            targetTitle: z.string().trim().min(1).max(300),
            rationale: z.string().trim().min(1).max(1_000),
          })
          .strict(),
      )
      .max(8),
    affectedNodeIds: z.array(IdentifierSchema).max(30),
    relations: z.array(ProposedRelationSchema).max(20),
    clarificationNeeded: z.boolean(),
    clarificationQuestion: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict()
  .superRefine((interpretation, context) => {
    if (
      interpretation.clarificationNeeded &&
      interpretation.clarificationQuestion === null
    ) {
      context.addIssue({
        code: "custom",
        message: "clarificationQuestion is required when clarification is needed",
        path: ["clarificationQuestion"],
      });
    }

    if (
      !interpretation.clarificationNeeded &&
      interpretation.locationTargetNodeId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "a reviewable placement must name a location target",
        path: ["locationTargetNodeId"],
      });
    }
  });

export type ManagerPlacementInterpretation = z.infer<
  typeof ManagerPlacementInterpretationSchema
>;

export const PlacementReceiptSchema = z
  .object({
    receiptId: IdentifierSchema,
    requestId: IdentifierSchema,
    sourceId: IdentifierSchema,
    baseRevisionId: IdentifierSchema,
    scopeId: IdentifierSchema,
    projectId: IdentifierSchema.nullable(),
    decisionState: z.enum(["reviewable", "needs_clarification"]),
    location: z
      .object({
        targetNodeId: IdentifierSchema.nullable(),
        label: z.string().trim().min(1).max(300),
        breadcrumb: z.array(z.string().trim().min(1).max(300)).max(12),
      })
      .strict(),
    proposed: z
      .object({
        nodeId: IdentifierSchema,
        kind: WorldstateNodeKindSchema,
        title: z.string().trim().min(1).max(300),
        summary: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    rationale: z.string().trim().min(1).max(2_000),
    confidence: z.enum(["high", "medium", "low"]),
    uncertainty: z.array(z.string().trim().min(1).max(1_000)).max(12),
    conflicts: ManagerPlacementInterpretationSchema.shape.conflicts,
    alternatives: ManagerPlacementInterpretationSchema.shape.alternatives,
    affectedNodeIds: z.array(IdentifierSchema).max(30),
    proposedRelations: z.array(ProposedRelationSchema).max(20),
    clarificationQuestion: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.decisionState === "reviewable" &&
      receipt.location.targetNodeId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "a reviewable receipt must name a location target",
        path: ["location", "targetNodeId"],
      });
    }
    if (
      receipt.decisionState === "needs_clarification" &&
      receipt.clarificationQuestion === null
    ) {
      context.addIssue({
        code: "custom",
        message: "a clarification receipt must include a question",
        path: ["clarificationQuestion"],
      });
    }
    if (
      receipt.decisionState === "reviewable" &&
      receipt.clarificationQuestion !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "a reviewable receipt cannot carry a clarification question",
        path: ["clarificationQuestion"],
      });
    }
  });

const NodeAddOperationSchema = z
  .object({
    operationId: IdentifierSchema,
    op: z.literal("node.add"),
    node: z
      .object({
        id: IdentifierSchema,
        kind: WorldstateNodeKindSchema,
        scopeId: IdentifierSchema,
        title: z.string().trim().min(1).max(300),
        summary: z.string().trim().min(1).max(2_000),
        originSourceId: IdentifierSchema,
      })
      .strict(),
  })
  .strict();

const RelationAddOperationSchema = z
  .object({
    operationId: IdentifierSchema,
    op: z.literal("relation.add"),
    relation: z
      .object({
        id: IdentifierSchema,
        kind: WorldstateRelationKindSchema,
        scopeId: IdentifierSchema,
        fromNodeId: IdentifierSchema,
        toNodeId: IdentifierSchema,
        originSourceId: IdentifierSchema,
      })
      .strict(),
  })
  .strict();

export const PlacementDeltaOperationSchema = z.discriminatedUnion("op", [
  NodeAddOperationSchema,
  RelationAddOperationSchema,
]);

export const PlacementDeltaSchema = z
  .object({
    deltaId: IdentifierSchema,
    baseRevisionId: IdentifierSchema,
    sourceId: IdentifierSchema,
    purpose: z.literal("placement"),
    disposition: z.literal("pending_review"),
    mutability: z.literal("immutable"),
    operations: z.array(PlacementDeltaOperationSchema).min(1).max(21),
  })
  .strict();

export type PlacementDelta = z.infer<typeof PlacementDeltaSchema>;

export const ManagerRuntimeMetadataSchema = z
  .object({
    requestedMode: z.string().trim().min(1),
    effectiveMode: ManagerModeSchema.nullable(),
    status: z.enum(["available", "unavailable", "failed"]),
    provider: z.enum(["fixture", "openai"]).nullable(),
    model: z.string().trim().min(1).nullable(),
    responseId: z.string().trim().min(1).nullable(),
  })
  .strict();

export const PlacementSuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    manager: ManagerRuntimeMetadataSchema,
    receipt: PlacementReceiptSchema,
    delta: PlacementDeltaSchema.nullable(),
  })
  .strict();

export const PlacementErrorCodeSchema = z.enum([
  "invalid_json",
  "invalid_request",
  "invalid_manager_mode",
  "live_credentials_missing",
  "provider_request_failed",
  "structured_output_missing",
  "structured_output_invalid",
  "interpretation_out_of_scope",
]);

export const PlacementErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    manager: ManagerRuntimeMetadataSchema,
    sourcePreserved: z.literal(true),
    error: z
      .object({
        code: PlacementErrorCodeSchema,
        message: z.string().trim().min(1),
        retryable: z.boolean(),
        issues: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict();

export const PlacementResponseSchema = z.discriminatedUnion("ok", [
  PlacementSuccessResponseSchema,
  PlacementErrorResponseSchema,
]);

export type PlacementReceipt = z.infer<typeof PlacementReceiptSchema>;
export type PlacementSuccessResponse = z.infer<
  typeof PlacementSuccessResponseSchema
>;
export type PlacementErrorResponse = z.infer<
  typeof PlacementErrorResponseSchema
>;
export type PlacementResponse = z.infer<typeof PlacementResponseSchema>;
export type PlacementErrorCode = z.infer<typeof PlacementErrorCodeSchema>;
