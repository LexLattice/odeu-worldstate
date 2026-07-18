import { z } from "zod";

const StableIdSchema = z.string().trim().min(1).max(240);
const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const HmacSha256DigestSchema = z
  .string()
  .regex(/^hmac-sha256:[0-9a-f]{64}$/);
const GitRefSchema = z.string().trim().min(1).max(1_024);
const ArtifactPathSchema = z.string().min(1).max(4_096);

export const ArtifactCandidateChangedPathSchema = z
  .object({
    path: ArtifactPathSchema,
    status: z.enum(["added", "modified", "deleted"]),
    oldMode: z.enum(["100644", "100755"]).nullable(),
    newMode: z.enum(["100644", "100755"]).nullable(),
    oldBlob: GitObjectIdSchema.nullable(),
    newBlob: GitObjectIdSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    const hasOld = entry.oldMode !== null && entry.oldBlob !== null;
    const hasNew = entry.newMode !== null && entry.newBlob !== null;
    if ((entry.oldMode === null) !== (entry.oldBlob === null)) {
      context.addIssue({
        code: "custom",
        path: ["oldBlob"],
        message: "Old mode and blob must either both be present or both be absent.",
      });
    }
    if ((entry.newMode === null) !== (entry.newBlob === null)) {
      context.addIssue({
        code: "custom",
        path: ["newBlob"],
        message: "New mode and blob must either both be present or both be absent.",
      });
    }
    if (entry.status === "added" && (hasOld || !hasNew)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "An added path must have only a new mode and blob.",
      });
    }
    if (entry.status === "deleted" && (!hasOld || hasNew)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A deleted path must have only an old mode and blob.",
      });
    }
    if (entry.status === "modified" && (!hasOld || !hasNew)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A modified path must have both old and new modes and blobs.",
      });
    }
  });

export const ArtifactCandidateMetadataSchema = z
  .object({
    kind: z.literal("odeu.git-artifact-candidate"),
    version: z.literal(1),
    candidateId: z.string().regex(/^artifact-candidate:sha256:[0-9a-f]{64}$/),
    candidateRef: GitRefSchema,
    repositoryId: StableIdSchema,
    targetRef: GitRefSchema,
    runId: StableIdSchema,
    briefId: StableIdSchema,
    baseRevisionId: StableIdSchema,
    sealedAt: z.iso.datetime({ offset: true }),
    git: z
      .object({
        objectFormat: z.enum(["sha1", "sha256"]),
        baseCommit: GitObjectIdSchema,
        baseTree: GitObjectIdSchema,
        candidateCommit: GitObjectIdSchema,
        candidateTree: GitObjectIdSchema,
      })
      .strict(),
    patch: z
      .object({
        format: z.literal("git-binary-diff-v1"),
        digest: Sha256DigestSchema,
        byteLength: z.number().int().positive(),
      })
      .strict(),
    manifest: z
      .object({
        digest: Sha256DigestSchema,
        entries: z.array(ArtifactCandidateChangedPathSchema).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((candidate, context) => {
    const oidLength = candidate.git.objectFormat === "sha1" ? 40 : 64;
    for (const [key, value] of Object.entries(candidate.git)) {
      if (key !== "objectFormat" && value.length !== oidLength) {
        context.addIssue({
          code: "custom",
          path: ["git", key],
          message: `A ${candidate.git.objectFormat} repository requires ${oidLength}-character object IDs.`,
        });
      }
    }
    candidate.manifest.entries.forEach((entry, index) => {
      for (const key of ["oldBlob", "newBlob"] as const) {
        const value = entry[key];
        if (value !== null && value.length !== oidLength) {
          context.addIssue({
            code: "custom",
            path: ["manifest", "entries", index, key],
            message: `A ${candidate.git.objectFormat} repository requires ${oidLength}-character blob IDs.`,
          });
        }
      }
    });
  });

export const ArtifactReceiptSignatureSchema = z
  .object({
    algorithm: z.literal("hmac-sha256"),
    keyId: StableIdSchema,
    digest: HmacSha256DigestSchema,
  })
  .strict();

export const ArtifactCandidateReceiptSchema = z
  .object({
    metadata: ArtifactCandidateMetadataSchema,
    signature: ArtifactReceiptSignatureSchema,
  })
  .strict();

export const ArtifactPromotionOutcomeSchema = z.enum([
  "promoted",
  "stale",
  "failed",
  "outcome_unknown",
]);

export const ArtifactPromotionAttemptReceiptSchema = z
  .object({
    kind: z.literal("odeu.git-artifact-promotion-attempt"),
    version: z.literal(1),
    promotionId: z.string().regex(/^artifact-promotion:sha256:[0-9a-f]{64}$/),
    candidateId: ArtifactCandidateMetadataSchema.shape.candidateId,
    repositoryId: StableIdSchema,
    targetRef: GitRefSchema,
    expectedBaseCommit: GitObjectIdSchema,
    candidateCommit: GitObjectIdSchema,
    authorityIntentDigest: Sha256DigestSchema,
    attemptedAt: z.iso.datetime({ offset: true }),
    signature: ArtifactReceiptSignatureSchema,
  })
  .strict();

export const ArtifactPromotionReceiptSchema = z
  .object({
    kind: z.literal("odeu.git-artifact-promotion-status"),
    version: z.literal(1),
    promotionId: ArtifactPromotionAttemptReceiptSchema.shape.promotionId,
    candidateId: ArtifactCandidateMetadataSchema.shape.candidateId,
    repositoryId: StableIdSchema,
    targetRef: GitRefSchema,
    expectedBaseCommit: GitObjectIdSchema,
    candidateCommit: GitObjectIdSchema,
    authorityIntentDigest: Sha256DigestSchema,
    attemptedAt: z.iso.datetime({ offset: true }),
    observedAt: z.iso.datetime({ offset: true }),
    outcome: ArtifactPromotionOutcomeSchema,
    observedRefBefore: GitObjectIdSchema.nullable(),
    observedRefAfter: GitObjectIdSchema.nullable(),
    detailCode: z.enum([
      "cas_updated",
      "already_promoted",
      "target_ref_mismatch",
      "candidate_verification_failed",
      "target_ref_checked_out",
      "update_ref_rejected",
      "target_ref_unobservable",
      "status_recovery_conflict",
    ]),
    detail: z.string().trim().min(1).max(2_000),
    signature: ArtifactReceiptSignatureSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const allowedDetailCodes: Record<
      typeof receipt.outcome,
      readonly (typeof receipt.detailCode)[]
    > = {
      promoted: ["cas_updated", "already_promoted"],
      stale: ["target_ref_mismatch"],
      failed: [
        "candidate_verification_failed",
        "target_ref_checked_out",
        "update_ref_rejected",
      ],
      outcome_unknown: [
        "target_ref_unobservable",
        "status_recovery_conflict",
      ],
    };
    if (!allowedDetailCodes[receipt.outcome].includes(receipt.detailCode)) {
      context.addIssue({
        code: "custom",
        path: ["detailCode"],
        message: `Detail code ${receipt.detailCode} is not lawful for ${receipt.outcome}.`,
      });
    }
    if (
      receipt.outcome === "promoted" &&
      receipt.observedRefAfter !== receipt.candidateCommit
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedRefAfter"],
        message: "A promoted receipt must observe the exact candidate commit afterward.",
      });
    }
    if (
      receipt.detailCode === "cas_updated" &&
      receipt.observedRefBefore !== receipt.expectedBaseCommit
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedRefBefore"],
        message: "A successful CAS must observe the exact authorized base beforehand.",
      });
    }
    if (
      receipt.detailCode === "update_ref_rejected" &&
      receipt.observedRefAfter !== receipt.expectedBaseCommit
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedRefAfter"],
        message: "A definite rejected update must leave the target at its exact base.",
      });
    }
  });

export type ArtifactCandidateChangedPath = z.infer<
  typeof ArtifactCandidateChangedPathSchema
>;
export type ArtifactCandidateMetadata = z.infer<
  typeof ArtifactCandidateMetadataSchema
>;
export type ArtifactCandidateReceipt = z.infer<
  typeof ArtifactCandidateReceiptSchema
>;
export type ArtifactPromotionOutcome = z.infer<
  typeof ArtifactPromotionOutcomeSchema
>;
export type ArtifactPromotionAttemptReceipt = z.infer<
  typeof ArtifactPromotionAttemptReceiptSchema
>;
export type ArtifactPromotionReceipt = z.infer<
  typeof ArtifactPromotionReceiptSchema
>;
