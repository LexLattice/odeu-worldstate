import { describe, expect, it, vi } from "vitest";

import {
  LIVE_EVIDENCE_RUNNER_ID,
  LIVE_EVIDENCE_TEST_COMMAND,
  LIVE_EVIDENCE_VERIFIER_IDENTITY,
  LiveEvidenceFailureSchema,
  LiveEvidenceRequestSchema,
  LiveEvidenceSuccessSchema,
} from "./schema";
import {
  BROWSER_LIVE_EVIDENCE_RESPONSE_MAX_LENGTH,
  BrowserLiveEvidenceGatewayError,
  createBrowserLiveEvidenceGateway,
} from "./browser";
import { testLiveEvidenceHarnessObservation } from "./test-observation";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);
const OID_D = "d".repeat(40);
const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const CANDIDATE_ID = `artifact-candidate:sha256:${"c".repeat(64)}` as const;
const EMPTY_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const OPERATOR_SECRET = "browser-evidence-operator-secret-that-is-long-enough";
const credentialProvider = () => OPERATOR_SECRET;

function request() {
  return LiveEvidenceRequestSchema.parse({
    mode: "live",
    validationRequestId: "request-browser-live-evidence",
    validationId: "validation-browser-live-evidence",
    closureId: "closure-browser-live-evidence",
    runId: "run-browser-live-evidence",
    briefId: "brief-browser-live-evidence",
    baseRevisionId: "revision-browser-live-evidence",
    artifactBaseRef: `git:${OID_A}`,
    exchangeSourceId: "source-codex-exchange:request-browser-live-evidence",
    artifactCandidateId: CANDIDATE_ID,
    artifactCandidateCommit: OID_C,
    evidenceRequirements: [
      {
        requirementId: "requirement-focused-tests",
        label: "Focused moving-cost calculation tests pass",
        kind: "test",
        command: LIVE_EVIDENCE_TEST_COMMAND,
        required: true,
      },
      {
        requirementId: "requirement-artifact-change",
        label: "The planning-page artifact change is addressable",
        kind: "artifact",
        command: null,
        required: true,
      },
    ],
    expectedArtifacts: ["demo/moving-costs.html"],
    candidateReceipt: {
      metadata: {
        kind: "odeu.git-artifact-candidate",
        version: 1,
        candidateId: CANDIDATE_ID,
        candidateRef: "refs/odeu/candidates/browser-test",
        repositoryId: "browser-test-repository",
        targetRef: "refs/heads/main",
        runId: "run-browser-live-evidence",
        briefId: "brief-browser-live-evidence",
        baseRevisionId: "revision-browser-live-evidence",
        sealedAt: "2026-07-18T13:00:00.000Z",
        git: {
          objectFormat: "sha1",
          baseCommit: OID_A,
          baseTree: OID_B,
          candidateCommit: OID_C,
          candidateTree: OID_D,
        },
        patch: {
          format: "git-binary-diff-v1",
          digest: SHA_A,
          byteLength: 123,
        },
        manifest: {
          digest: SHA_B,
          entries: [
            {
              path: "demo/moving-costs.html",
              status: "modified",
              oldMode: "100644",
              newMode: "100644",
              oldBlob: OID_A,
              newBlob: OID_B,
            },
          ],
        },
      },
      signature: {
        algorithm: "hmac-sha256",
        keyId: "browser-test-key",
        digest: `hmac-sha256:${"d".repeat(64)}`,
      },
    },
  });
}

function success() {
  const input = request();
  return LiveEvidenceSuccessSchema.parse({
    ok: true,
    status: "passed",
    verifier: {
      identity: LIVE_EVIDENCE_VERIFIER_IDENTITY,
      version: 1,
      kind: "independent_live_candidate",
    },
    bindings: {
      validationRequestId: input.validationRequestId,
      validationId: input.validationId,
      closureId: input.closureId,
      runId: input.runId,
      briefId: input.briefId,
      baseRevisionId: input.baseRevisionId,
      artifactBaseRef: input.artifactBaseRef,
      exchangeSourceId: input.exchangeSourceId,
      artifactCandidateId: input.artifactCandidateId,
      artifactCandidateCommit: input.artifactCandidateCommit,
    },
    candidate: {
      candidateId: CANDIDATE_ID,
      candidateRef: input.candidateReceipt.metadata.candidateRef,
      repositoryId: input.candidateReceipt.metadata.repositoryId,
      targetRef: input.candidateReceipt.metadata.targetRef,
      baseCommit: OID_A,
      candidateCommit: OID_C,
      candidateTree: OID_D,
      manifestDigest: SHA_B,
      patchDigest: SHA_A,
      receiptKeyId: "browser-test-key",
    },
    observedAt: "2026-07-18T13:01:00.000Z",
    observations: [
      {
        requirementId: "requirement-focused-tests",
        result: "passed",
        evidenceRef: "git-candidate://browser/check",
        detail: "The exact registered command passed.",
        artifact: null,
        execution: {
          declaredCommand: LIVE_EVIDENCE_TEST_COMMAND,
          executionKind: "sandboxed_candidate",
          runnerId: LIVE_EVIDENCE_RUNNER_ID,
          exitCode: 0,
          termination: "exited",
          stdout: {
            observedDigest: EMPTY_SHA256,
            observedByteLength: 0,
            excerpt: "",
            excerptByteLength: 0,
            truncated: false,
          },
          stderr: {
            observedDigest: EMPTY_SHA256,
            observedByteLength: 0,
            excerpt: "",
            excerptByteLength: 0,
            truncated: false,
          },
          harness: testLiveEvidenceHarnessObservation(),
        },
      },
      {
        requirementId: "requirement-artifact-change",
        result: "passed",
        evidenceRef: "git-candidate://browser/artifact",
        detail: "The declared candidate artifact exists.",
        artifact: {
          path: "demo/moving-costs.html",
          blob: OID_B,
          byteLength: 42,
        },
        execution: null,
      },
    ],
  });
}

describe("browser live evidence gateway", () => {
  it("posts the exact bounded request and validates the response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(success()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const gateway = createBrowserLiveEvidenceGateway({
      credentialProvider,
      fetch,
    });

    await expect(gateway(request())).resolves.toEqual(success());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/evidence/live",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request()),
      }),
    );
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain(OPERATOR_SECRET);
  });

  it("retains typed verifier failure responses", async () => {
    const failure = LiveEvidenceFailureSchema.parse({
      ok: false,
      verifier: {
        identity: LIVE_EVIDENCE_VERIFIER_IDENTITY,
        version: 1,
        kind: "independent_live_candidate",
      },
      error: {
        code: "verification_failed",
        message: "The candidate receipt did not verify.",
        issues: [],
      },
    });
    const gateway = createBrowserLiveEvidenceGateway({
      credentialProvider,
      fetch: async () => new Response(JSON.stringify(failure), { status: 422 }),
    });

    await expect(gateway(request())).resolves.toEqual(failure);
  });

  it("rejects oversized, malformed, and unbounded response JSON", async () => {
    const oversized = createBrowserLiveEvidenceGateway({
      credentialProvider,
      fetch: async () =>
        new Response("x".repeat(BROWSER_LIVE_EVIDENCE_RESPONSE_MAX_LENGTH + 1)),
    });
    const malformed = createBrowserLiveEvidenceGateway({
      credentialProvider,
      fetch: async () => new Response("{not-json"),
    });
    const unbounded = createBrowserLiveEvidenceGateway({
      credentialProvider,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...success(),
            observations: [
              ...success().observations,
              { arbitraryProviderBody: "must not cross the browser boundary" },
            ],
          }),
        ),
    });

    await expect(oversized(request())).rejects.toBeInstanceOf(
      BrowserLiveEvidenceGatewayError,
    );
    await expect(malformed(request())).rejects.toBeInstanceOf(
      BrowserLiveEvidenceGatewayError,
    );
    await expect(unbounded(request())).rejects.toBeInstanceOf(
      BrowserLiveEvidenceGatewayError,
    );
  });

  it("does not start verification without transient operator authority", async () => {
    const fetch = vi.fn();
    const gateway = createBrowserLiveEvidenceGateway({ fetch });

    await expect(gateway(request())).rejects.toMatchObject({
      name: "BrowserLiveEvidenceGatewayError",
      cause: { name: "OperatorCredentialUnavailableError" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
