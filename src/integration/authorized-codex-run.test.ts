import { describe, expect, it } from "vitest";

import { authorizationMatches } from "@/adapters/codex/integrity";
import { reduceWorldstateLedger } from "@/domain";
import {
  createLiveWorkerClosureFixture,
  createReplayClosureFixture,
  createStaleClosureFixture,
} from "@/fixtures";

import { authorizedCodexRunRequest } from "./authorized-codex-run";

function queuedLiveFixture() {
  const fixture = createLiveWorkerClosureFixture();
  const authorizationIndex = fixture.ledger.events.findIndex(
    (event) => event.type === "run.authorized",
  );
  if (authorizationIndex < 0) throw new Error("Expected a live run authorization event.");
  return {
    fixture,
    state: reduceWorldstateLedger({
      ...fixture.ledger,
      events: fixture.ledger.events.slice(0, authorizationIndex + 1),
    }),
  };
}

describe("authorizedCodexRunRequest", () => {
  it("binds a short-lived request to a queued live run in the reduced ledger", () => {
    const { fixture, state } = queuedLiveFixture();
    const secret = "test-run-authorization-secret";
    const request = authorizedCodexRunRequest({
      state,
      runId: fixture.ids.run,
      requestId: "request-authorized-live",
      secret,
      now: new Date("2026-07-16T09:00:00.000Z"),
      nonce: "00000000-0000-4000-8000-000000000001",
    });

    expect(request.authorization).not.toBeNull();
    expect(request).toMatchObject({
      runId: fixture.ids.run,
      mode: "live",
      requestId: "request-authorized-live",
    });
    if (!request.authorization) throw new Error("Authorization was not compiled.");
    expect(
      authorizationMatches(
        request.authorization,
        request.authorization.capability,
        secret,
      ),
    ).toBe(true);
    expect(request.authorization).toMatchObject({
      mode: "live",
      requestId: "request-authorized-live",
      issuedAt: "2026-07-16T09:00:00.000Z",
      expiresAt: "2026-07-16T09:05:00.000Z",
    });
  });

  it("refuses replay runs and live runs that have already left queued state", () => {
    const replay = createReplayClosureFixture();
    const live = createLiveWorkerClosureFixture();

    expect(() =>
      authorizedCodexRunRequest({
        state: replay.state,
        runId: replay.ids.run,
        requestId: "request-replay-as-live",
        secret: "test-run-authorization-secret",
      }),
    ).toThrow("only a live run");
    expect(() =>
      authorizedCodexRunRequest({
        state: live.state,
        runId: live.ids.run,
        requestId: "request-returned-live",
        secret: "test-run-authorization-secret",
      }),
    ).toThrow("requires queued state");
  });

  it("refuses an authorized run after the canonical revision advances", () => {
    const fixture = createStaleClosureFixture();
    const state = reduceWorldstateLedger({
      ...fixture.ledger,
      events: fixture.ledger.events.filter(
        (event) =>
          event.type !== "run.lifecycle_recorded" &&
          event.type !== "closure.staged" &&
          event.type !== "evidence.validation_recorded",
      ),
    });

    expect(() =>
      authorizedCodexRunRequest({
        state,
        runId: fixture.ids.run,
        requestId: "request-stale-run",
        secret: "test-run-authorization-secret",
      }),
    ).toThrow("is stale");
  });
});
