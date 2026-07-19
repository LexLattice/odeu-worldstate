import { z } from "zod";

import { ArtifactCandidateReceiptSchema } from "@/adapters/artifact-promotion/schema";
import { DelegationProfileIdSchema } from "@/domain";

const StableId = z.string().trim().min(1).max(160);
const NonEmptyText = z.string().trim().min(1).max(8_000);

export const SharedContextItemSchema = z.object({
  id: StableId,
  kind: z.enum([
    "world",
    "project",
    "goal",
    "idea",
    "constraint",
    "decision",
    "work",
    "agent_run",
    "evidence",
    "artifact",
    "unknown",
  ]),
  label: z.string().trim().min(1).max(240),
  summary: NonEmptyText,
});

export const SharedContextRelationSchema = z.object({
  id: StableId,
  kind: z.string().trim().min(1).max(120),
  fromId: StableId,
  toId: StableId,
  label: z.string().trim().min(1).max(240).nullable(),
});

export const EvidenceRequirementSchema = z.object({
  checkId: StableId,
  label: z.string().trim().min(1).max(240),
  kind: z.enum(["test", "artifact", "review", "command", "other"]),
  command: z.string().trim().min(1).max(1_000).nullable(),
  blocking: z.boolean(),
});

export const AgentBriefSchema = z.object({
  briefId: StableId,
  sourceRevisionId: StableId,
  artifactBaseRef: StableId,
  delegationProfileId: DelegationProfileIdSchema.nullable().default(null),
  goal: NonEmptyText,
  doneMeans: z.array(NonEmptyText).min(1).max(24),
  environment: NonEmptyText,
  agentProfile: NonEmptyText,
  context: z.object({
    shared: z.array(SharedContextItemSchema).max(80),
    relations: z.array(SharedContextRelationSchema).max(200),
    omittedCount: z.number().int().nonnegative().max(10_000),
  }),
  unknowns: z.array(NonEmptyText).max(24),
  constraints: z.array(NonEmptyText).max(40),
  actions: z.object({
    allowed: z.array(NonEmptyText).min(1).max(40),
    denied: z.array(NonEmptyText).max(40),
    confirmationRequired: z.array(NonEmptyText).max(40),
  }),
  evidenceContract: z.object({
    requiredChecks: z.array(EvidenceRequirementSchema).min(1).max(24),
    expectedArtifacts: z.array(NonEmptyText).max(24),
    blockIntegration: z.boolean(),
  }),
  escalationPath: NonEmptyText,
});

export const RunAuthorizationSchema = z.object({
  runId: StableId,
  mode: z.literal("live"),
  requestId: StableId,
  nonce: z.uuid(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  briefDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  baseRevisionId: StableId,
  artifactBaseRef: StableId,
  capability: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const AgentRunRequestSchema = z
  .object({
    runId: StableId,
    mode: z.enum(["live", "replay"]),
    requestId: StableId,
    brief: AgentBriefSchema,
    authorization: RunAuthorizationSchema.nullable().default(null),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.authorization !== null && request.mode !== "live") {
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "live authorization cannot be attached to a replay request",
      });
    }
    if (
      request.authorization !== null &&
      request.authorization.runId !== request.runId
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization", "runId"],
        message: "live authorization runId must match the requested runId",
      });
    }
    if (
      request.authorization !== null &&
      request.authorization.requestId !== request.requestId
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization", "requestId"],
        message: "live authorization requestId must match the requested requestId",
      });
    }
    if (
      request.authorization !== null &&
      request.authorization.baseRevisionId !== request.brief.sourceRevisionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization", "baseRevisionId"],
        message: "live authorization revision must match the immutable brief",
      });
    }
    if (
      request.authorization !== null &&
      request.authorization.artifactBaseRef !== request.brief.artifactBaseRef
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization", "artifactBaseRef"],
        message: "live authorization artifact base must match the immutable brief",
      });
    }
  });

export const ArtifactChangeSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  kind: z.enum(["added", "updated", "deleted", "observed"]),
  summary: NonEmptyText,
  reference: z.string().trim().min(1).max(1_000),
});

export const CheckObservationSchema = z.object({
  checkId: StableId,
  label: z.string().trim().min(1).max(240),
  status: z.enum(["passed", "failed", "not_run"]),
  detail: NonEmptyText,
  reference: z.string().trim().min(1).max(1_000),
});

const CodexReportClaimsSchema = z.object({
  claimedEffects: z.array(NonEmptyText).max(40),
  claimedArtifacts: z.array(ArtifactChangeSchema).max(80),
  claimedChecks: z.array(CheckObservationSchema).max(40),
  failures: z.array(NonEmptyText).max(40).default([]),
  unresolved: z.array(NonEmptyText).max(40),
  completionClaim: z.object({
    claimedDone: z.boolean(),
    criteriaClaimedSatisfied: z.array(z.boolean()).max(24),
  }),
  candidateReconciliationSummary: NonEmptyText,
});

/** The structured worker report may describe a resumable blocked run. */
export const CodexReportedResultSchema = CodexReportClaimsSchema.extend({
  outcome: z.enum(["returned", "blocked", "failed", "cancelled"]),
});

export const CodexBlockedReportSchema = CodexReportClaimsSchema.extend({
  outcome: z.literal("blocked"),
});

/** Only terminal run outcomes can cross the domain boundary as closures. */
export const CodexReportedClosureSchema = CodexReportClaimsSchema.extend({
  outcome: z.enum(["returned", "failed", "cancelled"]),
});

export const SdkFileObservationSchema = z.object({
  itemId: StableId,
  path: z.string().trim().min(1).max(1_000),
  kind: z.enum(["add", "update", "delete"]),
  status: z.enum(["completed", "failed"]),
});

export const SdkCommandObservationSchema = z.object({
  itemId: StableId,
  command: z.string().trim().min(1).max(4_000),
  status: z.enum(["completed", "failed"]),
  exitCode: z.number().int().nullable(),
});

export const AgentClosureWitnessSchema = z
  .object({
    runId: StableId,
    briefId: StableId,
    sourceRevisionIdUsed: StableId,
    artifactBaseRefUsed: StableId,
    workerThreadId: StableId.nullable(),
    workerItemIds: z.array(StableId).max(200),
    report: CodexReportedClosureSchema,
    sdkObservations: z.object({
      fileChanges: z.array(SdkFileObservationSchema).max(500),
      commands: z.array(SdkCommandObservationSchema).max(200),
    }),
    artifactCandidate: ArtifactCandidateReceiptSchema.nullable().default(null),
  })
  .superRefine((closure, context) => {
    const candidate = closure.artifactCandidate?.metadata;
    if (!candidate) return;
    const baseCommit = closure.artifactBaseRefUsed.match(
      /^git:([0-9a-f]{40}|[0-9a-f]{64})$/,
    )?.[1];
    if (
      candidate.runId !== closure.runId ||
      candidate.briefId !== closure.briefId ||
      candidate.baseRevisionId !== closure.sourceRevisionIdUsed ||
      candidate.git.baseCommit !== baseCommit
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifactCandidate"],
        message:
          "the staged artifact candidate must match the exact run, brief, worldstate revision, and Git base",
      });
    }
  });

export const AgentLifecycleEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  status: z.enum(["queued", "received", "working", "blocked", "returned", "failed", "cancelled"]),
  at: z.iso.datetime(),
  label: z.string().trim().min(1).max(160),
  detail: NonEmptyText,
});

export const AgentBlockedRunSchema = z.object({
  runId: StableId,
  briefId: StableId,
  sourceRevisionIdUsed: StableId,
  artifactBaseRefUsed: StableId,
  workerThreadId: StableId,
  workerItemIds: z.array(StableId).max(200),
  events: z.array(AgentLifecycleEventSchema).min(1),
  report: CodexBlockedReportSchema,
  sdkObservations: z.object({
    fileChanges: z.array(SdkFileObservationSchema).max(500),
    commands: z.array(SdkCommandObservationSchema).max(200),
  }),
  artifactCandidate: z.null().default(null),
});

export const AgentRunSuccessSchema = z
  .object({
    ok: z.literal(true),
    runtime: z.object({
      requestedMode: z.enum(["replay", "live"]),
      effectiveMode: z.enum(["replay", "live"]),
      status: z.enum(["replayed", "returned", "failed", "cancelled"]),
      provider: z.literal("codex"),
      replayIdentity: StableId.nullable(),
      replayKind: z.enum(["fixture", "recorded"]).nullable(),
    }),
    events: z.array(AgentLifecycleEventSchema).min(1),
    closure: AgentClosureWitnessSchema,
  })
  .superRefine((response, context) => {
    const { runtime } = response;
    if (runtime.requestedMode !== runtime.effectiveMode) {
      context.addIssue({
        code: "custom",
        path: ["runtime", "effectiveMode"],
        message: "effectiveMode must equal the requested execution mode",
      });
    }

    if (runtime.effectiveMode === "replay") {
      if (
        runtime.status !== "replayed" ||
        runtime.replayIdentity === null ||
        runtime.replayKind === null
      ) {
        context.addIssue({
          code: "custom",
          path: ["runtime"],
          message: "replay responses must retain replay status, identity, and kind",
        });
      }
      if (response.closure.artifactCandidate !== null) {
        context.addIssue({
          code: "custom",
          path: ["closure", "artifactCandidate"],
          message: "replay responses cannot carry a live staged artifact candidate",
        });
      }
    } else if (
      runtime.status === "replayed" ||
      runtime.replayIdentity !== null ||
      runtime.replayKind !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtime"],
        message: "live responses cannot claim replay status or identity",
      });
    } else if (
      runtime.status === "returned" &&
      response.closure.artifactCandidate === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["closure", "artifactCandidate"],
        message:
          "a returned live result must carry the exact staged artifact candidate",
      });
    } else if (
      runtime.status !== "returned" &&
      response.closure.artifactCandidate !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["closure", "artifactCandidate"],
        message:
          "only a returned live result may carry a staged artifact candidate",
      });
    }
  });

export const AgentRunFailureSchema = z.object({
  ok: z.literal(false),
  runtime: z.object({
    requestedMode: z.string().trim().min(1),
    effectiveMode: z.enum(["replay", "live"]).nullable(),
    status: z.enum(["unavailable", "blocked", "failed"]),
    provider: z.literal("codex"),
    replayIdentity: z.null(),
    replayKind: z.null(),
  }),
  error: z.object({
    code: z.enum([
      "invalid_request",
      "invalid_mode",
      "mode_mismatch",
      "replay_not_applicable",
      "live_not_configured",
      "authorization_invalid",
      "authorization_consumed",
      "run_claim_busy",
      "revision_stale",
      "artifact_base_mismatch",
      "run_not_dispatchable",
      "workspace_busy",
      "workspace_dirty",
      "workspace_private_data",
      "worker_blocked",
      "worker_timed_out",
      "worker_failed",
    ]),
    message: NonEmptyText,
    issues: z.array(z.string()).default([]),
  }),
  briefPreserved: z.literal(true),
  resumable: z.boolean().default(false),
  resumeSupported: z.literal(false).default(false),
  blockedRun: AgentBlockedRunSchema.nullable().default(null),
});

export const AgentRunResponseSchema = z.discriminatedUnion("ok", [
  AgentRunSuccessSchema,
  AgentRunFailureSchema,
]);

export type AgentBrief = z.infer<typeof AgentBriefSchema>;
export type RunAuthorization = z.infer<typeof RunAuthorizationSchema>;
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;
export type CodexReportedResult = z.infer<typeof CodexReportedResultSchema>;
export type AgentBlockedRun = z.infer<typeof AgentBlockedRunSchema>;
export type CodexReportedClosure = z.infer<typeof CodexReportedClosureSchema>;
export type AgentClosureWitness = z.infer<typeof AgentClosureWitnessSchema>;
export type AgentLifecycleEvent = z.infer<typeof AgentLifecycleEventSchema>;
export type AgentRunSuccess = z.infer<typeof AgentRunSuccessSchema>;
export type AgentRunFailure = z.infer<typeof AgentRunFailureSchema>;
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;
