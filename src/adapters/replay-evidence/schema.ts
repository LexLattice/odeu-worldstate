import { z } from "zod";

import {
  HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
  HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
  HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF,
  HOME_MOVE_REPLAY_ARTIFACT_PATH,
  HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
  HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
  HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
  HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_COUNT,
  HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS,
  HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
  HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
  HOME_MOVE_REPLAY_EVIDENCE_V0_ARTIFACT_EVIDENCE_REF,
  HOME_MOVE_REPLAY_EVIDENCE_V0_BUNDLE_ID,
  HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_V0_TEST_EVIDENCE_REF_PREFIX,
  HOME_MOVE_REPLAY_EVIDENCE_V0_VERIFIER_IDENTITY,
  HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  HOME_MOVE_REPLAY_IDENTITY,
  HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX,
  HOME_MOVE_REPLAY_V0_IDENTITY,
} from "./bundle";

const StableId = z.string().trim().min(1).max(160);
const NonEmptyText = z.string().trim().min(1).max(8_000);
const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ReplayEvidenceRequirementSchema = z
  .object({
    requirementId: StableId,
    label: z.string().trim().min(1).max(240),
    kind: z.enum(["test", "artifact", "review", "command", "other"]),
    command: z.string().trim().min(1).max(1_000).nullable(),
    required: z.boolean(),
  })
  .strict();

export const ReplayEvidenceBindingsSchema = z
  .object({
    validationRequestId: StableId,
    validationId: StableId,
    closureId: StableId,
    runId: StableId,
    briefId: StableId,
    baseRevisionId: StableId,
    artifactBaseRef: StableId,
    replayIdentity: StableId,
    semanticBriefDigest: Sha256Digest,
    exchangeSourceId: StableId,
  })
  .strict();

export const ReplayEvidenceRequestSchema = ReplayEvidenceBindingsSchema.extend({
  evidenceRequirements: z
    .array(ReplayEvidenceRequirementSchema)
    .min(1)
    .max(24),
  expectedArtifacts: z.array(NonEmptyText).min(1).max(24),
})
  .strict()
  .superRefine((request, context) => {
    const requirementIds = new Set<string>();
    request.evidenceRequirements.forEach((requirement, index) => {
      if (requirementIds.has(requirement.requirementId)) {
        context.addIssue({
          code: "custom",
          path: ["evidenceRequirements", index, "requirementId"],
          message: `Duplicate replay evidence requirement: ${requirement.requirementId}`,
        });
      }
      requirementIds.add(requirement.requirementId);
    });
  });

export const ReplayEvidenceTestCaseObservationSchema = z
  .object({
    caseId: StableId,
    result: z.enum(["passed", "failed"]),
    detail: NonEmptyText,
  })
  .strict();

export const ReplayEvidenceExecutionObservationSchema = z
  .object({
    declaredCommand: z.literal(HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND),
    executionKind: z.literal(HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND),
    runnerId: z.literal(HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID),
    cases: z
      .array(ReplayEvidenceTestCaseObservationSchema)
      .length(HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_COUNT),
    passedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().positive(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.totalCount !== execution.cases.length) {
      context.addIssue({
        code: "custom",
        path: ["totalCount"],
        message: "Execution totalCount must equal the number of observed cases.",
      });
    }
    const passedCount = execution.cases.filter(
      (item) => item.result === "passed",
    ).length;
    if (execution.passedCount !== passedCount) {
      context.addIssue({
        code: "custom",
        path: ["passedCount"],
        message: "Execution passedCount must equal the observed passing cases.",
      });
    }
    const caseIds = execution.cases.map((item) => item.caseId);
    if (
      new Set(caseIds).size !== caseIds.length ||
      HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.some(
        (caseId) => !caseIds.includes(caseId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "Execution cases must match the registered fixture vectors one-to-one.",
      });
    }
  });

const V0 = {
  replayIdentity: HOME_MOVE_REPLAY_V0_IDENTITY,
  verifierIdentity: HOME_MOVE_REPLAY_EVIDENCE_V0_VERIFIER_IDENTITY,
  verifierVersion: 1,
  bundleId: HOME_MOVE_REPLAY_EVIDENCE_V0_BUNDLE_ID,
  bundleVersion: 1,
  manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST_DIGEST,
  artifactEvidenceRef: HOME_MOVE_REPLAY_EVIDENCE_V0_ARTIFACT_EVIDENCE_REF,
  testEvidenceRefPrefix: HOME_MOVE_REPLAY_EVIDENCE_V0_TEST_EVIDENCE_REF_PREFIX,
} as const;

const V1 = {
  replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
  verifierIdentity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  verifierVersion: 2,
  bundleId: HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
  bundleVersion: 2,
  manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
  artifactEvidenceRef: HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF,
  testEvidenceRefPrefix: HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX,
} as const;

type ReplayEvidenceVersion = typeof V0 | typeof V1;

function replayEvidenceArtifactObservationSchema<
  const Version extends ReplayEvidenceVersion,
>(version: Version) {
  return z
    .object({
      path: z.literal(HOME_MOVE_REPLAY_ARTIFACT_PATH),
      digest: z.literal(HOME_MOVE_REPLAY_ARTIFACT_DIGEST),
      byteLength: z.literal(HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH),
      manifestDigest: z.literal(version.manifestDigest),
    })
    .strict();
}

function replayEvidenceObservationSchema<
  const Version extends ReplayEvidenceVersion,
>(version: Version) {
  return z
    .object({
      requirementId: StableId,
      result: z.enum(["passed", "failed", "missing"]),
      evidenceRef: z.string().trim().min(1).max(1_000),
      detail: NonEmptyText,
      artifact: replayEvidenceArtifactObservationSchema(version).nullable(),
      execution: ReplayEvidenceExecutionObservationSchema.nullable(),
    })
    .strict()
    .superRefine((observation, context) => {
      if (observation.artifact !== null && observation.execution !== null) {
        context.addIssue({
          code: "custom",
          path: ["execution"],
          message: "One requirement observation cannot be both artifact and execution evidence.",
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
          message: "A passing replay observation must carry registered artifact or execution evidence.",
        });
      }
      if (
        observation.result === "passed" &&
        observation.execution !== null &&
        observation.execution.passedCount !== observation.execution.totalCount
      ) {
        context.addIssue({
          code: "custom",
          path: ["execution", "passedCount"],
          message: "A passing execution observation requires every registered case to pass.",
        });
      }
      if (
        observation.artifact !== null &&
        observation.evidenceRef !== version.artifactEvidenceRef
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidenceRef"],
          message: "Artifact evidence must use its versioned registered fixture reference.",
        });
      }
      if (
        observation.execution !== null &&
        observation.evidenceRef !==
          `${version.testEvidenceRefPrefix}${encodeURIComponent(
            observation.requirementId,
          )}/${HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID}`
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidenceRef"],
          message: "Execution evidence must use its versioned fixture-runner reference.",
        });
      }
    });
}

function replayEvidenceSuccessSchema<const Version extends ReplayEvidenceVersion>(
  version: Version,
) {
  return z
    .object({
      ok: z.literal(true),
      status: z.enum(["passed", "failed"]),
      verifier: z
        .object({
          identity: z.literal(version.verifierIdentity),
          version: z.literal(version.verifierVersion),
          kind: z.literal("independent_fixture"),
        })
        .strict(),
      bindings: ReplayEvidenceBindingsSchema,
      observedAt: z.iso.datetime(),
      bundle: z
        .object({
          bundleId: z.literal(version.bundleId),
          version: z.literal(version.bundleVersion),
          manifestDigest: z.literal(version.manifestDigest),
          artifactCount: z.literal(HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT),
        })
        .strict(),
      observations: z
        .array(replayEvidenceObservationSchema(version))
        .min(1)
        .max(24),
    })
    .strict()
    .superRefine((response, context) => {
      if (response.bindings.replayIdentity !== version.replayIdentity) {
        context.addIssue({
          code: "custom",
          path: ["bindings", "replayIdentity"],
          message: "Replay identity must match the versioned evidence bundle.",
        });
      }
      const requirementIds = new Set<string>();
      response.observations.forEach((observation, index) => {
        if (requirementIds.has(observation.requirementId)) {
          context.addIssue({
            code: "custom",
            path: ["observations", index, "requirementId"],
            message: `Duplicate replay evidence observation: ${observation.requirementId}`,
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
          message: "Replay evidence status must reflect all requirement observations.",
        });
      }
    });
}

function replayEvidenceFailureSchema<const Version extends ReplayEvidenceVersion>(
  version: Version,
) {
  return z
    .object({
      ok: z.literal(false),
      verifier: z
        .object({
          identity: z.literal(version.verifierIdentity),
          version: z.literal(version.verifierVersion),
          kind: z.literal("independent_fixture"),
        })
        .strict(),
      error: z
        .object({
          code: z.enum([
            "invalid_request",
            "replay_not_applicable",
            "verification_unavailable",
          ]),
          message: NonEmptyText,
          issues: z.array(NonEmptyText).max(40),
        })
        .strict(),
    })
    .strict();
}

export const ReplayEvidenceV0ArtifactObservationSchema =
  replayEvidenceArtifactObservationSchema(V0);
export const ReplayEvidenceArtifactObservationSchema =
  replayEvidenceArtifactObservationSchema(V1);
export const ReplayEvidenceV0ObservationSchema =
  replayEvidenceObservationSchema(V0);
export const ReplayEvidenceObservationSchema = replayEvidenceObservationSchema(V1);
export const ReplayEvidenceV0SuccessSchema = replayEvidenceSuccessSchema(V0);
export const ReplayEvidenceV1SuccessSchema = replayEvidenceSuccessSchema(V1);
export const ReplayEvidenceSuccessSchema = z.union([
  ReplayEvidenceV1SuccessSchema,
  ReplayEvidenceV0SuccessSchema,
]);
export const ReplayEvidenceV0FailureSchema = replayEvidenceFailureSchema(V0);
export const ReplayEvidenceV1FailureSchema = replayEvidenceFailureSchema(V1);
export const ReplayEvidenceFailureSchema = z.union([
  ReplayEvidenceV1FailureSchema,
  ReplayEvidenceV0FailureSchema,
]);
export const ReplayEvidenceResponseSchema = z.union([
  ReplayEvidenceSuccessSchema,
  ReplayEvidenceFailureSchema,
]);

export type ReplayEvidenceRequirement = z.infer<
  typeof ReplayEvidenceRequirementSchema
>;
export type ReplayEvidenceBindings = z.infer<
  typeof ReplayEvidenceBindingsSchema
>;
export type ReplayEvidenceRequest = z.infer<typeof ReplayEvidenceRequestSchema>;
export type ReplayEvidenceObservation = z.infer<
  typeof ReplayEvidenceSuccessSchema
>["observations"][number];
export type ReplayEvidenceSuccess = z.infer<typeof ReplayEvidenceSuccessSchema>;
export type ReplayEvidenceFailure = z.infer<typeof ReplayEvidenceFailureSchema>;
export type ReplayEvidenceResponse = z.infer<typeof ReplayEvidenceResponseSchema>;
