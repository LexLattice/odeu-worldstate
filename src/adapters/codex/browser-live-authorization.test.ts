import { describe, expect, it, vi } from "vitest";

import { worldstateLedgerDocument } from "@/adapters/storage";
import { reduceWorldstateLedger } from "@/domain";
import { createLiveWorkerClosureFixture } from "@/fixtures";
import { authorizedCodexRunRequest } from "@/integration/authorized-codex-run";

import { AgentRunFailureSchema } from "./schema";

import {
  BrowserLiveAuthorityGatewayError,
  createBrowserAgentRuntimeCapabilityGetter,
  createBrowserLiveAuthorizationGateway,
  createBrowserLiveRunStatusGetter,
} from "./browser-live-authorization";

const OPERATOR_SECRET = "browser-live-operator-secret-that-is-long-enough";
const credentialProvider = () => OPERATOR_SECRET;

function queuedFixture() {
  const fixture = createLiveWorkerClosureFixture();
  const authorizationIndex = fixture.ledger.events.findIndex(
    (event) => event.type === "run.authorized",
  );
  if (authorizationIndex < 0)
    throw new Error("Expected an authorized live run fixture.");
  const ledger = {
    ...fixture.ledger,
    events: fixture.ledger.events.slice(0, authorizationIndex + 1),
  };
  const document = worldstateLedgerDocument({
    ledger,
    projectLabel: "Browser authority test",
    updatedAt: "2026-07-18T12:00:00.000Z",
  });
  const requestId = "request-browser-live-authority";
  const request = authorizedCodexRunRequest({
    state: reduceWorldstateLedger(ledger),
    runId: fixture.ids.run,
    requestId,
    secret: "browser-test-secret",
    now: new Date("2026-07-18T12:01:00.000Z"),
    nonce: "00000000-0000-4000-8000-000000000098",
  });
  return { document, runId: fixture.ids.run, requestId, request };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("browser live authority gateways", () => {
  it("posts the exact ledger handoff and validates its bound live request", async () => {
    const fixture = queuedFixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(fixture.request),
    );
    const authorize = createBrowserLiveAuthorizationGateway({
      authorizationEndpoint: "/authority-test",
      credentialProvider,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      authorize({
        document: fixture.document,
        runId: fixture.runId,
        requestId: fixture.requestId,
      }),
    ).resolves.toEqual(fixture.request);
    expect(fetch).toHaveBeenCalledWith("/authority-test", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPERATOR_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        document: fixture.document,
        runId: fixture.runId,
        requestId: fixture.requestId,
      }),
    });
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain(
      OPERATOR_SECRET,
    );
  });

  it("rejects a schema-valid authorization bound to another request", async () => {
    const fixture = queuedFixture();
    const fetch = vi.fn(async () =>
      jsonResponse({
        ...fixture.request,
        requestId: "request-other",
        authorization: {
          ...fixture.request.authorization,
          requestId: "request-other",
        },
      }),
    );
    const authorize = createBrowserLiveAuthorizationGateway({
      credentialProvider,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      authorize({
        document: fixture.document,
        runId: fixture.runId,
        requestId: fixture.requestId,
      }),
    ).rejects.toMatchObject({
      name: "BrowserLiveAuthorityGatewayError",
      operation: "authorize",
      outcome: "response_invalid",
      httpStatus: 200,
    });
  });

  it("does not expose an invalid server body through the bounded browser error", async () => {
    const fixture = queuedFixture();
    const sensitive = `/host/private/${"secret".repeat(500)}`;
    const authorize = createBrowserLiveAuthorizationGateway({
      credentialProvider,
      fetch: vi.fn(
        async () => new Response(sensitive, { status: 503 }),
      ) as typeof globalThis.fetch,
    });

    const error = await authorize({
      document: fixture.document,
      runId: fixture.runId,
      requestId: fixture.requestId,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserLiveAuthorityGatewayError);
    expect(error).toMatchObject({
      operation: "authorize",
      outcome: "response_invalid",
      httpStatus: 503,
    });
    expect((error as Error).message).not.toContain(sensitive.slice(0, 20));
  });

  it("returns the safe runtime preparation capability", async () => {
    const capability = {
      requestedMode: "live",
      effectiveMode: "live" as const,
      status: "available" as const,
      artifactBaseRef: `git:${"a".repeat(40)}`,
      reason: null,
    };
    const fetch = vi.fn(async () => jsonResponse(capability));
    const getCapability = createBrowserAgentRuntimeCapabilityGetter({
      capabilityEndpoint: "/capability-test",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(getCapability()).resolves.toEqual(capability);
    expect(fetch).toHaveBeenCalledWith("/capability-test", {
      method: "GET",
      headers: { accept: "application/json" },
    });
  });

  it("recovers the exact durable live response by run and request identity", async () => {
    const fixture = queuedFixture();
    const response = AgentRunFailureSchema.parse({
      ok: false,
      runtime: {
        requestedMode: "live",
        effectiveMode: "live",
        status: "failed",
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
      },
      error: {
        code: "worker_failed",
        message: "The exact live worker response is durable.",
        issues: [],
      },
      briefPreserved: true,
      resumable: false,
      resumeSupported: false,
      blockedRun: null,
    });
    const status = { status: "completed" as const, response };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(status),
    );
    const getStatus = createBrowserLiveRunStatusGetter({
      statusEndpoint: "/status-test",
      credentialProvider,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      getStatus({ runId: fixture.runId, requestId: fixture.requestId }),
    ).resolves.toEqual(status);

    expect(fetch).toHaveBeenCalledWith(
      `/status-test?runId=${fixture.runId}&requestId=${fixture.requestId}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${OPERATOR_SECRET}`,
        },
      },
    );
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain(OPERATOR_SECRET);
  });

  it("fails before transport when transient operator authority is absent", async () => {
    const fixture = queuedFixture();
    const fetch = vi.fn();
    const authorize = createBrowserLiveAuthorizationGateway({
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      authorize({
        document: fixture.document,
        runId: fixture.runId,
        requestId: fixture.requestId,
      }),
    ).rejects.toMatchObject({ name: "OperatorCredentialUnavailableError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
