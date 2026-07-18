import { describe, expect, it, vi } from "vitest";

import { semanticReplayBriefDigest } from "@/adapters/codex/replay";
import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { HOME_MOVE_REPLAY_IDENTITY } from "./bundle";
import {
  BrowserReplayEvidenceGatewayError,
  createBrowserReplayEvidenceGateway,
} from "./browser";
import {
  ReplayEvidenceFailureSchema,
  ReplayEvidenceRequestSchema,
} from "./schema";

function registeredRequest() {
  const fixture = createPrivateProjectionFixture();
  const codexRequest = domainBriefToCodexRunRequest(
    fixture.brief,
    "run-browser-evidence",
    "replay",
    "request-browser-evidence-codex",
  );
  return ReplayEvidenceRequestSchema.parse({
    validationRequestId: "request-browser-evidence",
    validationId: "validation-browser-evidence",
    closureId: "closure-browser-evidence",
    runId: codexRequest.runId,
    briefId: codexRequest.brief.briefId,
    baseRevisionId: codexRequest.brief.sourceRevisionId,
    artifactBaseRef: codexRequest.brief.artifactBaseRef,
    replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
    semanticBriefDigest: semanticReplayBriefDigest(codexRequest.brief),
    exchangeSourceId: "source-codex-exchange:request-browser-evidence-codex",
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

describe("createBrowserReplayEvidenceGateway", () => {
  it("posts the exact typed request and retains a typed verifier failure", async () => {
    const request = registeredRequest();
    const failure = ReplayEvidenceFailureSchema.parse({
      ok: false,
      verifier: {
        identity: "odeu-replay-evidence-verifier-v0",
        version: 1,
        kind: "independent_fixture",
      },
      error: {
        code: "replay_not_applicable",
        message: "No registered evidence fixture.",
        issues: [],
      },
    });
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify(failure), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const gateway = createBrowserReplayEvidenceGateway({
      endpoint: "/evidence-test",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(gateway(request)).resolves.toEqual(failure);
    expect(fetch).toHaveBeenCalledWith("/evidence-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  });

  it("fails closed on transport and response-schema errors", async () => {
    const request = registeredRequest();
    const offline = createBrowserReplayEvidenceGateway({
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as typeof globalThis.fetch,
    });
    const invalid = createBrowserReplayEvidenceGateway({
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ) as typeof globalThis.fetch,
    });

    await expect(offline(request)).rejects.toMatchObject({
      name: "BrowserReplayEvidenceGatewayError",
      httpStatus: null,
    });
    await expect(invalid(request)).rejects.toBeInstanceOf(
      BrowserReplayEvidenceGatewayError,
    );
  });
});
