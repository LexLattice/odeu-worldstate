import { describe, expect, it, vi } from "vitest";

import { fingerprint } from "@/domain/determinism";
import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import {
  BROWSER_AGENT_BODY_EXCERPT_MAX_LENGTH,
  BROWSER_AGENT_CONTENT_TYPE_MAX_LENGTH,
  BrowserAgentGatewayError,
  createBrowserAgentGateway,
} from "./browser";
import { runCodexReplay } from "./replay";

function replayRequest() {
  const fixture = createPrivateProjectionFixture();
  return domainBriefToCodexRunRequest(
    fixture.brief,
    fixture.ids.run,
    "replay",
    "request-browser-replay",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createBrowserAgentGateway", () => {
  it("posts the bounded request and validates its returned witness", async () => {
    const request = replayRequest();
    const response = runCodexReplay(request);
    const fetch = vi.fn(async () => jsonResponse(response));
    const gateway = createBrowserAgentGateway({
      endpoint: "/agent-test",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(gateway(request)).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith("/agent-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  });

  it("retains a validated non-success HTTP body", async () => {
    const request = replayRequest();
    const failure = {
      ok: false as const,
      runtime: {
        requestedMode: "replay",
        effectiveMode: null,
        status: "unavailable" as const,
        provider: "codex" as const,
        replayIdentity: null,
        replayKind: null,
      },
      error: {
        code: "replay_not_applicable" as const,
        message: "No fixture matches this brief.",
        issues: [],
      },
      briefPreserved: true as const,
      resumable: false,
      resumeSupported: false as const,
      blockedRun: null,
    };
    const gateway = createBrowserAgentGateway({
      fetch: vi.fn(async () => jsonResponse(failure, 409)) as typeof globalThis.fetch,
    });

    await expect(gateway(request)).resolves.toEqual(failure);
  });

  it("preserves a schema-valid cross-run response for ledger-level coherence checks", async () => {
    const request = replayRequest();
    const crossRunGateway = createBrowserAgentGateway({
      fetch: vi.fn(async () =>
        jsonResponse({
          ...runCodexReplay(request),
          closure: { ...runCodexReplay(request).closure, runId: "run-other" },
        }),
      ) as typeof globalThis.fetch,
    });

    await expect(crossRunGateway(request)).resolves.toMatchObject({
      ok: true,
      closure: { runId: "run-other" },
    });
  });

  it("classifies a rejected fetch as a bounded transport failure", async () => {
    const request = replayRequest();
    const gateway = createBrowserAgentGateway({
      fetch: vi.fn(async () => {
        throw new Error("sensitive transport detail".repeat(500));
      }) as typeof globalThis.fetch,
    });

    const error = await gateway(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserAgentGatewayError);
    expect(error).toMatchObject({
      requestId: request.requestId,
      runId: request.runId,
      outcome: "transport_failed",
      httpStatus: null,
      contentType: null,
      bodyExcerpt: null,
      bodyTruncated: false,
      bodyDigest: null,
    });
    expect((error as Error).message.length).toBeLessThan(200);
    expect((error as Error).message).not.toContain("sensitive transport detail");
  });

  it("retains known HTTP metadata when response text cannot be read", async () => {
    const request = replayRequest();
    const unreadable = {
      status: 502,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
      text: vi.fn(async () => {
        throw new Error("stream interrupted");
      }),
    } as unknown as Response;
    const gateway = createBrowserAgentGateway({
      fetch: vi.fn(async () => unreadable) as typeof globalThis.fetch,
    });

    const error = await gateway(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserAgentGatewayError);
    expect(error).toMatchObject({
      requestId: request.requestId,
      runId: request.runId,
      outcome: "transport_failed",
      httpStatus: 502,
      contentType: "text/plain; charset=utf-8",
      bodyExcerpt: null,
      bodyTruncated: false,
      bodyDigest: null,
    });
  });

  it("bounds observed content-type metadata before exposing an error", async () => {
    const request = replayRequest();
    const longContentType = `text/plain;${"x".repeat(
      BROWSER_AGENT_CONTENT_TYPE_MAX_LENGTH + 100,
    )}`;
    const unreadable = {
      status: 502,
      headers: new Headers({ "content-type": longContentType }),
      text: vi.fn(async () => {
        throw new Error("stream interrupted");
      }),
    } as unknown as Response;
    const gateway = createBrowserAgentGateway({
      fetch: vi.fn(async () => unreadable) as typeof globalThis.fetch,
    });

    const error = await gateway(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserAgentGatewayError);
    expect((error as BrowserAgentGatewayError).contentType).toBe(
      longContentType.slice(0, BROWSER_AGENT_CONTENT_TYPE_MAX_LENGTH),
    );
  });

  it("preserves a bounded excerpt and full digest for invalid JSON", async () => {
    const request = replayRequest();
    const rawBody = `{"partial":"${"x".repeat(
      BROWSER_AGENT_BODY_EXCERPT_MAX_LENGTH + 200,
    )}`;
    const gateway = createBrowserAgentGateway({
      fetch: vi.fn(async () =>
        new Response(rawBody, {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      ) as typeof globalThis.fetch,
    });

    const error = await gateway(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserAgentGatewayError);
    expect(error).toMatchObject({
      requestId: request.requestId,
      runId: request.runId,
      outcome: "response_invalid",
      httpStatus: 503,
      contentType: "text/html",
      bodyExcerpt: rawBody.slice(0, BROWSER_AGENT_BODY_EXCERPT_MAX_LENGTH),
      bodyTruncated: true,
      bodyDigest: fingerprint(rawBody),
    });
    expect((error as BrowserAgentGatewayError).bodyExcerpt).toHaveLength(
      BROWSER_AGENT_BODY_EXCERPT_MAX_LENGTH,
    );
    expect((error as Error).message).not.toContain(rawBody.slice(0, 100));
  });

  it("preserves the complete raw body observation for schema-invalid JSON", async () => {
    const request = replayRequest();
    const rawBody = JSON.stringify({ ok: true });
    const gateway = createBrowserAgentGateway({
      fetch: vi.fn(async () =>
        new Response(rawBody, {
          status: 422,
          headers: { "content-type": "application/problem+json" },
        }),
      ) as typeof globalThis.fetch,
    });

    const error = await gateway(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserAgentGatewayError);
    expect(error).toMatchObject({
      requestId: request.requestId,
      runId: request.runId,
      outcome: "response_invalid",
      httpStatus: 422,
      contentType: "application/problem+json",
      bodyExcerpt: rawBody,
      bodyTruncated: false,
      bodyDigest: fingerprint(rawBody),
    });
    expect((error as Error).message).not.toContain("Zod");
  });
});
