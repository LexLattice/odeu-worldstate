import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { semanticReplayBriefDigest } from "@/adapters/codex/replay";
import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

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
