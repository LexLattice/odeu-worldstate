import { z } from "zod";

export const IdentifierSchema = z.string().trim().min(1);
export const TimestampSchema = z.iso.datetime({ offset: true });

export const ActorSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["human", "manager", "agent", "system"]),
    label: z.string().trim().min(1),
  })
  .strict();

export const NodeKindSchema = z.enum([
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

export const RelationKindSchema = z.enum([
  "belongs_to",
  "refines",
  "depends_on",
  "conflicts_with",
  "supersedes",
  "implements",
  "evidenced_by",
  "originated_from",
]);

export const KnowledgeStatusSchema = z
  .object({
    standing: z.enum(["draft", "supported", "challenged", "open"]),
    freshness: z.enum(["current", "stale", "unknown"]),
  })
  .strict();

export const GovernanceStatusSchema = z
  .object({
    standing: z.enum(["suggested", "adopted", "restricted"]),
    approval: z.enum(["not_required", "required", "granted"]),
  })
  .strict();

export const WorkStatusSchema = z
  .object({
    phase: z.enum(["planned", "running", "blocked", "completed"]),
    verification: z.enum(["unverified", "verified"]),
  })
  .strict();

const RecordDataSchema = z.record(z.string(), z.json());

export const WorldstateNodeInputSchema = z
  .object({
    id: IdentifierSchema,
    scopeId: IdentifierSchema,
    kind: NodeKindSchema,
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    visibility: z.enum(["shared", "private"]),
    knowledge: KnowledgeStatusSchema.optional(),
    governance: GovernanceStatusSchema.optional(),
    work: WorkStatusSchema.optional(),
    sourceRefs: z.array(IdentifierSchema).default([]),
    data: RecordDataSchema.default({}),
  })
  .strict();

export const WorldstateNodeSchema = WorldstateNodeInputSchema.extend({
  createdRevisionId: IdentifierSchema,
  retiredRevisionId: IdentifierSchema.optional(),
}).strict();

export const WorldstateRelationInputSchema = z
  .object({
    id: IdentifierSchema,
    scopeId: IdentifierSchema,
    kind: RelationKindSchema,
    fromNodeId: IdentifierSchema,
    toNodeId: IdentifierSchema,
    label: z.string().trim().min(1).optional(),
    sourceRefs: z.array(IdentifierSchema).default([]),
    data: RecordDataSchema.default({}),
  })
  .strict();

export const WorldstateRelationSchema = WorldstateRelationInputSchema.extend({
  createdRevisionId: IdentifierSchema,
  retiredRevisionId: IdentifierSchema.optional(),
}).strict();

const NonEmptyPatch = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine((patch) => Object.keys(patch).length > 0, {
      message: "A patch must change at least one field.",
    });

export const NodePatchSchema = NonEmptyPatch({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).nullable().optional(),
  visibility: z.enum(["shared", "private"]).optional(),
  knowledge: KnowledgeStatusSchema.partial().strict().optional(),
  governance: GovernanceStatusSchema.partial().strict().optional(),
  work: WorkStatusSchema.partial().strict().optional(),
  sourceRefs: z.array(IdentifierSchema).optional(),
  data: RecordDataSchema.optional(),
});

export const RelationPatchSchema = NonEmptyPatch({
  label: z.string().trim().min(1).nullable().optional(),
  sourceRefs: z.array(IdentifierSchema).optional(),
  data: RecordDataSchema.optional(),
});

export const DeltaOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("node.add"), node: WorldstateNodeInputSchema }).strict(),
  z
    .object({
      op: z.literal("node.patch"),
      nodeId: IdentifierSchema,
      patch: NodePatchSchema,
    })
    .strict(),
  z.object({ op: z.literal("node.retire"), nodeId: IdentifierSchema }).strict(),
  z
    .object({ op: z.literal("relation.add"), relation: WorldstateRelationInputSchema })
    .strict(),
  z
    .object({
      op: z.literal("relation.patch"),
      relationId: IdentifierSchema,
      patch: RelationPatchSchema,
    })
    .strict(),
  z
    .object({ op: z.literal("relation.retire"), relationId: IdentifierSchema })
    .strict(),
]);

export const WorldstateDeltaSchema = z
  .object({
    id: IdentifierSchema,
    baseRevisionId: IdentifierSchema,
    scopeId: IdentifierSchema,
    purpose: z.enum(["placement", "reconciliation", "correction", "compensation"]),
    proposedBy: ActorSchema,
    operations: z.array(DeltaOperationSchema).min(1),
    rationale: z.array(z.string().trim().min(1)).min(1),
    sourceRefs: z.array(IdentifierSchema).default([]),
    uncertainty: z.array(z.string().trim().min(1)).default([]),
    alternatives: z.array(z.string().trim().min(1)).default([]),
    conflicts: z.array(IdentifierSchema).default([]),
    visibleConsequence: z.string().trim().min(1),
    supersedesDeltaId: IdentifierSchema.optional(),
    closureRef: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.purpose === "reconciliation" && !delta.closureRef) {
      context.addIssue({
        code: "custom",
        path: ["closureRef"],
        message: "A reconciliation delta must name its closure witness.",
      });
    }
    if (delta.purpose !== "reconciliation" && delta.closureRef) {
      context.addIssue({
        code: "custom",
        path: ["closureRef"],
        message: "Only reconciliation deltas may name a closure witness.",
      });
    }
  });

export const RevisionRecordSchema = z
  .object({
    id: IdentifierSchema,
    number: z.number().int().nonnegative(),
    parentRevisionId: IdentifierSchema.nullable(),
    deltaId: IdentifierSchema.nullable(),
    stateHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
    committedAt: TimestampSchema,
  })
  .strict();

export const SourceRecordSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["text", "voice", "file", "agent", "system"]),
    content: z.string().trim().min(1),
    visibility: z.enum(["shared", "private"]),
    integrity: z
      .object({ algorithm: z.string().trim().min(1), digest: z.string().trim().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const EvidenceRequirementSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string().trim().min(1),
    kind: z.enum(["test", "artifact", "review", "command", "other"]),
    required: z.boolean(),
  })
  .strict();

export const EvidenceContractSchema = z
  .object({
    requirements: z.array(EvidenceRequirementSchema),
    policy: z.object({ blockIntegration: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((contract, context) => {
    const ids = new Set<string>();
    contract.requirements.forEach((requirement, index) => {
      if (ids.has(requirement.id)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "id"],
          message: `Duplicate evidence requirement: ${requirement.id}`,
        });
      }
      ids.add(requirement.id);
    });
  });

export const OmittedContextSchema = z
  .object({
    nodeId: IdentifierSchema,
    title: z.string().trim().min(1),
    reason: z.enum(["private", "out_of_scope"]),
  })
  .strict();

export const AgentBriefSchema = z
  .object({
    id: IdentifierSchema,
    baseRevisionId: IdentifierSchema,
    artifactBaseRef: z.string().trim().min(1),
    targetNodeId: IdentifierSchema,
    goal: z.string().trim().min(1),
    doneMeans: z.array(z.string().trim().min(1)).min(1),
    sharedNodes: z.array(WorldstateNodeSchema),
    sharedRelations: z.array(WorldstateRelationSchema),
    omittedContext: z.array(OmittedContextSchema),
    environment: z.string().trim().min(1),
    agentProfile: z.string().trim().min(1),
    allowedActions: z.array(z.string().trim().min(1)).min(1),
    deniedActions: z.array(z.string().trim().min(1)).min(1),
    confirmationRequired: z.array(z.string().trim().min(1)).default([]),
    evidenceContract: EvidenceContractSchema,
    escalationPath: z.string().trim().min(1),
  })
  .strict();

export const AgentRunSchema = z
  .object({
    id: IdentifierSchema,
    briefId: IdentifierSchema,
    baseRevisionId: IdentifierSchema,
    artifactBaseRef: z.string().trim().min(1),
    mode: z.enum(["live", "replay"]),
  })
  .strict();

export const RunLifecycleStatusSchema = z.enum([
  "queued",
  "received",
  "working",
  "blocked",
  "returned",
  "failed",
  "cancelled",
]);

export const ClosureWitnessSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    briefId: IdentifierSchema,
    baseRevisionId: IdentifierSchema,
    artifactBaseRef: z.string().trim().min(1),
    mode: z.enum(["live", "replay"]),
    outcome: z.enum(["returned", "failed", "cancelled"]),
    claimedCompletion: z.boolean(),
    summary: z.string().trim().min(1),
    changes: z.array(z.string().trim().min(1)).default([]),
    artifactRefs: z.array(z.string().trim().min(1)).default([]),
    evidenceRefs: z.array(z.string().trim().min(1)).default([]),
    failures: z.array(z.string().trim().min(1)).default([]),
    unresolved: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const EvidenceObservationSchema = z
  .object({
    requirementId: IdentifierSchema,
    result: z.enum(["passed", "failed", "missing"]),
    freshness: z.enum(["current", "stale"]),
    evidenceRefs: z.array(z.string().trim().min(1)).default([]),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.result === "passed" && observation.evidenceRefs.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "A passing observation must reference the evidence that was observed.",
      });
    }
  });

export const EvidenceValidationSchema = z
  .object({
    id: IdentifierSchema,
    closureId: IdentifierSchema,
    briefId: IdentifierSchema,
    baseRevisionId: IdentifierSchema,
    validator: ActorSchema,
    observedAt: TimestampSchema,
    observations: z.array(EvidenceObservationSchema),
  })
  .strict();

const EnvelopeShape = {
  eventId: IdentifierSchema,
  commandId: IdentifierSchema,
  occurredAt: TimestampSchema,
  actor: ActorSchema,
};

export const LedgerEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("source.captured"),
      payload: z.object({ source: SourceRecordSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("manager.failure_recorded"),
      payload: z
        .object({
          sourceId: IdentifierSchema.optional(),
          code: IdentifierSchema,
          message: z.string().trim().min(1),
          retriable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("delta.proposed"),
      payload: z.object({ delta: WorldstateDeltaSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("delta.deferred"),
      payload: z
        .object({
          deltaId: IdentifierSchema,
          baseRevisionId: IdentifierSchema,
          reason: z.string().trim().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("delta.rejected"),
      payload: z
        .object({
          deltaId: IdentifierSchema,
          baseRevisionId: IdentifierSchema,
          reason: z.string().trim().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("delta.remanded"),
      payload: z
        .object({
          deltaId: IdentifierSchema,
          baseRevisionId: IdentifierSchema,
          reason: z.string().trim().min(1),
          requiredCorrections: z.array(z.string().trim().min(1)).min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("delta.superseded"),
      payload: z
        .object({
          deltaId: IdentifierSchema,
          baseRevisionId: IdentifierSchema,
          reason: z.string().trim().min(1),
          replacement: WorldstateDeltaSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("delta.accepted"),
      payload: z
        .object({
          deltaId: IdentifierSchema,
          baseRevisionId: IdentifierSchema,
          revision: RevisionRecordSchema,
          artifactBaseRef: z.string().trim().min(1).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("projection.selected"),
      payload: z.object({ projection: z.enum(["outline", "map", "timeline", "focus"]) }).strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("brief.compiled"),
      payload: z.object({ brief: AgentBriefSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("run.authorized"),
      payload: z.object({ run: AgentRunSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("run.lifecycle_recorded"),
      payload: z
        .object({
          runId: IdentifierSchema,
          status: RunLifecycleStatusSchema.exclude(["queued"]),
          message: z.string().trim().min(1).optional(),
          evidenceRefs: z.array(z.string().trim().min(1)).default([]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("closure.staged"),
      payload: z.object({ closure: ClosureWitnessSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...EnvelopeShape,
      type: z.literal("evidence.validation_recorded"),
      payload: z.object({ validation: EvidenceValidationSchema }).strict(),
    })
    .strict(),
]);

export type Actor = z.infer<typeof ActorSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type RelationKind = z.infer<typeof RelationKindSchema>;
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
export type GovernanceStatus = z.infer<typeof GovernanceStatusSchema>;
export type WorkStatus = z.infer<typeof WorkStatusSchema>;
export type WorldstateNodeInput = z.infer<typeof WorldstateNodeInputSchema>;
export type WorldstateNode = z.infer<typeof WorldstateNodeSchema>;
export type WorldstateRelationInput = z.infer<typeof WorldstateRelationInputSchema>;
export type WorldstateRelation = z.infer<typeof WorldstateRelationSchema>;
export type NodePatch = z.infer<typeof NodePatchSchema>;
export type RelationPatch = z.infer<typeof RelationPatchSchema>;
export type DeltaOperation = z.infer<typeof DeltaOperationSchema>;
export type WorldstateDelta = z.infer<typeof WorldstateDeltaSchema>;
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;
export type EvidenceContract = z.infer<typeof EvidenceContractSchema>;
export type AgentBrief = z.infer<typeof AgentBriefSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type RunLifecycleStatus = z.infer<typeof RunLifecycleStatusSchema>;
export type ClosureWitness = z.infer<typeof ClosureWitnessSchema>;
export type EvidenceValidation = z.infer<typeof EvidenceValidationSchema>;
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export type LedgerEventOf<TType extends LedgerEvent["type"]> = Extract<
  LedgerEvent,
  { type: TType }
>;
