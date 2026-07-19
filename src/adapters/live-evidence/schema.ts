import { z } from "zod";

import { ArtifactCandidateReceiptSchema } from "@/adapters/artifact-promotion/schema";
import { MOVING_COST_DELEGATION_PROFILE_ID } from "@/domain";

export const LIVE_EVIDENCE_VERIFIER_IDENTITY =
  "odeu-live-candidate-evidence-verifier-v0";
export const LIVE_EVIDENCE_RUNNER_ID =
  "odeu-moving-cost-host-harness-bwrap-prlimit-v1";
export const LIVE_EVIDENCE_HARNESS_PROFILE_ID =
  MOVING_COST_DELEGATION_PROFILE_ID;
export const LIVE_EVIDENCE_HARNESS_DIGEST =
  "sha256:234abcfb8f09413e71277d52c89c309609f26679e3a3d9921f48ffd8ce503e03";
export const LIVE_EVIDENCE_TEST_COMMAND = "npm test -- moving-cost";
export const LIVE_EVIDENCE_ARTIFACT_PATH = "demo/moving-costs.html";
export const LIVE_EVIDENCE_SUPPORT_PATH = "demo/moving-costs.mjs";
export const LIVE_EVIDENCE_OUTPUT_EXCERPT_MAX_BYTES = 8 * 1_024;
export const LIVE_EVIDENCE_OUTPUT_OBSERVED_MAX_BYTES = 1 * 1_024 * 1_024;

const StableIdSchema = z.string().trim().min(1).max(240);
const NonEmptyTextSchema = z.string().trim().min(1).max(2_000);
const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ArtifactCandidateIdSchema = z
  .string()
  .regex(/^artifact-candidate:sha256:[0-9a-f]{64}$/);
const LIVE_EVIDENCE_REGISTERED_CASE_TOTALS = {
  "two-ordinary-quotes": 110_000,
  "decimal-components": 107_100,
  "zero-fees": 110_000,
} as const;

export const LiveEvidenceArtifactPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === ".."),
    "Artifact paths must be normalized repository-relative paths.",
  );

export const LiveEvidenceRequirementSchema = z
  .object({
    requirementId: StableIdSchema,
    label: z.string().trim().min(1).max(240),
    kind: z.enum(["test", "artifact", "review", "command", "other"]),
    command: z.string().trim().min(1).max(1_000).nullable(),
    required: z.boolean(),
  })
  .strict();

export const LiveEvidenceBindingsSchema = z
  .object({
    validationRequestId: StableIdSchema,
    validationId: StableIdSchema,
    closureId: StableIdSchema,
    runId: StableIdSchema,
    briefId: StableIdSchema,
    baseRevisionId: StableIdSchema,
    artifactBaseRef: z.string().regex(/^git:(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    exchangeSourceId: StableIdSchema,
    artifactCandidateId: ArtifactCandidateIdSchema,
    artifactCandidateCommit: GitObjectIdSchema,
  })
  .strict();

export const LiveEvidenceRequestSchema = LiveEvidenceBindingsSchema.extend({
  mode: z.enum(["live", "replay"]),
  evidenceRequirements: z.array(LiveEvidenceRequirementSchema).min(1).max(24),
  expectedArtifacts: z.array(LiveEvidenceArtifactPathSchema).min(1).max(24),
  candidateReceipt: ArtifactCandidateReceiptSchema,
})
  .strict()
  .superRefine((request, context) => {
    const requirementIds = new Set<string>();
    request.evidenceRequirements.forEach((requirement, index) => {
      if (requirementIds.has(requirement.requirementId)) {
        context.addIssue({
          code: "custom",
          path: ["evidenceRequirements", index, "requirementId"],
          message: `Duplicate live evidence requirement: ${requirement.requirementId}`,
        });
      }
      requirementIds.add(requirement.requirementId);
    });

    const artifactPaths = new Set<string>();
    request.expectedArtifacts.forEach((path, index) => {
      if (artifactPaths.has(path)) {
        context.addIssue({
          code: "custom",
          path: ["expectedArtifacts", index],
          message: `Duplicate expected artifact path: ${path}`,
        });
      }
      artifactPaths.add(path);
    });

    if (request.candidateReceipt.metadata.manifest.entries.length > 500) {
      context.addIssue({
        code: "custom",
        path: ["candidateReceipt", "metadata", "manifest", "entries"],
        message: "A live candidate receipt may contain at most 500 changed paths.",
      });
    }
  });

export const LiveEvidenceCommandOutputSchema = z
  .object({
    observedDigest: Sha256DigestSchema,
    observedByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(LIVE_EVIDENCE_OUTPUT_OBSERVED_MAX_BYTES),
    excerpt: z.string().max(LIVE_EVIDENCE_OUTPUT_EXCERPT_MAX_BYTES),
    excerptByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(LIVE_EVIDENCE_OUTPUT_EXCERPT_MAX_BYTES),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((output, context) => {
    const actualExcerptBytes = new TextEncoder().encode(output.excerpt).byteLength;
    if (actualExcerptBytes !== output.excerptByteLength) {
      context.addIssue({
        code: "custom",
        path: ["excerptByteLength"],
        message: "The excerpt byte length must describe the UTF-8 excerpt exactly.",
      });
    }
    if (output.excerptByteLength > output.observedByteLength) {
      context.addIssue({
        code: "custom",
        path: ["excerptByteLength"],
        message: "An excerpt cannot be longer than the bounded observed output.",
      });
    }
    if (!output.truncated && output.excerptByteLength !== output.observedByteLength) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "Complete command output must be represented by the complete excerpt.",
      });
    }
  });

export const LiveEvidenceExecutionObservationSchema = z
  .object({
    declaredCommand: z.literal(LIVE_EVIDENCE_TEST_COMMAND),
    executionKind: z.literal("sandboxed_candidate"),
    runnerId: z.literal(LIVE_EVIDENCE_RUNNER_ID),
    exitCode: z.number().int().min(0).max(255).nullable(),
    termination: z.enum(["exited", "timed_out", "output_limited"]),
    stdout: LiveEvidenceCommandOutputSchema,
    stderr: LiveEvidenceCommandOutputSchema,
    harness: z
      .object({
        profileId: z.literal(LIVE_EVIDENCE_HARNESS_PROFILE_ID),
        digest: z.literal(LIVE_EVIDENCE_HARNESS_DIGEST),
        reportVerified: z.boolean(),
        support: z
          .object({
            path: z.literal(LIVE_EVIDENCE_SUPPORT_PATH),
            blob: GitObjectIdSchema,
            byteLength: z.number().int().positive().max(128 * 1_024),
          })
          .strict(),
        cases: z
          .array(
            z
              .object({
                caseId: z.enum([
                  "two-ordinary-quotes",
                  "decimal-components",
                  "zero-fees",
                ]),
                expectedTotalCents: z.number().int().nonnegative(),
                observedTotalCents: z.number().int().nonnegative(),
                result: z.literal("passed"),
              })
              .strict(),
          )
          .max(3),
        isolation: z
          .object({
            boundary: z.literal("bubblewrap-prlimit"),
            candidateInputs: z.literal("registered_blobs_read_only"),
            network: z.literal("unshared"),
            nestedUserNamespaces: z.literal("disabled"),
            aggregateCgroupIsolation: z.literal(false),
            addressSpaceBytesPerProcess: z.literal(2_147_483_648),
            cpuSecondsPerProcess: z.literal(5),
            processLimitInUserNamespace: z.literal(16),
            fileBytesPerProcess: z.literal(1_048_576),
            openFilesPerProcess: z.literal(64),
            tmpfsBytes: z.literal(16_777_216),
            capturedOutputBytes: z.literal(65_536),
          })
          .strict(),
      })
      .strict()
      .superRefine((harness, context) => {
        const observedCaseIds = new Set<string>();
        harness.cases.forEach((testCase, index) => {
          if (observedCaseIds.has(testCase.caseId)) {
            context.addIssue({
              code: "custom",
              path: ["cases", index, "caseId"],
              message: `Duplicate immutable harness case: ${testCase.caseId}`,
            });
          }
          observedCaseIds.add(testCase.caseId);
          const expectedTotal =
            LIVE_EVIDENCE_REGISTERED_CASE_TOTALS[testCase.caseId];
          if (
            testCase.expectedTotalCents !== expectedTotal ||
            testCase.observedTotalCents !== expectedTotal
          ) {
            context.addIssue({
              code: "custom",
              path: ["cases", index],
              message: `Immutable harness case ${testCase.caseId} must retain its registered expected and observed total.`,
            });
          }
        });

        const hasExactRegisteredCases =
          harness.cases.length === 3 &&
          Object.keys(LIVE_EVIDENCE_REGISTERED_CASE_TOTALS).every((caseId) =>
            observedCaseIds.has(caseId),
          );
        if (
          (harness.reportVerified && !hasExactRegisteredCases) ||
          (!harness.reportVerified && harness.cases.length !== 0)
        ) {
          context.addIssue({
            code: "custom",
            path: ["reportVerified"],
            message:
              "A verified immutable harness report must contain exactly the three unique registered cases, and an unverified report must contain none.",
          });
        }
      }),
  })
  .strict();

export const LiveEvidenceArtifactObservationSchema = z
  .object({
    path: z.literal(LIVE_EVIDENCE_ARTIFACT_PATH),
    blob: GitObjectIdSchema,
    byteLength: z.number().int().nonnegative().max(4 * 1_024 * 1_024),
  })
  .strict();

export const LiveEvidenceObservationSchema = z
  .object({
    requirementId: StableIdSchema,
    result: z.enum(["passed", "failed", "missing"]),
    evidenceRef: z.string().trim().min(1).max(1_000),
    detail: NonEmptyTextSchema,
    artifact: LiveEvidenceArtifactObservationSchema.nullable(),
    execution: LiveEvidenceExecutionObservationSchema.nullable(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.artifact !== null && observation.execution !== null) {
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "One live requirement observation cannot contain both artifact and execution evidence.",
      });
    }
    if (
      observation.result === "passed" &&
      observation.artifact === null &&
      observation.execution === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "A passing live observation must carry independent candidate evidence.",
      });
    }
    if (
      observation.result === "passed" &&
      observation.execution !== null &&
      (observation.execution.exitCode !== 0 ||
        observation.execution.termination !== "exited" ||
        !observation.execution.harness.reportVerified)
    ) {
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message:
          "A passing command observation requires a bounded zero-exit sandbox run and an exact verified immutable harness report.",
      });
    }
  });

export const LiveEvidenceCandidateBindingSchema = z
  .object({
    candidateId: ArtifactCandidateIdSchema,
    candidateRef: z.string().trim().min(1).max(1_024),
    repositoryId: StableIdSchema,
    targetRef: z.string().trim().min(1).max(1_024),
    baseCommit: GitObjectIdSchema,
    candidateCommit: GitObjectIdSchema,
    candidateTree: GitObjectIdSchema,
    manifestDigest: Sha256DigestSchema,
    patchDigest: Sha256DigestSchema,
    receiptKeyId: StableIdSchema,
  })
  .strict();

export const LiveEvidenceSuccessSchema = z
  .object({
    ok: z.literal(true),
    status: z.enum(["passed", "failed"]),
    verifier: z
      .object({
        identity: z.literal(LIVE_EVIDENCE_VERIFIER_IDENTITY),
        version: z.literal(1),
        kind: z.literal("independent_live_candidate"),
      })
      .strict(),
    bindings: LiveEvidenceBindingsSchema,
    candidate: LiveEvidenceCandidateBindingSchema,
    observedAt: z.iso.datetime({ offset: true }),
    observations: z.array(LiveEvidenceObservationSchema).min(1).max(24),
  })
  .strict()
  .superRefine((response, context) => {
    const requirementIds = new Set<string>();
    response.observations.forEach((observation, index) => {
      if (requirementIds.has(observation.requirementId)) {
        context.addIssue({
          code: "custom",
          path: ["observations", index, "requirementId"],
          message: `Duplicate live evidence observation: ${observation.requirementId}`,
        });
      }
      requirementIds.add(observation.requirementId);
    });
    const expectedStatus = response.observations.every(
      (observation) => observation.result === "passed",
    )
      ? "passed"
      : "failed";
    if (response.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Live evidence status must reflect all requirement observations.",
      });
    }
  });

export const LiveEvidenceFailureSchema = z
  .object({
    ok: z.literal(false),
    verifier: z
      .object({
        identity: z.literal(LIVE_EVIDENCE_VERIFIER_IDENTITY),
        version: z.literal(1),
        kind: z.literal("independent_live_candidate"),
      })
      .strict(),
    error: z
      .object({
        code: z.enum([
          "invalid_request",
          "replay_not_applicable",
          "verification_failed",
          "verification_unavailable",
        ]),
        message: NonEmptyTextSchema,
        issues: z.array(NonEmptyTextSchema).max(40),
      })
      .strict(),
  })
  .strict();

export const LiveEvidenceResponseSchema = z.discriminatedUnion("ok", [
  LiveEvidenceSuccessSchema,
  LiveEvidenceFailureSchema,
]);

export type LiveEvidenceRequirement = z.infer<
  typeof LiveEvidenceRequirementSchema
>;
export type LiveEvidenceBindings = z.infer<typeof LiveEvidenceBindingsSchema>;
export type LiveEvidenceRequest = z.infer<typeof LiveEvidenceRequestSchema>;
export type LiveEvidenceCommandOutput = z.infer<
  typeof LiveEvidenceCommandOutputSchema
>;
export type LiveEvidenceExecutionObservation = z.infer<
  typeof LiveEvidenceExecutionObservationSchema
>;
export type LiveEvidenceObservation = z.infer<
  typeof LiveEvidenceObservationSchema
>;
export type LiveEvidenceSuccess = z.infer<typeof LiveEvidenceSuccessSchema>;
export type LiveEvidenceFailure = z.infer<typeof LiveEvidenceFailureSchema>;
export type LiveEvidenceResponse = z.infer<typeof LiveEvidenceResponseSchema>;
