import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const boundary = vi.hoisted(() => ({
  promote: vi.fn(),
  status: vi.fn(),
  resolve: vi.fn(),
  privateCandidate: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("@/adapters/artifact-promotion/ledger-authority", () => ({
  resolveArtifactPromotionLedgerAuthority: (
    document: unknown,
    promotionId: string,
  ) => {
    const prior = boundary.resolve.mock.results.at(-1);
    return {
      document,
      authorized:
        prior?.type === "return"
          ? prior.value
          : boundary.resolve({}, promotionId),
      version: {
        headRevisionId: "revision-route-test",
        eventCount: 1,
        eventLogFingerprint: "fnv1a64:0000000000000000",
      },
      authorizedEventId: "event-promotion-authorized-route-test",
      authorizedAt: "2026-07-18T14:00:00.000Z",
    };
  },
}));

vi.mock("@/adapters/artifact-promotion/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters/artifact-promotion/server")>()),
  promoteArtifactCandidate: boundary.promote,
  getArtifactPromotionStatus: boundary.status,
}));

vi.mock("@/integration/artifact-promotion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integration/artifact-promotion")>()),
  resolveAuthorizedArtifactPromotion: boundary.resolve,
}));

vi.mock("@/adapters/codex/live-authority-server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/adapters/codex/live-authority-server")
  >()),
  verifyPrivateCompletedLiveCandidate: boundary.privateCandidate,
}));

vi.mock("@/adapters/live-evidence/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters/live-evidence/server")>()),
  verifyLiveEvidence: boundary.revalidate,
}));

import { ArtifactPromotionOutcomeUnknownError } from "@/adapters/artifact-promotion/server";
import { ArtifactCandidateReceiptSchema } from "@/adapters/artifact-promotion/schema";
import { artifactPromotionId } from "@/adapters/artifact-promotion/identity";
import { worldstateLedgerDocument } from "@/adapters/storage";
import { createHomeMoveSeedFixture } from "@/fixtures";
import { ArtifactPromotionCompilationError } from "@/integration/artifact-promotion";
import { LiveAuthorityServerError } from "@/adapters/codex/live-authority-server";

import { POST } from "./route";
import { POST as statusPost } from "./status/route";

const SECRET = "artifact-promotion-route-secret-00000000000000000000";
const OPERATOR_SECRET = "operator-route-test-secret-that-is-long-enough";
const PRIVILEGED_HEADERS = {
  authorization: `Bearer ${OPERATOR_SECRET}`,
  origin: "http://localhost",
  "sec-fetch-site": "same-origin",
} as const;

function candidate() {
  return ArtifactCandidateReceiptSchema.parse({
    metadata: {
      kind: "odeu.git-artifact-candidate",
      version: 1,
      candidateId: `artifact-candidate:sha256:${"b".repeat(64)}`,
      candidateRef: `refs/odeu/candidates/${"b".repeat(64)}`,
      repositoryId: "repository-route-test",
      targetRef: "refs/heads/main",
      runId: "run-route-test",
      briefId: "brief-route-test",
      baseRevisionId: "rev-route-test",
      sealedAt: "2026-07-18T14:00:00.000Z",
      git: {
        objectFormat: "sha1",
        baseCommit: "a".repeat(40),
        baseTree: "d".repeat(40),
        candidateCommit: "c".repeat(40),
        candidateTree: "e".repeat(40),
      },
      patch: {
        format: "git-binary-diff-v1",
        digest: `sha256:${"2".repeat(64)}`,
        byteLength: 64,
      },
      manifest: {
        digest: `sha256:${"3".repeat(64)}`,
        entries: [
          {
            path: "demo/moving-costs.html",
            status: "added",
            oldMode: null,
            newMode: "100644",
            oldBlob: null,
            newBlob: "1".repeat(40),
          },
        ],
      },
    },
    signature: {
      algorithm: "hmac-sha256",
      keyId: "artifact-key-v1",
      digest: `hmac-sha256:${"4".repeat(64)}`,
    },
  });
}

function proposal(receipt: ReturnType<typeof candidate>) {
  const metadata = receipt.metadata;
  const id = artifactPromotionId({
    candidateId: metadata.candidateId,
    repositoryId: metadata.repositoryId,
    targetRef: metadata.targetRef,
    expectedBaseCommit: metadata.git.baseCommit,
    candidateCommit: metadata.git.candidateCommit,
  });
  return {
    id,
    integratedRevisionId: "revision-route-test",
    repositoryId: metadata.repositoryId,
    targetRef: metadata.targetRef,
    expectedBaseCommit: metadata.git.baseCommit,
    candidateId: metadata.candidateId,
    candidateCommit: metadata.git.candidateCommit,
  };
}

const PRIVATE_BRIEF = {
  briefId: "brief-route-test",
  sourceRevisionId: "rev-route-test",
  artifactBaseRef: `git:${"a".repeat(40)}`,
  evidenceContract: {
    requiredChecks: [
      {
        checkId: "requirement-route-artifact",
        label: "Route artifact check",
        kind: "artifact",
        command: null,
        blocking: true,
      },
    ],
    expectedArtifacts: ["demo/moving-costs.html"],
  },
} as const;

const DURABLE_VALIDATION_REQUEST = {
  runId: "run-route-test",
  briefId: PRIVATE_BRIEF.briefId,
  baseRevisionId: PRIVATE_BRIEF.sourceRevisionId,
  artifactBaseRef: PRIVATE_BRIEF.artifactBaseRef,
  evidenceRequirements: [
    {
      requirementId: "requirement-route-artifact",
      label: "Route artifact check",
      kind: "artifact",
      command: null,
      required: true,
    },
  ],
  expectedArtifacts: ["demo/moving-costs.html"],
} as const;

function receipt(candidateReceipt: ReturnType<typeof candidate>) {
  const promotion = proposal(candidateReceipt);
  return {
    kind: "odeu.git-artifact-promotion-status" as const,
    version: 1 as const,
    promotionId: promotion.id,
    candidateId: promotion.candidateId,
    repositoryId: promotion.repositoryId,
    targetRef: promotion.targetRef,
    expectedBaseCommit: promotion.expectedBaseCommit,
    candidateCommit: promotion.candidateCommit,
    authorityIntentDigest: `sha256:${"8".repeat(64)}`,
    attemptedAt: "2026-07-18T14:01:00.000Z",
    observedAt: "2026-07-18T14:01:01.000Z",
    outcome: "promoted" as const,
    observedRefBefore: promotion.expectedBaseCommit,
    observedRefAfter: promotion.candidateCommit,
    detailCode: "cas_updated" as const,
    detail: "The exact configured target advanced.",
    signature: {
      algorithm: "hmac-sha256" as const,
      keyId: "artifact-key-v1",
      digest: `hmac-sha256:${"5".repeat(64)}`,
    },
  };
}

function document() {
  const fixture = createHomeMoveSeedFixture();
  return worldstateLedgerDocument({
    ledger: fixture.ledger,
    projectLabel: "Promotion route test",
    updatedAt: "2026-07-18T14:00:00.000Z",
  });
}

function configure(): void {
  vi.stubEnv("ODEU_CODEX_PROMOTION_REPOSITORY", "/srv/private/repository");
  vi.stubEnv("ODEU_CODEX_PROMOTION_STATUS_STORE", "/srv/private/status");
  vi.stubEnv("ODEU_CODEX_REPOSITORY_ID", "repository-route-test");
  vi.stubEnv("ODEU_CODEX_PROMOTION_TARGET_REF", "refs/heads/main");
  vi.stubEnv("ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID", "artifact-key-v1");
  vi.stubEnv("ODEU_CODEX_ARTIFACT_SIGNING_SECRET", SECRET);
  vi.stubEnv("ODEU_OPERATOR_ALLOWED_ORIGIN", "http://localhost");
  vi.stubEnv("ODEU_OPERATOR_BEARER_SECRET", OPERATOR_SECRET);
  vi.stubEnv(
    "ODEU_LIVE_EVIDENCE_SIGNING_SECRETS",
    JSON.stringify({ "artifact-key-v1": SECRET }),
  );
  vi.stubEnv(
    "ODEU_LIVE_EVIDENCE_REPOSITORIES",
    JSON.stringify({
      "repository-route-test": {
        repositoryPath: "/srv/private/repository",
      },
    }),
  );
}

function post(body: string, headers: HeadersInit = {}): Promise<Response> {
  return POST(
    new Request("http://localhost/api/artifacts/promote", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...PRIVILEGED_HEADERS,
        ...headers,
      },
      body,
    }),
  );
}

function status(body: string): Promise<Response> {
  return statusPost(
    new Request("http://localhost/api/artifacts/promote/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...PRIVILEGED_HEADERS,
      },
      body,
    }),
  );
}

beforeEach(() => {
  boundary.promote.mockReset();
  boundary.status.mockReset();
  boundary.resolve.mockReset();
  boundary.privateCandidate.mockReset();
  boundary.revalidate.mockReset();
  boundary.privateCandidate.mockResolvedValue({
    request: { runId: "run-route-test", brief: PRIVATE_BRIEF },
  });
  boundary.revalidate.mockResolvedValue({ status: "passed" });
  configure();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("artifact promotion HTTP boundary", () => {
  it("re-parses the ledger and derives all privileged inputs from server configuration", async () => {
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    const signedReceipt = receipt(candidateReceipt);
    boundary.resolve.mockImplementation((state, promotionId) => {
      expect(state.canonical.projectId).toBe(document().projectId);
      expect(promotionId).toBe(promotion.id);
      return {
        proposal: promotion,
        candidate: candidateReceipt,
        validationRequest: DURABLE_VALIDATION_REQUEST,
      };
    });
    boundary.promote.mockResolvedValue({
      receipt: signedReceipt,
      receiptPath: "/srv/private/status/result.json",
    });

    const response = await post(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ok: true,
      promotionId: promotion.id,
      receipt: { outcome: "promoted" },
    });
    expect(boundary.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "/srv/private/repository",
        statusStoreDirectory: "/srv/private/status",
        repositoryId: "repository-route-test",
        targetRef: "refs/heads/main",
        candidate: candidateReceipt,
        signingSecrets: { "artifact-key-v1": SECRET },
        authority: {
          projectId: document().projectId,
          semanticHeadRevisionId: "revision-route-test",
          authorizedEventId: "event-promotion-authorized-route-test",
          authorizedAt: "2026-07-18T14:00:00.000Z",
          ledgerVersion: {
            headRevisionId: "revision-route-test",
            eventCount: 1,
            eventLogFingerprint: "fnv1a64:0000000000000000",
          },
          ledgerPrefixDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      }),
    );
    expect(boundary.privateCandidate).toHaveBeenCalledWith(candidateReceipt);
    expect(boundary.revalidate).toHaveBeenCalledWith(
      DURABLE_VALIDATION_REQUEST,
      {
        signingSecrets: { "artifact-key-v1": SECRET },
        repositories: {
          "repository-route-test": {
            repositoryPath: "/srv/private/repository",
          },
        },
      },
    );
    expect(boundary.revalidate.mock.invocationCallOrder[0]).toBeLessThan(
      boundary.promote.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(body)).not.toContain("/srv/private");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("never reports an unpersisted attempted receipt as completed", async () => {
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    const attemptedReceipt = receipt(candidateReceipt);
    boundary.resolve.mockReturnValue({
      proposal: promotion,
      candidate: candidateReceipt,
      validationRequest: DURABLE_VALIDATION_REQUEST,
    });
    boundary.promote.mockRejectedValue(
      new ArtifactPromotionOutcomeUnknownError(
        "The status write was not durably established.",
      ),
    );

    const response = await post(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      ok: true,
      status: "outcome_unknown",
      promotionId: promotion.id,
      receipt: null,
    });
    expect(JSON.stringify(body)).not.toContain(attemptedReceipt.signature.digest);
  });

  it("rejects a ledger-forged returned candidate absent from the private completed response", async () => {
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    boundary.resolve.mockReturnValue({
      proposal: promotion,
      candidate: candidateReceipt,
      validationRequest: DURABLE_VALIDATION_REQUEST,
    });
    boundary.privateCandidate.mockRejectedValue(
      new LiveAuthorityServerError(
        "candidate_not_recorded",
        "private response was blocked and had no candidate",
      ),
    );

    const response = await post(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "promotion_not_authorized" },
    });
    expect(boundary.revalidate).not.toHaveBeenCalled();
    expect(boundary.promote).not.toHaveBeenCalled();
  });

  it("blocks CAS when immediate independent candidate revalidation fails", async () => {
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    boundary.resolve.mockReturnValue({
      proposal: promotion,
      candidate: candidateReceipt,
      validationRequest: DURABLE_VALIDATION_REQUEST,
    });
    boundary.revalidate.mockResolvedValue({ status: "failed" });

    const response = await post(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "promotion_failed" },
    });
    expect(boundary.privateCandidate).toHaveBeenCalledOnce();
    expect(boundary.promote).not.toHaveBeenCalled();
  });

  it("fails closed before CAS for absent authority, extra browser paths, and oversized bodies", async () => {
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    boundary.resolve.mockImplementation(() => {
      throw new ArtifactPromotionCompilationError(["not authorized"]);
    });
    const unauthorized = await post(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );
    const injectedPath = await post(
      JSON.stringify({
        document: document(),
        promotionId: promotion.id,
        repository: "/tmp/browser-controlled",
      }),
    );
    const oversized = await post("{}", {
      "content-length": String(3 * 1024 * 1024),
    });

    expect(unauthorized.status).toBe(409);
    await expect(unauthorized.json()).resolves.toMatchObject({
      error: { code: "promotion_not_authorized" },
    });
    expect(injectedPath.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(boundary.promote).not.toHaveBeenCalled();
  });

  it("observes durable status through a body-based read and never initiates promotion", async () => {
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    const signedReceipt = receipt(candidateReceipt);
    boundary.status.mockResolvedValue({
      state: "completed",
      promotionId: promotion.id,
      attempt: { private: "not exposed" },
      receipt: signedReceipt,
    });
    boundary.resolve.mockReturnValue({
      proposal: promotion,
      candidate: candidateReceipt,
    });
    const response = await status(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      ok: true,
      status: "completed",
      promotionId: promotion.id,
      receipt: signedReceipt,
    });
    expect(boundary.status).toHaveBeenCalledWith(expect.objectContaining({
      candidate: candidateReceipt,
      signingSecrets: { "artifact-key-v1": SECRET },
      statusStoreDirectory: "/srv/private/status",
    }));
    expect(boundary.promote).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("reports an attempt-only journal as nonterminal and exposes no receipt", async () => {
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    boundary.status.mockResolvedValue({
      state: "attempt_only",
      promotionId: promotion.id,
      attempt: { private: "not exposed" },
    });
    boundary.resolve.mockReturnValue({
      proposal: promotion,
      candidate: candidateReceipt,
    });

    const response = await status(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "attempt_only",
      promotionId: promotion.id,
      receipt: null,
    });
    expect(boundary.promote).not.toHaveBeenCalled();
  });

  it("returns typed public failures without leaking private configuration", async () => {
    vi.stubEnv("ODEU_CODEX_PROMOTION_STATUS_STORE", "");
    const candidateReceipt = candidate();
    const promotion = proposal(candidateReceipt);
    boundary.resolve.mockReturnValue({
      proposal: promotion,
      candidate: candidateReceipt,
    });
    const response = await status(
      JSON.stringify({ document: document(), promotionId: promotion.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      error: {
        code: "promotion_unavailable",
        message: "The artifact promotion status service is unavailable.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("/srv/private");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("rejects missing authority and cross-origin status reads before ledger or Git work", async () => {
    const missingBearer = await POST(
      new Request("http://localhost/api/artifacts/promote", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: "{not-json",
      }),
    );
    const crossOriginStatus = await statusPost(
      new Request("http://localhost/api/artifacts/promote/status", {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        body: "{not-json",
      }),
    );

    expect(missingBearer.status).toBe(401);
    await expect(missingBearer.json()).resolves.toMatchObject({
      error: { code: "operator_unauthorized" },
    });
    expect(crossOriginStatus.status).toBe(403);
    await expect(crossOriginStatus.json()).resolves.toMatchObject({
      error: { code: "operator_cross_origin" },
    });
    expect(boundary.resolve).not.toHaveBeenCalled();
    expect(boundary.privateCandidate).not.toHaveBeenCalled();
    expect(boundary.revalidate).not.toHaveBeenCalled();
    expect(boundary.promote).not.toHaveBeenCalled();
    expect(boundary.status).not.toHaveBeenCalled();
  });
});
