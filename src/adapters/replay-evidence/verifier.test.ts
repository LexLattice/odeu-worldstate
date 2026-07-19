import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { semanticReplayBriefDigest } from "@/adapters/codex/replay";
import { AgentBriefSchema as CodexAgentBriefSchema } from "@/adapters/codex/schema";
import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";
import { assertReplayEvidenceResponseMatchesRequest } from "@/integration/replay-evidence-validation";

import {
  HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
  HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
  HOME_MOVE_REPLAY_ARTIFACT_PATH,
  HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
  HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
  HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS,
  HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
  HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  HOME_MOVE_REPLAY_IDENTITY,
  HOME_MOVE_REPLAY_EVIDENCE_V0_ARTIFACT_EVIDENCE_REF,
  HOME_MOVE_REPLAY_EVIDENCE_V0_BUNDLE_ID,
  HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST,
  HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_V0_TEST_EVIDENCE_REF_PREFIX,
  HOME_MOVE_REPLAY_EVIDENCE_V0_VERIFIER_IDENTITY,
  HOME_MOVE_REGISTERED_V0_SEMANTIC_BRIEF_DIGESTS,
  HOME_MOVE_REPLAY_V0_IDENTITY,
  HOME_MOVE_REPLAY_SUPPORT_PATH,
} from "./bundle";
import {
  ReplayEvidenceRequestSchema,
  ReplayEvidenceSuccessSchema,
} from "./schema";
import {
  ReplayEvidenceNotApplicableError,
  verifyReplayEvidence,
} from "./verifier";

function registeredRequest() {
  const fixture = createPrivateProjectionFixture();
  const codexRequest = domainBriefToCodexRunRequest(
    fixture.brief,
    "run-replay-evidence",
    "replay",
    "request-replay-evidence-codex",
  );
  return ReplayEvidenceRequestSchema.parse({
    validationRequestId: "request-replay-evidence-validation",
    validationId: "validation-replay-evidence",
    closureId: "closure-replay-evidence",
    runId: codexRequest.runId,
    briefId: codexRequest.brief.briefId,
    baseRevisionId: codexRequest.brief.sourceRevisionId,
    artifactBaseRef: codexRequest.brief.artifactBaseRef,
    replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
    semanticBriefDigest: semanticReplayBriefDigest(codexRequest.brief),
    exchangeSourceId: "source-codex-exchange:request-replay-evidence-codex",
    evidenceRequirements: codexRequest.brief.evidenceContract.requiredChecks.map(
      (requirement) => ({
        requirementId: requirement.checkId,
        label: requirement.label,
        kind: requirement.kind,
        command: requirement.command,
        required: requirement.blocking,
      }),
    ),
    expectedArtifacts: codexRequest.brief.evidenceContract.expectedArtifacts,
  });
}

describe("verifyReplayEvidence", () => {
  it("retains the exact v0 manifest and re-attests v0 exchanges without executing them", async () => {
    const stableJson = (value: unknown): string => {
      if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(",")}}`;
    };
    expect(
      `sha256:${createHash("sha256")
        .update(stableJson(HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST))
        .digest("hex")}`,
    ).toBe(HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST_DIGEST);

    const currentRequest = registeredRequest();
    const currentCodexBrief = domainBriefToCodexRunRequest(
      createPrivateProjectionFixture().brief,
      "run-historical-digest",
      "replay",
      "request-historical-digest",
    ).brief;
    const {
      delegationProfileId: _currentProfileId,
      ...unboundCodexBriefInput
    } = currentCodexBrief;
    void _currentProfileId;
    expect(
      semanticReplayBriefDigest(
        CodexAgentBriefSchema.parse({
          ...unboundCodexBriefInput,
          doneMeans: unboundCodexBriefInput.doneMeans.slice(0, 2),
          constraints: [],
          actions: {
            ...unboundCodexBriefInput.actions,
            allowed: [
              "Read and edit files inside the disposable demo workspace",
              "Run focused tests",
            ],
          },
        }),
      ),
    ).toBe(HOME_MOVE_REGISTERED_V0_SEMANTIC_BRIEF_DIGESTS.privateFixture);
    const currentResponse = await verifyReplayEvidence(currentRequest, {
      now: () => new Date("2026-07-17T15:59:59.000Z"),
    });
    const historicalRequest = ReplayEvidenceRequestSchema.parse({
      ...currentRequest,
      replayIdentity: HOME_MOVE_REPLAY_V0_IDENTITY,
      semanticBriefDigest:
        HOME_MOVE_REGISTERED_V0_SEMANTIC_BRIEF_DIGESTS.privateFixture,
    });
    const historicalResponse = ReplayEvidenceSuccessSchema.parse({
      ...currentResponse,
      verifier: {
        identity: HOME_MOVE_REPLAY_EVIDENCE_V0_VERIFIER_IDENTITY,
        version: 1,
        kind: "independent_fixture",
      },
      bindings: {
        ...currentResponse.bindings,
        replayIdentity: historicalRequest.replayIdentity,
        semanticBriefDigest: historicalRequest.semanticBriefDigest,
      },
      bundle: {
        bundleId: HOME_MOVE_REPLAY_EVIDENCE_V0_BUNDLE_ID,
        version: 1,
        manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST_DIGEST,
        artifactCount: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
      },
      observations: currentResponse.observations.map((observation) => ({
        ...observation,
        evidenceRef:
          observation.artifact !== null
            ? HOME_MOVE_REPLAY_EVIDENCE_V0_ARTIFACT_EVIDENCE_REF
            : `${HOME_MOVE_REPLAY_EVIDENCE_V0_TEST_EVIDENCE_REF_PREFIX}${encodeURIComponent(
                observation.requirementId,
              )}/${HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID}`,
        artifact:
          observation.artifact === null
            ? null
            : {
                ...observation.artifact,
                manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_V0_MANIFEST_DIGEST,
              },
      })),
    });

    expect(() =>
      assertReplayEvidenceResponseMatchesRequest({
        request: historicalRequest,
        response: historicalResponse,
      }),
    ).not.toThrow();
    await expect(verifyReplayEvidence(historicalRequest)).rejects.toBeInstanceOf(
      ReplayEvidenceNotApplicableError,
    );
  });

  it("independently observes the digest-pinned artifact and fixed vectors", async () => {
    const result = await verifyReplayEvidence(registeredRequest(), {
      now: () => new Date("2026-07-17T16:00:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      status: "passed",
      verifier: {
        identity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
        kind: "independent_fixture",
      },
      bindings: {
        validationId: "validation-replay-evidence",
        closureId: "closure-replay-evidence",
        runId: "run-replay-evidence",
      },
      observedAt: "2026-07-17T16:00:00.000Z",
      bundle: {
        bundleId: HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
        manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
        artifactCount: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
      },
    });
    expect(result.observations).toHaveLength(2);
    expect(result.observations).toContainEqual(
      expect.objectContaining({
        requirementId: "requirement-artifact-change",
        result: "passed",
        artifact: expect.objectContaining({
          path: HOME_MOVE_REPLAY_ARTIFACT_PATH,
          digest: HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
          byteLength: HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
          manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
        }),
        execution: null,
      }),
    );
    expect(result.observations).toContainEqual(
      expect.objectContaining({
        requirementId: "requirement-focused-tests",
        result: "passed",
        artifact: null,
        execution: expect.objectContaining({
          declaredCommand: "npm test -- moving-cost",
          executionKind: "fixture_equivalent",
          runnerId: HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
          passedCount: 3,
          totalCount: 3,
        }),
      }),
    );
    expect(
      result.observations.find(
        (item) => item.requirementId === "requirement-focused-tests",
      )?.detail,
    ).toContain("declared npm command was not executed");
  });

  it("has no worker-claim input and rejects claim-shaped additions", () => {
    expect(() =>
      ReplayEvidenceRequestSchema.parse({
        ...registeredRequest(),
        claimedChecks: [{ status: "passed" }],
      }),
    ).toThrow();
  });

  it("fails closed when the observed artifact bytes do not match the manifest", async () => {
    const result = await verifyReplayEvidence(registeredRequest(), {
      now: () => new Date("2026-07-17T16:00:00.000Z"),
      loadArtifact: async () => new TextEncoder().encode("altered artifact"),
    });

    expect(result.status).toBe("failed");
    expect(result.observations).toContainEqual(
      expect.objectContaining({
        requirementId: "requirement-artifact-change",
        result: "failed",
        detail: expect.stringContaining("digest does not match"),
      }),
    );
    expect(result.observations).toContainEqual(
      expect.objectContaining({
        requirementId: "requirement-focused-tests",
        result: "missing",
        execution: null,
      }),
    );
  });

  it("fails the complete artifact observation and skips execution when support bytes differ", async () => {
    const fixtureRoot = resolve(
      process.cwd(),
      "src/adapters/replay-evidence/fixtures/home-move-v0",
    );
    const primaryBytes = await readFile(
      resolve(fixtureRoot, HOME_MOVE_REPLAY_ARTIFACT_PATH),
    );
    const loadedPaths: string[] = [];
    const result = await verifyReplayEvidence(registeredRequest(), {
      now: () => new Date("2026-07-17T16:00:00.000Z"),
      loadArtifact: async (path) => {
        loadedPaths.push(path);
        return path === HOME_MOVE_REPLAY_ARTIFACT_PATH
          ? primaryBytes
          : new TextEncoder().encode("throw new Error('must not execute');");
      },
    });

    expect(result.status).toBe("failed");
    expect(
      result.observations.find(
        (item) => item.requirementId === "requirement-artifact-change",
      ),
    ).toMatchObject({
      result: "failed",
      detail: expect.stringContaining("support fixture digest"),
      artifact: null,
    });
    expect(
      result.observations.find(
        (item) => item.requirementId === "requirement-focused-tests",
      ),
    ).toMatchObject({
      result: "missing",
      execution: null,
    });
    expect(loadedPaths).toEqual([
      HOME_MOVE_REPLAY_ARTIFACT_PATH,
      HOME_MOVE_REPLAY_SUPPORT_PATH,
    ]);
  });

  it("rejects evidence-free passes and drift from the immutable verifier contract", async () => {
    const result = await verifyReplayEvidence(registeredRequest(), {
      now: () => new Date("2026-07-17T16:00:00.000Z"),
    });
    const testIndex = result.observations.findIndex(
      (observation) => observation.execution !== null,
    );
    const withoutExecution = result.observations.map((observation, index) =>
      index === testIndex
        ? { ...observation, artifact: null, execution: null }
        : observation,
    );
    const wrongRunner = result.observations.map((observation, index) =>
      index === testIndex && observation.execution
        ? {
            ...observation,
            execution: { ...observation.execution, runnerId: "unregistered" },
          }
        : observation,
    );
    const wrongCases = result.observations.map((observation, index) =>
      index === testIndex && observation.execution
        ? {
            ...observation,
            execution: {
              ...observation.execution,
              cases: observation.execution.cases.map((testCase, caseIndex) =>
                caseIndex === 0
                  ? { ...testCase, caseId: "unregistered" }
                  : testCase,
              ),
            },
          }
        : observation,
    );

    expect(
      ReplayEvidenceSuccessSchema.safeParse({
        ...result,
        observations: withoutExecution,
      }).success,
    ).toBe(false);
    expect(
      ReplayEvidenceSuccessSchema.safeParse({
        ...result,
        observations: wrongRunner,
      }).success,
    ).toBe(false);
    expect(
      ReplayEvidenceSuccessSchema.safeParse({
        ...result,
        observations: wrongCases,
      }).success,
    ).toBe(false);
    expect(
      ReplayEvidenceSuccessSchema.safeParse({
        ...result,
        verifier: { ...result.verifier, identity: "unregistered" },
      }).success,
    ).toBe(false);
    expect(
      ReplayEvidenceSuccessSchema.safeParse({
        ...result,
        bundle: {
          ...result.bundle,
          manifestDigest: `sha256:${"0".repeat(64)}`,
        },
      }).success,
    ).toBe(false);
    expect(
      result.observations.find((observation) => observation.execution)?.execution
        ?.cases.map((testCase) => testCase.caseId),
    ).toEqual(HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS);
  });

  it("refuses unknown replay meaning and altered evidence contracts", async () => {
    await expect(
      verifyReplayEvidence({
        ...registeredRequest(),
        semanticBriefDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(ReplayEvidenceNotApplicableError);
    await expect(
      verifyReplayEvidence({
        ...registeredRequest(),
        evidenceRequirements: registeredRequest().evidenceRequirements.map(
          (requirement) =>
            requirement.kind === "test"
              ? { ...requirement, command: "rm -rf workspace" }
              : requirement,
        ),
      }),
    ).rejects.toThrow(/exact authored moving-cost evidence contract/i);
    await expect(
      verifyReplayEvidence({
        ...registeredRequest(),
        expectedArtifacts: ["../private-file"],
      }),
    ).rejects.toThrow(/expected artifact contract/i);
  });
});
