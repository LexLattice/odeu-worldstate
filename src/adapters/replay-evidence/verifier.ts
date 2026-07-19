import "server-only";

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
  HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
  HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF,
  HOME_MOVE_REPLAY_ARTIFACT_PATH,
  HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
  HOME_MOVE_REPLAY_EVIDENCE_ARTIFACTS,
  HOME_MOVE_REPLAY_EVIDENCE_BUNDLE,
  HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
  HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
  HOME_MOVE_REPLAY_EVIDENCE_MANIFEST,
  HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_PROFILES,
  HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
  HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
  HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  HOME_MOVE_REPLAY_SUPPORT_PATH,
  HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX,
} from "./bundle";
import {
  ReplayEvidenceFailureSchema,
  ReplayEvidenceRequestSchema,
  ReplayEvidenceSuccessSchema,
  type ReplayEvidenceFailure,
  type ReplayEvidenceObservation,
  type ReplayEvidenceRequest,
  type ReplayEvidenceSuccess,
} from "./schema";

const MAX_FIXTURE_ARTIFACT_BYTES = 128 * 1_024;

type MovingCostInput = {
  readonly base: number;
  readonly distance: number;
  readonly fees: number;
};

type ReplayEvidenceVerifierOptions = {
  readonly now?: () => Date;
  readonly loadArtifact?: (path: string) => Promise<Uint8Array>;
};

type RegisteredArtifact =
  (typeof HOME_MOVE_REPLAY_EVIDENCE_ARTIFACTS)[number];

type ArtifactReadObservation = {
  readonly artifact: RegisteredArtifact;
  readonly bytes: Uint8Array | null;
  readonly failure: string | null;
};

type ReplayEvidenceCaseObservation = NonNullable<
  ReplayEvidenceObservation["execution"]
>["cases"][number];

type EvidenceRequirementRole = "test" | "artifact";

type RegisteredEvidenceProfile = {
  readonly expectedArtifacts: readonly string[];
  readonly evidenceRequirements: readonly {
    readonly role: EvidenceRequirementRole;
    readonly label: string;
    readonly kind: string;
    readonly command: string | null;
    readonly required: boolean;
  }[];
};

export class ReplayEvidenceNotApplicableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayEvidenceNotApplicableError";
  }
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function registeredManifestDigest(): `sha256:${string}` {
  return sha256(stableJson(HOME_MOVE_REPLAY_EVIDENCE_MANIFEST));
}

function assertRegisteredManifestIntegrity(): void {
  const observedDigest = registeredManifestDigest();
  if (
    observedDigest !== HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST ||
    HOME_MOVE_REPLAY_EVIDENCE_BUNDLE.manifestDigest !==
      HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST
  ) {
    throw new Error(
      "The registered replay evidence manifest does not match its verifier pin.",
    );
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const candidateRelative = relative(parent, candidate);
  return (
    candidateRelative === "" ||
    (candidateRelative !== ".." &&
      !candidateRelative.startsWith(`..${sep}`) &&
      !isAbsolute(candidateRelative))
  );
}

async function loadRegisteredArtifact(path: string): Promise<Uint8Array> {
  if (
    !HOME_MOVE_REPLAY_EVIDENCE_ARTIFACTS.some(
      (artifact) => artifact.path === path,
    )
  ) {
    throw new Error("The verifier refused an unregistered fixture artifact path.");
  }
  const fixtureRoot = resolve(
    process.cwd(),
    "src/adapters/replay-evidence/fixtures/home-move-v0",
  );
  const candidate = resolve(fixtureRoot, path);
  const [realRoot, candidateStat] = await Promise.all([
    realpath(fixtureRoot),
    lstat(candidate),
  ]);
  if (candidateStat.isSymbolicLink()) {
    throw new Error("The registered fixture artifact must not be a symbolic link.");
  }
  if (!candidateStat.isFile()) {
    throw new Error("The registered fixture artifact is not a regular file.");
  }
  if (candidateStat.size > MAX_FIXTURE_ARTIFACT_BYTES) {
    throw new Error("The registered fixture artifact exceeds the verifier byte limit.");
  }
  const realCandidate = await realpath(candidate);
  if (!containsPath(realRoot, realCandidate)) {
    throw new Error("The registered fixture artifact escapes its fixture root.");
  }
  return readFile(realCandidate);
}

async function observeRegisteredArtifact(
  artifact: RegisteredArtifact,
  loadArtifact: (path: string) => Promise<Uint8Array>,
): Promise<ArtifactReadObservation> {
  let bytes: Uint8Array;
  try {
    bytes = await loadArtifact(artifact.path);
  } catch {
    return {
      artifact,
      bytes: null,
      failure: `The verifier could not read the registered ${artifact.role} fixture bytes as a bounded regular file.`,
    };
  }
  if (bytes.byteLength > MAX_FIXTURE_ARTIFACT_BYTES) {
    return {
      artifact,
      bytes,
      failure: `The observed ${artifact.role} fixture exceeds the verifier byte limit.`,
    };
  }
  if (sha256(bytes) !== artifact.digest) {
    return {
      artifact,
      bytes,
      failure: `The observed ${artifact.role} fixture digest does not match its registered manifest.`,
    };
  }
  if (bytes.byteLength !== artifact.byteLength) {
    return {
      artifact,
      bytes,
      failure: `The observed ${artifact.role} fixture byte length does not match its registered manifest.`,
    };
  }
  return { artifact, bytes, failure: null };
}

async function importRegisteredMovingCostCalculator(
  supportBytes: Uint8Array,
): Promise<(input: MovingCostInput) => number> {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    supportBytes,
  ).toString("base64")}`;
  const fixtureModule = (await import(
    /* webpackIgnore: true */ moduleUrl
  )) as Record<string, unknown>;
  const calculateMovingTotalCents = fixtureModule.calculateMovingTotalCents;
  if (typeof calculateMovingTotalCents !== "function") {
    throw new Error(
      "The digest-pinned moving-cost support module has no registered calculator export.",
    );
  }
  return calculateMovingTotalCents as (input: MovingCostInput) => number;
}

function registeredProfile(request: ReplayEvidenceRequest): {
  readonly profile: RegisteredEvidenceProfile;
  readonly requirementIds: Readonly<Record<EvidenceRequirementRole, string>>;
} {
  if (request.replayIdentity !== HOME_MOVE_REPLAY_EVIDENCE_BUNDLE.replayIdentity) {
    throw new ReplayEvidenceNotApplicableError(
      "No independent fixture verifier is registered for this replay identity.",
    );
  }
  const profiles = HOME_MOVE_REPLAY_EVIDENCE_PROFILES as Readonly<
    Record<string, RegisteredEvidenceProfile | undefined>
  >;
  const profile = profiles[request.semanticBriefDigest];
  if (!profile) {
    throw new ReplayEvidenceNotApplicableError(
      "No independent fixture verifier is registered for this semantic brief.",
    );
  }
  if (
    stableJson(request.expectedArtifacts) !== stableJson(profile.expectedArtifacts)
  ) {
    throw new ReplayEvidenceNotApplicableError(
      "The expected artifact contract does not match the registered semantic brief.",
    );
  }

  const requirementIds: Partial<Record<EvidenceRequirementRole, string>> = {};
  for (const expected of profile.evidenceRequirements) {
    const matches = request.evidenceRequirements.filter(
      (requirement) =>
        requirement.label === expected.label &&
        requirement.kind === expected.kind &&
        requirement.command === expected.command &&
        requirement.required === expected.required,
    );
    if (matches.length !== 1) {
      throw new ReplayEvidenceNotApplicableError(
        "The replay verifier applies only to the exact authored moving-cost evidence contract.",
      );
    }
    requirementIds[expected.role] = matches[0]?.requirementId;
  }
  if (
    request.evidenceRequirements.length !==
      profile.evidenceRequirements.length ||
    !requirementIds.test ||
    !requirementIds.artifact
  ) {
    throw new ReplayEvidenceNotApplicableError(
      "The replay verifier applies only to the exact authored moving-cost evidence contract.",
    );
  }
  return {
    profile,
    requirementIds: {
      test: requirementIds.test,
      artifact: requirementIds.artifact,
    },
  };
}

function bindingProjection(request: ReplayEvidenceRequest) {
  return {
    validationRequestId: request.validationRequestId,
    validationId: request.validationId,
    closureId: request.closureId,
    runId: request.runId,
    briefId: request.briefId,
    baseRevisionId: request.baseRevisionId,
    artifactBaseRef: request.artifactBaseRef,
    replayIdentity: request.replayIdentity,
    semanticBriefDigest: request.semanticBriefDigest,
    exchangeSourceId: request.exchangeSourceId,
  };
}

function testEvidenceRef(requirementId: string): string {
  return `${HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX}${encodeURIComponent(
    requirementId,
  )}/${HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID}`;
}

/**
 * Independently observes the registered fixture bundle. The request intentionally
 * contains no worker report or claimed check fields, so claims cannot influence a
 * requirement result. The declared npm command is never executed. Instead, fixed
 * vectors invoke the calculator exported by the exact support-module bytes whose
 * digest and length were checked against the immutable manifest.
 */
export async function verifyReplayEvidence(
  input: ReplayEvidenceRequest,
  options: ReplayEvidenceVerifierOptions = {},
): Promise<ReplayEvidenceSuccess> {
  const request = ReplayEvidenceRequestSchema.parse(input);
  assertRegisteredManifestIntegrity();
  const { requirementIds } = registeredProfile(request);
  const loadArtifact = options.loadArtifact ?? loadRegisteredArtifact;
  const artifactReads = await Promise.all(
    HOME_MOVE_REPLAY_EVIDENCE_ARTIFACTS.map((artifact) =>
      observeRegisteredArtifact(artifact, loadArtifact),
    ),
  );
  const artifactFailure = artifactReads.find(
    (observation) => observation.failure !== null,
  );
  const artifactsReadable = artifactReads.every(
    (observation) => observation.bytes !== null,
  );
  const artifactBundlePassed = artifactFailure === undefined;

  let caseObservations: ReplayEvidenceCaseObservation[] = [];
  if (artifactBundlePassed) {
    const supportRead = artifactReads.find(
      (observation) => observation.artifact.path === HOME_MOVE_REPLAY_SUPPORT_PATH,
    );
    if (!supportRead?.bytes) {
      throw new Error(
        "The registered support fixture was absent after manifest verification.",
      );
    }
    const calculateMovingTotalCents =
      await importRegisteredMovingCostCalculator(supportRead.bytes);
    caseObservations = HOME_MOVE_REPLAY_EVIDENCE_BUNDLE.vectors.map(
      (testCase) => {
        try {
          const actual = calculateMovingTotalCents(testCase.input);
          const passed = actual === testCase.expectedTotalCents;
          return {
            caseId: testCase.caseId,
            result: passed ? ("passed" as const) : ("failed" as const),
            detail: passed
              ? `Observed the expected total of ${testCase.expectedTotalCents} cents.`
              : `Expected ${testCase.expectedTotalCents} cents but observed ${actual} cents.`,
          };
        } catch {
          return {
            caseId: testCase.caseId,
            result: "failed" as const,
            detail:
              "The digest-pinned moving-cost support module failed this registered case.",
          };
        }
      },
    );
  }
  const passedCount = caseObservations.filter(
    (testCase) => testCase.result === "passed",
  ).length;
  const testsPassed =
    artifactBundlePassed && passedCount === caseObservations.length;

  const observationsById = new Map<string, ReplayEvidenceObservation>();
  observationsById.set(requirementIds.artifact, {
    requirementId: requirementIds.artifact,
    result: artifactBundlePassed
      ? "passed"
      : artifactsReadable
        ? "failed"
        : "missing",
    evidenceRef: HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF,
    detail: artifactBundlePassed
      ? "The verifier independently read every registered artifact byte and matched the complete SHA-256 manifest."
      : (artifactFailure?.failure ??
        "The verifier did not establish complete fixture integrity."),
    artifact: artifactBundlePassed
      ? {
          path: HOME_MOVE_REPLAY_ARTIFACT_PATH,
          digest: HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
          byteLength: HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
          manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
        }
      : null,
    execution: null,
  });
  observationsById.set(requirementIds.test, {
    requirementId: requirementIds.test,
    result: testsPassed ? "passed" : artifactBundlePassed ? "failed" : "missing",
    evidenceRef: testEvidenceRef(requirementIds.test),
    detail: testsPassed
      ? "Every fixed vector passed against the digest-pinned module imported by the HTML artifact. The declared npm command was not executed."
      : artifactBundlePassed
        ? "The digest-pinned moving-cost module did not pass every registered vector."
        : "Fixture-equivalent tests were not run because complete artifact integrity was not established.",
    artifact: null,
    execution: artifactBundlePassed
      ? {
          declaredCommand: HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
          executionKind: HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
          runnerId: HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
          cases: caseObservations,
          passedCount,
          totalCount: caseObservations.length,
        }
      : null,
  });

  const observations = request.evidenceRequirements.map((requirement) => {
    const observation = observationsById.get(requirement.requirementId);
    if (!observation) {
      throw new Error(
        "The registered verifier could not bind an authored evidence requirement.",
      );
    }
    return observation;
  });

  return ReplayEvidenceSuccessSchema.parse({
    ok: true,
    status: observations.every((observation) => observation.result === "passed")
      ? "passed"
      : "failed",
    verifier: {
      identity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
      version: 2,
      kind: "independent_fixture",
    },
    bindings: bindingProjection(request),
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
    bundle: {
      bundleId: HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
      version: 2,
      manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
      artifactCount: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
    },
    observations,
  });
}

export function parseReplayEvidenceRequest(input: unknown): ReplayEvidenceRequest {
  return ReplayEvidenceRequestSchema.parse(input);
}

export function replayEvidenceFailure(error: unknown): ReplayEvidenceFailure {
  const notApplicable = error instanceof ReplayEvidenceNotApplicableError;
  return ReplayEvidenceFailureSchema.parse({
    ok: false,
    verifier: {
      identity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
      version: 2,
      kind: "independent_fixture",
    },
    error: {
      code: notApplicable
        ? "replay_not_applicable"
        : "verification_unavailable",
      message: notApplicable
        ? error.message
        : "The independent fixture verifier is unavailable.",
      issues: [],
    },
  });
}
