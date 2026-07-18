import { beforeEach, describe, expect, it, vi } from "vitest";

const integration = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("./ledger-authority", () => ({
  resolveArtifactPromotionLedgerAuthority: (document: unknown, promotionId: string) => ({
    document,
    version: {
      headRevisionId: "revision-test",
      eventCount: 1,
      eventLogFingerprint: "fnv1a64:0000000000000000",
    },
    authorized: integration.resolve({}, promotionId),
    authorizedEventId: "event-promotion-authorized-test",
    authorizedAt: "2026-07-18T12:00:00.000Z",
  }),
}));

vi.mock("@/integration/artifact-promotion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integration/artifact-promotion")>()),
  resolveAuthorizedArtifactPromotion: integration.resolve,
}));

import { worldstateLedgerDocument } from "@/adapters/storage";
import { createHomeMoveSeedFixture } from "@/fixtures";

import {
  BrowserArtifactPromotionGatewayError,
  createBrowserArtifactPromotionGateway,
  createBrowserArtifactPromotionStatusGetter,
} from "./browser";
import { artifactPromotionId } from "./identity";
import { ArtifactCandidateReceiptSchema } from "./schema";

const OPERATOR_SECRET = "browser-promotion-operator-secret-that-is-long-enough";
const credentialProvider = () => OPERATOR_SECRET;

function candidateReceipt() {
  return ArtifactCandidateReceiptSchema.parse({
    metadata: {
      kind: "odeu.git-artifact-candidate",
      version: 1,
      candidateId: `artifact-candidate:sha256:${"b".repeat(64)}`,
      candidateRef: `refs/odeu/candidates/${"b".repeat(64)}`,
      repositoryId: "repository-browser-test",
      targetRef: "refs/heads/main",
      runId: "run-browser-test",
      briefId: "brief-browser-test",
      baseRevisionId: "rev-browser-test",
      sealedAt: "2026-07-18T12:00:00.000Z",
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

function promotionIdentity(receipt: ReturnType<typeof candidateReceipt>) {
  return artifactPromotionId({
    candidateId: receipt.metadata.candidateId,
    repositoryId: receipt.metadata.repositoryId,
    targetRef: receipt.metadata.targetRef,
    expectedBaseCommit: receipt.metadata.git.baseCommit,
    candidateCommit: receipt.metadata.git.candidateCommit,
  });
}

function proposal(receipt: ReturnType<typeof candidateReceipt>) {
  return {
    id: promotionIdentity(receipt),
    candidateId: receipt.metadata.candidateId,
    repositoryId: receipt.metadata.repositoryId,
    targetRef: receipt.metadata.targetRef,
    expectedBaseCommit: receipt.metadata.git.baseCommit,
    candidateCommit: receipt.metadata.git.candidateCommit,
  };
}

function promotionReceipt(candidate: ReturnType<typeof candidateReceipt>) {
  const promotion = proposal(candidate);
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
    attemptedAt: "2026-07-18T12:01:00.000Z",
    observedAt: "2026-07-18T12:01:01.000Z",
    outcome: "promoted" as const,
    observedRefBefore: promotion.expectedBaseCommit,
    observedRefAfter: promotion.candidateCommit,
    detailCode: "cas_updated" as const,
    detail: "The exact candidate was promoted.",
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
    projectLabel: "Browser gateway test",
    updatedAt: "2026-07-18T12:00:00.000Z",
  });
}

beforeEach(() => {
  integration.resolve.mockReset();
});

describe("browser artifact promotion boundary", () => {
  it("sends only the bounded ledger handoff and validates exact receipt binding", async () => {
    const candidate = candidateReceipt();
    const promotion = proposal(candidate);
    integration.resolve.mockReturnValue({ proposal: promotion, candidate });
    const fetchRequest = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body).sort()).toEqual(["document", "promotionId"]);
      expect(JSON.stringify(body)).not.toContain("signingSecret");
      expect(JSON.stringify(body)).not.toContain("repositoryPath");
      return new Response(
        JSON.stringify({
          ok: true,
          status: "completed",
          promotionId: promotion.id,
          receipt: promotionReceipt(candidate),
        }),
        { status: 200 },
      );
    });
    const gateway = createBrowserArtifactPromotionGateway({
      credentialProvider,
      fetch: fetchRequest,
    });

    await expect(
      gateway({ document: document(), promotionId: promotion.id }),
    ).resolves.toMatchObject({ ok: true, promotionId: promotion.id });
    expect(fetchRequest).toHaveBeenCalledOnce();
    const [url, init] = fetchRequest.mock.calls[0] ?? [];
    expect(init?.headers).toEqual({
      authorization: `Bearer ${OPERATOR_SECRET}`,
      "content-type": "application/json",
    });
    expect(String(url)).not.toContain(OPERATOR_SECRET);
    expect(String(init?.body)).not.toContain(OPERATOR_SECRET);
  });

  it("rejects a schema-valid response bound to another candidate", async () => {
    const candidate = candidateReceipt();
    const promotion = proposal(candidate);
    integration.resolve.mockReturnValue({ proposal: promotion, candidate });
    const fetchRequest = vi.fn(async () => {
      const receipt = promotionReceipt(candidate);
      return new Response(
        JSON.stringify({
          ok: true,
          status: "completed",
          promotionId: promotion.id,
          receipt: {
            ...receipt,
            candidateCommit: "9".repeat(40),
            observedRefAfter: "9".repeat(40),
          },
        }),
      );
    });

    await expect(
      createBrowserArtifactPromotionGateway({
        credentialProvider,
        fetch: fetchRequest,
      })({
        document: document(),
        promotionId: promotion.id,
      }),
    ).rejects.toBeInstanceOf(BrowserArtifactPromotionGatewayError);
  });

  it("preserves an outcome-unknown command response without inventing a receipt", async () => {
    const candidate = candidateReceipt();
    const promotion = proposal(candidate);
    integration.resolve.mockReturnValue({ proposal: promotion, candidate });
    const fetchRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: "outcome_unknown",
          promotionId: promotion.id,
          receipt: null,
        }),
        { status: 202 },
      ),
    );

    await expect(
      createBrowserArtifactPromotionGateway({
        credentialProvider,
        fetch: fetchRequest,
      })({
        document: document(),
        promotionId: promotion.id,
      }),
    ).resolves.toEqual({
      ok: true,
      status: "outcome_unknown",
      promotionId: promotion.id,
      receipt: null,
    });
  });

  it("rejects an outcome-unknown command response that carries an attempted receipt", async () => {
    const candidate = candidateReceipt();
    const promotion = proposal(candidate);
    integration.resolve.mockReturnValue({ proposal: promotion, candidate });
    const fetchRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: "outcome_unknown",
          promotionId: promotion.id,
          receipt: promotionReceipt(candidate),
        }),
        { status: 202 },
      ),
    );

    await expect(
      createBrowserArtifactPromotionGateway({
        credentialProvider,
        fetch: fetchRequest,
      })({
        document: document(),
        promotionId: promotion.id,
      }),
    ).rejects.toBeInstanceOf(BrowserArtifactPromotionGatewayError);
  });

  it("uses a body-based read-only status handoff and withholds server configuration", async () => {
    const candidate = candidateReceipt();
    const promotionId = promotionIdentity(candidate);
    integration.resolve.mockReturnValue({
      proposal: proposal(candidate),
      candidate,
    });
    const fetchRequest = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const body = JSON.parse(String(init?.body));
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        accept: "application/json",
        authorization: `Bearer ${OPERATOR_SECRET}`,
        "content-type": "application/json",
      });
      expect(url.search).toBe("");
      expect(Object.keys(body).sort()).toEqual(["document", "promotionId"]);
      expect(body.promotionId).toBe(promotionId);
      expect(url.toString()).not.toContain("signingSecret");
      expect(url.toString()).not.toContain("repositoryPath");
      expect(String(init?.body)).not.toContain("signingSecret");
      expect(String(init?.body)).not.toContain("repositoryPath");
      return new Response(
        JSON.stringify({
          ok: true,
          status: "completed",
          promotionId,
          receipt: promotionReceipt(candidate),
        }),
      );
    });

    await expect(
      createBrowserArtifactPromotionStatusGetter({
        credentialProvider,
        fetch: fetchRequest,
      })({
        document: document(),
        promotionId,
      }),
    ).resolves.toMatchObject({ ok: true, status: "completed", promotionId });
  });

  it("rejects malformed status responses after deriving the exact candidate locally", async () => {
    const candidate = candidateReceipt();
    integration.resolve.mockReturnValue({
      proposal: proposal(candidate),
      candidate,
    });
    const fetchRequest = vi.fn(async () => new Response("not-json"));
    const getter = createBrowserArtifactPromotionStatusGetter({
      credentialProvider,
      fetch: fetchRequest,
    });

    await expect(
      getter({
        document: document(),
        promotionId: promotionIdentity(candidate),
      }),
    ).rejects.toBeInstanceOf(BrowserArtifactPromotionGatewayError);
  });

  it("does not initiate promotion without transient operator authority", async () => {
    const candidate = candidateReceipt();
    const promotion = proposal(candidate);
    integration.resolve.mockReturnValue({ proposal: promotion, candidate });
    const fetchRequest = vi.fn();

    await expect(
      createBrowserArtifactPromotionGateway({ fetch: fetchRequest })({
        document: document(),
        promotionId: promotion.id,
      }),
    ).rejects.toMatchObject({ name: "OperatorCredentialUnavailableError" });
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
