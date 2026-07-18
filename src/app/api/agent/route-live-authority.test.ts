import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dispatch = vi.hoisted(() => vi.fn());
const worker = vi.hoisted(() => vi.fn());
vi.mock("@/adapters/codex", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/adapters/codex")>();
  return { ...original, runCodexAdapter: worker };
});
vi.mock("@/adapters/codex/live-authority-server", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/adapters/codex/live-authority-server")
  >();
  return { ...original, dispatchAuthorizedLiveRequest: dispatch };
});

import { reduceWorldstateLedger } from "@/domain";
import { createLiveWorkerClosureFixture } from "@/fixtures";
import { authorizedCodexRunRequest } from "@/integration/authorized-codex-run";

import { AgentRunFailureSchema } from "@/adapters/codex/schema";

import { POST } from "./route";

beforeEach(() => {
  dispatch.mockReset();
  worker.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function authorizedRequest() {
  const fixture = createLiveWorkerClosureFixture();
  const authorizationIndex = fixture.ledger.events.findIndex(
    (event) => event.type === "run.authorized",
  );
  if (authorizationIndex < 0) throw new Error("Expected an authorized live run fixture.");
  return authorizedCodexRunRequest({
    state: reduceWorldstateLedger({
      ...fixture.ledger,
      events: fixture.ledger.events.slice(0, authorizationIndex + 1),
    }),
    runId: fixture.ids.run,
    requestId: "request-route-live-authority",
    secret: "route-live-secret",
    now: new Date("2026-07-18T12:01:00.000Z"),
    nonce: "00000000-0000-4000-8000-000000000097",
  });
}

describe("POST /api/agent live private dispatch", () => {
  it("routes a live request through the exact-response persistence boundary", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "live");
    const request = authorizedRequest();
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
        message: "The typed live failure was persisted.",
        issues: [],
      },
      briefPreserved: true,
      resumable: false,
      resumeSupported: false,
      blockedRun: null,
    });
    dispatch.mockResolvedValueOnce(response);

    const httpResponse = await POST(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );

    expect(httpResponse.status).toBe(500);
    await expect(httpResponse.json()).resolves.toEqual(response);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual(request);
    expect(dispatch.mock.calls[0]?.[1]).toEqual(expect.any(Function));
  });

  it("persists a stable public failure without raw worker or Git diagnostics", async () => {
    vi.stubEnv("ODEU_CODEX_MODE", "live");
    const request = authorizedRequest();
    dispatch.mockImplementationOnce(
      async (_request: unknown, execute: () => Promise<unknown>) => execute(),
    );
    worker.mockRejectedValueOnce(
      new Error(
        "fatal: cannot open /srv/private/customer/repository/.git/index.lock",
      ),
    );

    const httpResponse = await POST(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    const body = await httpResponse.json();

    expect(httpResponse.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: "worker_failed",
        message: "The agent worker failed.",
        issues: [],
      },
    });
    expect(JSON.stringify(body)).not.toContain("/srv/private");
    expect(JSON.stringify(body)).not.toContain("index.lock");
  });
});
