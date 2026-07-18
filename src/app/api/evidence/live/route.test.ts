import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createLiveEvidenceGitFixture,
  TEST_LIVE_EVIDENCE_KEY_ID,
  TEST_LIVE_EVIDENCE_SECRET,
  type LiveEvidenceGitFixture,
} from "@/adapters/live-evidence/test-fixture";

import { POST } from "./route";

const fixtures: LiveEvidenceGitFixture[] = [];
const OPERATOR_SECRET = "operator-evidence-route-secret-that-is-long-enough";
const PRIVILEGED_HEADERS = {
  authorization: `Bearer ${OPERATOR_SECRET}`,
  origin: "http://localhost",
  "sec-fetch-site": "same-origin",
} as const;

beforeEach(() => {
  vi.stubEnv("ODEU_OPERATOR_ALLOWED_ORIGIN", "http://localhost");
  vi.stubEnv("ODEU_OPERATOR_BEARER_SECRET", OPERATOR_SECRET);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<LiveEvidenceGitFixture> {
  const created = await createLiveEvidenceGitFixture();
  fixtures.push(created);
  return created;
}

function configure(created: LiveEvidenceGitFixture): void {
  vi.stubEnv(
    "ODEU_LIVE_EVIDENCE_SIGNING_SECRETS",
    JSON.stringify({
      [TEST_LIVE_EVIDENCE_KEY_ID]: TEST_LIVE_EVIDENCE_SECRET,
    }),
  );
  vi.stubEnv(
    "ODEU_LIVE_EVIDENCE_REPOSITORIES",
    JSON.stringify({
      [created.receipt.metadata.repositoryId]: {
        repositoryPath: created.repositoryPath,
      },
    }),
  );
}

function post(body: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/evidence/live", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...PRIVILEGED_HEADERS,
      },
      body,
    }),
  );
}

describe("POST /api/evidence/live", { timeout: 15_000 }, () => {
  it("validates the signed candidate and returns bounded independent observations", async () => {
    const created = await fixture();
    configure(created);
    const response = await post(JSON.stringify(created.request));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "passed",
      bindings: {
        closureId: created.request.closureId,
        runId: created.request.runId,
        briefId: created.request.briefId,
        baseRevisionId: created.request.baseRevisionId,
        artifactBaseRef: created.request.artifactBaseRef,
        exchangeSourceId: created.request.exchangeSourceId,
        artifactCandidateId: created.request.artifactCandidateId,
        artifactCandidateCommit: created.request.artifactCandidateCommit,
      },
      candidate: {
        candidateId: created.receipt.metadata.candidateId,
        candidateCommit: created.candidateCommit,
      },
      observations: expect.arrayContaining([
        expect.objectContaining({
          requirementId: "requirement-focused-tests",
          result: "passed",
          execution: expect.objectContaining({
            declaredCommand: "npm test -- moving-cost",
            executionKind: "sandboxed_candidate",
          }),
        }),
        expect.objectContaining({
          requirementId: "requirement-artifact-change",
          result: "passed",
          artifact: expect.objectContaining({
            path: "demo/moving-costs.html",
          }),
        }),
      ]),
    });
    expect(body.observations).toHaveLength(
      created.request.evidenceRequirements.length,
    );
  }, 30_000);

  it("rejects replay, invalid signatures, and browser repository paths with typed responses", async () => {
    const created = await fixture();
    configure(created);
    const replay = await post(
      JSON.stringify({ ...created.request, mode: "replay" }),
    );
    const invalidSignature = await post(
      JSON.stringify({
        ...created.request,
        candidateReceipt: {
          ...created.receipt,
          signature: {
            ...created.receipt.signature,
            digest: `hmac-sha256:${"0".repeat(64)}`,
          },
        },
      }),
    );
    const browserPath = await post(
      JSON.stringify({
        ...created.request,
        repositoryPath: created.repositoryPath,
      }),
    );

    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "replay_not_applicable" },
    });
    expect(invalidSignature.status).toBe(422);
    await expect(invalidSignature.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "verification_failed" },
    });
    expect(browserPath.status).toBe(400);
    await expect(browserPath.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it("returns typed unavailable, malformed, and oversized failures within route bounds", async () => {
    const created = await fixture();
    const unavailable = await post(JSON.stringify(created.request));
    const malformed = await post("{not-json");
    const oversized = await post(
      JSON.stringify({ ...created.request, padding: "x".repeat(600_000) }),
    );

    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "verification_unavailable" },
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        message: expect.stringContaining("byte limit"),
      },
    });
  });

  it("rejects missing authority and cross-origin requests before reading malformed evidence", async () => {
    const missingBearer = await POST(
      new Request("http://localhost/api/evidence/live", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: "{not-json",
      }),
    );
    const crossOrigin = await POST(
      new Request("http://localhost/api/evidence/live", {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "content-length": String(600_000),
        },
        body: "{}",
      }),
    );

    expect(missingBearer.status).toBe(401);
    await expect(missingBearer.json()).resolves.toMatchObject({
      error: { code: "operator_unauthorized" },
    });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      error: { code: "operator_cross_origin" },
    });
  });
});
