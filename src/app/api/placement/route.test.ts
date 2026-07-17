import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});
describe("POST /api/placement", () => {
  it("returns a self-contained JSON error for malformed input", async () => {
    vi.stubEnv("ODEU_MANAGER_MODE", "fixture");
    const response = await POST(
      new Request("http://localhost/api/placement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      manager: {
        requestedMode: "fixture",
        effectiveMode: null,
        status: "unavailable",
      },
      sourcePreserved: true,
      error: { code: "invalid_json", retryable: false },
    });
  });
});
