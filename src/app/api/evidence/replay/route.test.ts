import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { semanticReplayBriefDigest } from "@/adapters/codex/replay";
import { HOME_MOVE_REPLAY_IDENTITY } from "@/adapters/replay-evidence/server";
import { ReplayEvidenceRequestSchema } from "@/adapters/replay-evidence/schema";
import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { POST } from "./route";

function registeredRequest() {
  const fixture = createPrivateProjectionFixture();
  const codexRequest = domainBriefToCodexRunRequest(
    fixture.brief,
    "run-route-evidence",
    "replay",
    "request-route-evidence-codex",
  );
  return ReplayEvidenceRequestSchema.parse({
    validationRequestId: "request-route-evidence",
    validationId: "validation-route-evidence",
    closureId: "closure-route-evidence",
    runId: codexRequest.runId,
    briefId: codexRequest.brief.briefId,
    baseRevisionId: codexRequest.brief.sourceRevisionId,
    artifactBaseRef: codexRequest.brief.artifactBaseRef,
    replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
    semanticBriefDigest: semanticReplayBriefDigest(codexRequest.brief),
    exchangeSourceId: "source-codex-exchange:request-route-evidence-codex",
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

function post(body: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/evidence/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

describe("POST /api/evidence/replay", () => {
  it("observes the registered replay bundle without executing worker claims", async () => {
    const response = await post(JSON.stringify(registeredRequest()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "passed",
      bindings: {
        validationRequestId: "request-route-evidence",
        validationId: "validation-route-evidence",
        closureId: "closure-route-evidence",
        runId: "run-route-evidence",
      },
      observations: expect.arrayContaining([
        expect.objectContaining({
          requirementId: "requirement-focused-tests",
          result: "passed",
          execution: expect.objectContaining({
            executionKind: "fixture_equivalent",
          }),
        }),
        expect.objectContaining({
          requirementId: "requirement-artifact-change",
          result: "passed",
        }),
      ]),
    });
  });

  it("returns bounded typed errors for malformed and inapplicable requests", async () => {
    const malformed = await post("{not-json");
    const inapplicable = await post(
      JSON.stringify({
        ...registeredRequest(),
        replayIdentity: "some-other-replay",
      }),
    );

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(inapplicable.status).toBe(409);
    await expect(inapplicable.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "replay_not_applicable" },
    });
  });

  it("rejects claim-shaped and duplicate-requirement input at the route", async () => {
    const request = registeredRequest();
    const withClaims = await post(
      JSON.stringify({ ...request, claimedChecks: [{ status: "passed" }] }),
    );
    const duplicate = await post(
      JSON.stringify({
        ...request,
        evidenceRequirements: [
          request.evidenceRequirements[0],
          request.evidenceRequirements[0],
        ],
      }),
    );

    expect(withClaims.status).toBe(400);
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        issues: [expect.stringContaining("Duplicate replay evidence requirement")],
      },
    });
  });

  it("keeps adversarial schema errors and oversized bodies inside typed bounds", async () => {
    const request = registeredRequest();
    const manyIssues = await post(
      JSON.stringify({
        ...request,
        evidenceRequirements: Array.from({ length: 24 }, () => ({})),
      }),
    );
    const longUnknownKey = await post(
      JSON.stringify({ ...request, [`unknown-${"x".repeat(12_000)}`]: true }),
    );
    const oversized = await post(
      JSON.stringify({ ...request, padding: "x".repeat(300_000) }),
    );

    expect(manyIssues.status).toBe(400);
    const manyIssuesBody = await manyIssues.json();
    expect(manyIssuesBody).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(manyIssuesBody.error.issues.length).toBeLessThanOrEqual(40);

    expect(longUnknownKey.status).toBe(400);
    const longUnknownKeyBody = await longUnknownKey.json();
    expect(longUnknownKeyBody).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(
      longUnknownKeyBody.error.issues.every(
        (issue: string) => issue.length <= 2_000,
      ),
    ).toBe(true);

    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining("byte limit") },
    });
  });
});
