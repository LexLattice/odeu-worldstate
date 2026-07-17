import { describe, expect, it } from "vitest";

import { worldstateLedgerDocument } from "@/adapters/storage";
import { reduceWorldstateLedger } from "@/domain";
import { createLiveWorkerClosureFixture } from "@/fixtures";
import { authorizedCodexRunRequest } from "@/integration/authorized-codex-run";

import { assertCurrentRunIsQueued, LiveRunStateError } from "./run-state";

function queuedLiveRun() {
  const fixture = createLiveWorkerClosureFixture();
  const authorizationIndex = fixture.ledger.events.findIndex(
    (event) => event.type === "run.authorized",
  );
  if (authorizationIndex < 0) throw new Error("Expected run.authorized in fixture.");
  const ledger = {
    ...fixture.ledger,
    events: fixture.ledger.events.slice(0, authorizationIndex + 1),
  };
  const state = reduceWorldstateLedger(ledger);
  const request = authorizedCodexRunRequest({
    state,
    runId: fixture.ids.run,
    requestId: "request-current-live-run",
    secret: "test-run-authorization-secret",
    now: new Date("2026-07-16T09:00:00.000Z"),
    nonce: "00000000-0000-4000-8000-000000000001",
  });
  return { fixture, ledger, request };
}

describe("live execution ledger recheck", () => {
  it("accepts the exact current queued live run", () => {
    const { ledger, request } = queuedLiveRun();
    const document = worldstateLedgerDocument({
      ledger,
      projectLabel: "Home move",
      updatedAt: "2026-07-16T09:02:01.000Z",
    });

    expect(() => assertCurrentRunIsQueued(document, request)).not.toThrow();
  });

  it("rejects a previously minted token after current run state advances", () => {
    const { fixture, request } = queuedLiveRun();
    const returnedDocument = worldstateLedgerDocument({
      ledger: fixture.ledger,
      projectLabel: "Home move",
      updatedAt: "2026-07-16T09:02:06.000Z",
    });

    expect(() => assertCurrentRunIsQueued(returnedDocument, request)).toThrow(
      LiveRunStateError,
    );
  });
});
