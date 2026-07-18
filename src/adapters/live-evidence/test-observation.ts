import {
  LIVE_EVIDENCE_HARNESS_DIGEST,
  LIVE_EVIDENCE_HARNESS_PROFILE_ID,
  LIVE_EVIDENCE_SUPPORT_PATH,
  type LiveEvidenceExecutionObservation,
} from "./schema";

export function testLiveEvidenceHarnessObservation(
  supportBlob = "7".repeat(40),
): LiveEvidenceExecutionObservation["harness"] {
  return {
    profileId: LIVE_EVIDENCE_HARNESS_PROFILE_ID,
    digest: LIVE_EVIDENCE_HARNESS_DIGEST,
    reportVerified: true,
    support: {
      path: LIVE_EVIDENCE_SUPPORT_PATH,
      blob: supportBlob,
      byteLength: 256,
    },
    cases: [
      {
        caseId: "two-ordinary-quotes",
        expectedTotalCents: 110_000,
        observedTotalCents: 110_000,
        result: "passed",
      },
      {
        caseId: "decimal-components",
        expectedTotalCents: 107_100,
        observedTotalCents: 107_100,
        result: "passed",
      },
      {
        caseId: "zero-fees",
        expectedTotalCents: 110_000,
        observedTotalCents: 110_000,
        result: "passed",
      },
    ],
    isolation: {
      boundary: "bubblewrap-prlimit",
      candidateInputs: "registered_blobs_read_only",
      network: "unshared",
      nestedUserNamespaces: "disabled",
      aggregateCgroupIsolation: false,
      addressSpaceBytesPerProcess: 2_147_483_648,
      cpuSecondsPerProcess: 5,
      processLimitInUserNamespace: 16,
      fileBytesPerProcess: 1_048_576,
      openFilesPerProcess: 64,
      tmpfsBytes: 16_777_216,
      capturedOutputBytes: 65_536,
    },
  };
}
