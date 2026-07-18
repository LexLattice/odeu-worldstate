import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { MAX_AGENT_REQUEST_BYTES, POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

function replayRequest() {
  const fixture = createPrivateProjectionFixture();
  return domainBriefToCodexRunRequest(
    fixture.brief,
    "run-route-replay",
    "replay",
    "request-route-replay",
  );
}

function post(body: BodyInit, headers: HeadersInit = {}): Promise<Response> {
  return POST(
    new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

describe("POST /api/agent", () => {
  it("returns a self-contained JSON error for malformed JSON", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "replay");
    const response = await post("{not-json");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      runtime: { requestedMode: "replay", effectiveMode: "replay" },
      error: { code: "invalid_request", issues: [] },
    });
  });

  it("rejects declared and streamed bodies above the byte limit before schema parsing", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "replay");
    const declared = await post("{}", {
      "content-length": String(MAX_AGENT_REQUEST_BYTES + 1),
    });
    const streamed = await post("x".repeat(MAX_AGENT_REQUEST_BYTES + 1));

    expect(declared.status).toBe(413);
    expect(streamed.status).toBe(413);
    await expect(declared.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        message: expect.stringContaining("2 MiB"),
        issues: [],
      },
    });
    await expect(streamed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request", issues: [] },
    });
  });

  it("rejects non-UTF-8 request bytes without exposing decoder details", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "replay");
    const response = await post(new Uint8Array([0xff]));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        message: "The agent request body must be valid UTF-8 JSON.",
        issues: [],
      },
    });
  });

  it("returns the requested replay run identity", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "replay");
    const response = await post(JSON.stringify(replayRequest()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      runtime: { requestedMode: "replay", effectiveMode: "replay" },
      closure: { runId: "run-route-replay" },
    });
  });

  it("rejects missing run identity and reports string issues", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "replay");
    const withoutRunId: Record<string, unknown> = { ...replayRequest() };
    delete withoutRunId.runId;
    const response = await post(JSON.stringify(withoutRunId));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(body.error.issues).toEqual([
      expect.stringContaining("runId"),
    ]);
  });

  it("rejects an environment/request mode mismatch before execution", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "live");
    const response = await post(JSON.stringify(replayRequest()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      runtime: {
        requestedMode: "live",
        effectiveMode: null,
        status: "unavailable",
      },
      error: { code: "mode_mismatch" },
    });
  });
});
