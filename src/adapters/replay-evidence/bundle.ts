export const HOME_MOVE_REPLAY_IDENTITY = "home-move-fixture-replay-v0";
export const HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID =
  "home-move-replay-evidence-bundle-v0";
export const HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY =
  "odeu-replay-evidence-verifier-v0";
export const HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID =
  "home-move-calculation-v0";
export const HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND =
  "fixture_equivalent" as const;

export const HOME_MOVE_REPLAY_ARTIFACT_PATH = "demo/moving-costs.html";
export const HOME_MOVE_REPLAY_ARTIFACT_DIGEST =
  "sha256:3b6e65b81fde4d576a18864fe37f683ec847e70ac65c0750e2535e427b477a44";
export const HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH = 3_242;
export const HOME_MOVE_REPLAY_SUPPORT_PATH = "demo/moving-costs.mjs";
export const HOME_MOVE_REPLAY_SUPPORT_DIGEST =
  "sha256:36f6d62c9de23a1e7fa07ae5332bc34d517683749717fdeb514f1510eff33215";
export const HOME_MOVE_REPLAY_SUPPORT_BYTE_LENGTH = 278;

export const HOME_MOVE_REPLAY_EVIDENCE_TEST_LABEL =
  "Focused moving-cost calculation tests pass";
export const HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND =
  "npm test -- moving-cost";
export const HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_LABEL =
  "The planning-page artifact change is addressable";

export const HOME_MOVE_REGISTERED_SEMANTIC_BRIEF_DIGESTS = Object.freeze({
  privateFixture:
    "sha256:07d4a43af261a69d17a0cd31e992315e69421dccde4d900fc66c1b0d9308c13b",
  acceptedPlacement:
    "sha256:3d696c21e13931f3e4b3a8122d3439626d14dd3ca229133d314d018608a676ed",
} as const);

export const HOME_MOVE_REPLAY_EVIDENCE_ARTIFACTS = Object.freeze([
  Object.freeze({
    role: "primary" as const,
    path: HOME_MOVE_REPLAY_ARTIFACT_PATH,
    digest: HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
    byteLength: HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
  }),
  Object.freeze({
    role: "support" as const,
    path: HOME_MOVE_REPLAY_SUPPORT_PATH,
    digest: HOME_MOVE_REPLAY_SUPPORT_DIGEST,
    byteLength: HOME_MOVE_REPLAY_SUPPORT_BYTE_LENGTH,
  }),
]);
export const HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT =
  HOME_MOVE_REPLAY_EVIDENCE_ARTIFACTS.length;
export const HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF =
  `replay-evidence://${HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID}/artifacts/${encodeURIComponent(
    HOME_MOVE_REPLAY_ARTIFACT_PATH,
  )}`;
export const HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX =
  `replay-evidence://${HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID}/checks/`;

export const HOME_MOVE_REPLAY_EVIDENCE_VECTORS = Object.freeze([
  Object.freeze({
    caseId: "two-ordinary-quotes",
    input: Object.freeze({ base: 900, distance: 120, fees: 80 }),
    expectedTotalCents: 110_000,
  }),
  Object.freeze({
    caseId: "decimal-components",
    input: Object.freeze({ base: 840.25, distance: 190.4, fees: 40.35 }),
    expectedTotalCents: 107_100,
  }),
  Object.freeze({
    caseId: "zero-fees",
    input: Object.freeze({ base: 1_100, distance: 0, fees: 0 }),
    expectedTotalCents: 110_000,
  }),
]);
export const HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS = Object.freeze(
  HOME_MOVE_REPLAY_EVIDENCE_VECTORS.map((item) => item.caseId),
);
export const HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_COUNT =
  HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.length;

const HOME_MOVE_REPLAY_EVIDENCE_REQUIREMENT_PROFILE = Object.freeze([
  Object.freeze({
    role: "test" as const,
    label: HOME_MOVE_REPLAY_EVIDENCE_TEST_LABEL,
    kind: "test" as const,
    command: HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
    required: true,
  }),
  Object.freeze({
    role: "artifact" as const,
    label: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_LABEL,
    kind: "artifact" as const,
    command: null,
    required: true,
  }),
]);

export const HOME_MOVE_REPLAY_EVIDENCE_PROFILES = Object.freeze({
  [HOME_MOVE_REGISTERED_SEMANTIC_BRIEF_DIGESTS.privateFixture]: Object.freeze({
    expectedArtifacts: Object.freeze([HOME_MOVE_REPLAY_ARTIFACT_PATH]),
    evidenceRequirements: HOME_MOVE_REPLAY_EVIDENCE_REQUIREMENT_PROFILE,
  }),
  [HOME_MOVE_REGISTERED_SEMANTIC_BRIEF_DIGESTS.acceptedPlacement]: Object.freeze({
    expectedArtifacts: Object.freeze([HOME_MOVE_REPLAY_ARTIFACT_PATH]),
    evidenceRequirements: HOME_MOVE_REPLAY_EVIDENCE_REQUIREMENT_PROFILE,
  }),
});

export const HOME_MOVE_REPLAY_EVIDENCE_MANIFEST = Object.freeze({
  bundleId: HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
  version: 1 as const,
  replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
  verifierIdentity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  artifacts: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACTS,
  runner: Object.freeze({
    runnerId: HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
    executionKind: HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
    declaredCommand: HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
  }),
  vectors: HOME_MOVE_REPLAY_EVIDENCE_VECTORS,
  profiles: HOME_MOVE_REPLAY_EVIDENCE_PROFILES,
});

// Recompute with the verifier's stable JSON algorithm whenever the declarative
// registry changes. Runtime verification checks this pin before reading files.
export const HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST =
  "sha256:3b835f771b6fdaa3c1e0bb24f3f460107028d5f4c52626b4bfc3f6956abc9ac2";

export const HOME_MOVE_REPLAY_EVIDENCE_BUNDLE = Object.freeze({
  ...HOME_MOVE_REPLAY_EVIDENCE_MANIFEST,
  manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
});

export type HomeMoveReplayEvidenceBundle =
  typeof HOME_MOVE_REPLAY_EVIDENCE_BUNDLE;
