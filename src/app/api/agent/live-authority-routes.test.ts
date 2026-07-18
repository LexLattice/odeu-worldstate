import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authority = vi.hoisted(() => ({
  authorize: vi.fn(),
  capability: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/adapters/codex/live-authority-server", () => {
  class LiveAuthorityServerError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "LiveAuthorityServerError";
    }
  }
  return {
    authorizeAndPublishLiveRun: authority.authorize,
    getAgentRuntimeCapability: authority.capability,
    getLiveRunStatus: authority.status,
    LiveAuthorityServerError,
  };
});

import { LiveAuthorityServerError } from "@/adapters/codex/live-authority-server";

import { POST as authorizePost } from "./authorize/route";
import { GET as capabilityGet } from "./capability/route";
import { GET as statusGet } from "./status/route";

const OPERATOR_SECRET = "operator-live-route-secret-that-is-long-enough";
const PRIVILEGED_HEADERS = {
  authorization: `Bearer ${OPERATOR_SECRET}`,
  origin: "http://localhost",
  "sec-fetch-site": "same-origin",
} as const;

function authorizeRequest(body: string, headers: HeadersInit = {}): Request {
  return new Request("http://localhost/api/agent/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...PRIVILEGED_HEADERS,
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  authority.authorize.mockReset();
  authority.capability.mockReset();
  authority.status.mockReset();
  vi.stubEnv("ODEU_OPERATOR_ALLOWED_ORIGIN", "http://localhost");
  vi.stubEnv("ODEU_OPERATOR_BEARER_SECRET", OPERATOR_SECRET);
});

afterEach(() => vi.unstubAllEnvs());

describe("live authority HTTP routes", () => {
  it("returns the exact authorized request compiled by the server service", async () => {
    const authorized = {
      runId: "run-live-route",
      requestId: "request-live-route",
      mode: "live",
    };
    authority.authorize.mockResolvedValueOnce(authorized);
    const input = {
      document: { exact: "ledger snapshot" },
      runId: "run-live-route",
      requestId: "request-live-route",
    };

    const response = await authorizePost(
      authorizeRequest(JSON.stringify(input)),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(authorized);
    expect(authority.authorize).toHaveBeenCalledWith(input);
  });

  it("bounds the request before parsing or invoking authority", async () => {
    const response = await authorizePost(
      authorizeRequest("{}", { "content-length": String(3 * 1024 * 1024) }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
    expect(authority.authorize).not.toHaveBeenCalled();
  });

  it("does not expose private host detail from a failed server check", async () => {
    authority.authorize.mockRejectedValueOnce(
      new LiveAuthorityServerError(
        "workspace_not_ready",
        "private path /srv/secret/worktree was dirty",
      ),
    );

    const response = await authorizePost(authorizeRequest("{}"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "workspace_not_ready",
        message: "The live execution workspace is not prepared.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("/srv/secret/worktree");
  });

  it("exposes only the bounded capability and status envelopes with no-store caching", async () => {
    const capability = {
      requestedMode: "live",
      effectiveMode: "live",
      status: "available",
      artifactBaseRef: `git:${"a".repeat(40)}`,
      reason: null,
    };
    const status = { status: "not_started", response: null };
    authority.capability.mockResolvedValueOnce(capability);
    authority.status.mockResolvedValueOnce(status);

    const capabilityResponse = await capabilityGet();
    const statusResponse = await statusGet(
      new Request(
        "http://localhost/api/agent/status?runId=run-live-route&requestId=request-live-route",
        {
          headers: {
            authorization: `Bearer ${OPERATOR_SECRET}`,
            "sec-fetch-site": "same-origin",
          },
        },
      ),
    );

    expect(capabilityResponse.headers.get("cache-control")).toBe("no-store");
    await expect(capabilityResponse.json()).resolves.toEqual(capability);
    expect(statusResponse.headers.get("cache-control")).toBe("no-store");
    await expect(statusResponse.json()).resolves.toEqual(status);
    expect(authority.status).toHaveBeenCalledWith({
      runId: "run-live-route",
      requestId: "request-live-route",
    });
  });

  it("rejects missing operator authority and cross-origin requests before private work", async () => {
    const missingBearer = await authorizePost(
      new Request("http://localhost/api/agent/authorize", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: "{not-json",
      }),
    );
    const crossOriginStatus = await statusGet(
      new Request(
        "http://localhost/api/agent/status?runId=run-live-route&requestId=request-live-route",
        {
          headers: {
            authorization: `Bearer ${OPERATOR_SECRET}`,
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
          },
        },
      ),
    );

    expect(missingBearer.status).toBe(401);
    await expect(missingBearer.json()).resolves.toMatchObject({
      error: { code: "operator_unauthorized" },
    });
    expect(crossOriginStatus.status).toBe(403);
    await expect(crossOriginStatus.json()).resolves.toMatchObject({
      error: { code: "operator_cross_origin" },
    });
    expect(authority.authorize).not.toHaveBeenCalled();
    expect(authority.status).not.toHaveBeenCalled();
  });
});
