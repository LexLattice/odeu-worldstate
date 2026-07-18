import { createHash } from "node:crypto";
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
  HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_VECTORS,
  HOME_MOVE_REPLAY_IDENTITY,
  HOME_MOVE_REPLAY_SUPPORT_BYTE_LENGTH,
  HOME_MOVE_REPLAY_SUPPORT_DIGEST,
  HOME_MOVE_REPLAY_SUPPORT_PATH,
} from "./bundle";
import { ReplayEvidenceRequestSchema } from "./schema";
import { verifyReplayEvidence } from "./verifier";

function verificationRequest() {
  const fixture = createPrivateProjectionFixture();
  const codexRequest = domainBriefToCodexRunRequest(
    fixture.brief,
    "run-moving-cost-command",
    "replay",
    "request-moving-cost-command-codex",
  );
  return ReplayEvidenceRequestSchema.parse({
    validationRequestId: "request-moving-cost-command",
    validationId: "validation-moving-cost-command",
    closureId: "closure-moving-cost-command",
    runId: codexRequest.runId,
    briefId: codexRequest.brief.briefId,
    baseRevisionId: codexRequest.brief.sourceRevisionId,
    artifactBaseRef: codexRequest.brief.artifactBaseRef,
    replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
    semanticBriefDigest: semanticReplayBriefDigest(codexRequest.brief),
    exchangeSourceId: "source-codex-exchange:request-moving-cost-command-codex",
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

describe("moving-cost replay artifact", () => {
  it("matches its pinned bytes and passes the fixture-equivalent vectors", async () => {
    const artifact = await readFile(
      resolve(
        process.cwd(),
        "src/adapters/replay-evidence/fixtures/home-move-v0",
        HOME_MOVE_REPLAY_ARTIFACT_PATH,
      ),
    );
    const support = await readFile(
      resolve(
        process.cwd(),
        "src/adapters/replay-evidence/fixtures/home-move-v0",
        HOME_MOVE_REPLAY_SUPPORT_PATH,
      ),
    );
    const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
    const supportDigest = `sha256:${createHash("sha256")
      .update(support)
      .digest("hex")}`;
    const html = artifact.toString("utf8");
    const result = await verifyReplayEvidence(verificationRequest(), {
      now: () => new Date("2026-07-17T16:00:00.000Z"),
    });

    expect(digest).toBe(HOME_MOVE_REPLAY_ARTIFACT_DIGEST);
    expect(artifact.byteLength).toBe(HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH);
    expect(supportDigest).toBe(HOME_MOVE_REPLAY_SUPPORT_DIGEST);
    expect(support.byteLength).toBe(HOME_MOVE_REPLAY_SUPPORT_BYTE_LENGTH);
    expect(html.match(/class="quote"/g)).toHaveLength(2);
    expect(html).toContain(
      "import { calculateMovingTotalCents } from './moving-costs.mjs';",
    );
    expect(html).toContain("total: calculateMovingTotalCents(quote)");
    expect(html).not.toContain("const cents =");
    expect(result.status).toBe("passed");
    expect(result.bundle).toMatchObject({
      manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
      artifactCount: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
    });
    expect(
      result.observations.find(
        (item) => item.requirementId === "requirement-focused-tests",
      ),
    ).toMatchObject({
      result: "passed",
      execution: {
        declaredCommand: "npm test -- moving-cost",
        executionKind: "fixture_equivalent",
        passedCount: 3,
        cases: HOME_MOVE_REPLAY_EVIDENCE_VECTORS.map((testCase) =>
          expect.objectContaining({
            caseId: testCase.caseId,
            result: "passed",
          }),
        ),
      },
    });
  });
});
