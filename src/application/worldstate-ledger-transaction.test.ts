import { describe, expect, it } from "vitest";

import {
  LedgerConflictError,
  ledgerVersion,
  type ProjectLedgerStore,
} from "@/adapters/storage/contracts";
import {
  createMemoryWorldstateLedgerStore,
  worldstateLedgerDocument,
  worldstateStateFromLedgerDocument,
} from "@/adapters/storage/worldstate";
import { type LedgerEvent } from "@/domain";
import {
  createHappyPlacementFixture,
  createHomeMoveSeedFixture,
} from "@/fixtures";

import {
  createWorldstateLedgerTransactionService,
  type NonEmptyLedgerEvents,
  worldstateLedgerFromDocument,
} from "./worldstate-ledger-transaction";

const INITIAL_UPDATED_AT = "2026-07-17T08:00:00.000Z";
const TRANSACTION_UPDATED_AT = "2026-07-17T08:01:00.000Z";

function asNonEmpty(events: readonly LedgerEvent[]): NonEmptyLedgerEvents {
  const [first, ...rest] = events;
  if (!first) throw new Error("Expected a non-empty fixture event batch.");
  return [first, ...rest];
}

function seedDocument() {
  return worldstateLedgerDocument({
    ledger: createHomeMoveSeedFixture().ledger,
    projectLabel: "Plan our home move",
    updatedAt: INITIAL_UPDATED_AT,
  });
}

function placementEvents(): NonEmptyLedgerEvents {
  const seedEventCount = createHomeMoveSeedFixture().ledger.events.length;
  return asNonEmpty(
    createHappyPlacementFixture().ledger.events.slice(seedEventCount),
  );
}

function countingStore(
  seed: ReturnType<typeof seedDocument>,
): {
  readonly store: ProjectLedgerStore<LedgerEvent>;
  readonly putCount: () => number;
} {
  const memory = createMemoryWorldstateLedgerStore([seed]);
  let puts = 0;
  return {
    store: {
      ...memory,
      async put(document, expectedVersion) {
        puts += 1;
        await memory.put(document, expectedVersion);
      },
    },
    putCount: () => puts,
  };
}

describe("worldstate ledger transactions", () => {
  it("publishes a valid multi-event batch with one full-ledger CAS write", async () => {
    const initial = seedDocument();
    const { store, putCount } = countingStore(initial);
    const events = placementEvents();
    const service = createWorldstateLedgerTransactionService({
      store,
      now: () => TRANSACTION_UPDATED_AT,
    });

    const result = await service.append({
      current: { projectId: initial.projectId },
      events,
    });

    expect(putCount()).toBe(1);
    expect(result.appendedEventIds).toEqual(
      events.map((event) => event.eventId),
    );
    expect(result.replayedEventIds).toEqual([]);
    expect(result.ledger.events).toEqual(createHappyPlacementFixture().ledger.events);
    expect(result.state).toEqual(createHappyPlacementFixture().state);
    expect(result.document.updatedAt).toBe(TRANSACTION_UPDATED_AT);
    expect(result.version).toEqual(ledgerVersion(result.document));
    expect(await store.get(initial.projectId)).toEqual(result.document);
  });

  it("does not persist the valid prefix of a batch whose later event fails", async () => {
    const initial = seedDocument();
    const { store, putCount } = countingStore(initial);
    const [source, , acceptance] = placementEvents();
    if (!source || !acceptance) throw new Error("Incomplete placement fixture.");
    const service = createWorldstateLedgerTransactionService({ store });

    await expect(
      service.append({
        current: { projectId: initial.projectId },
        events: [source, acceptance],
      }),
    ).rejects.toMatchObject({ code: "reference_missing" });

    expect(putCount()).toBe(0);
    expect(await store.get(initial.projectId)).toEqual(initial);
  });

  it("preserves exact command replay without duplicating events or advancing time", async () => {
    const initial = seedDocument();
    const store = createMemoryWorldstateLedgerStore([initial]);
    const service = createWorldstateLedgerTransactionService({
      store,
      now: () => TRANSACTION_UPDATED_AT,
    });
    const replayedEvent = createHomeMoveSeedFixture().ledger.events.at(-1);
    if (!replayedEvent) throw new Error("Seed fixture has no event to replay.");

    const first = await service.append({
      current: { projectId: initial.projectId },
      events: [replayedEvent],
    });
    const second = await service.append({
      current: {
        document: first.document,
        expectedVersion: first.version,
      },
      events: [replayedEvent],
    });

    expect(first.appendedEventIds).toEqual([]);
    expect(first.replayedEventIds).toEqual([replayedEvent.eventId]);
    expect(second.replayedEventIds).toEqual([replayedEvent.eventId]);
    expect(second.document.events).toEqual(initial.events);
    expect(second.document.updatedAt).toBe(INITIAL_UPDATED_AT);
    expect(second.version).toEqual(ledgerVersion(initial));
  });

  it("surfaces a store conflict when a caller publishes a stale snapshot", async () => {
    const initial = seedDocument();
    const store = createMemoryWorldstateLedgerStore([initial]);
    const staleDocument = await store.get(initial.projectId);
    if (!staleDocument) throw new Error("Seed ledger was not persisted.");
    const staleVersion = ledgerVersion(staleDocument);
    if (!staleVersion) throw new Error("Seed ledger has no version.");
    const [source] = placementEvents();
    const replayedSeedEvent = createHomeMoveSeedFixture().ledger.events.at(-1);
    if (!source || !replayedSeedEvent) throw new Error("Incomplete fixture.");
    const service = createWorldstateLedgerTransactionService({
      store,
      now: () => TRANSACTION_UPDATED_AT,
    });

    const concurrent = await service.append({
      current: { projectId: initial.projectId },
      events: [source],
    });

    await expect(
      service.append({
        current: { document: staleDocument, expectedVersion: staleVersion },
        events: [replayedSeedEvent],
      }),
    ).rejects.toBeInstanceOf(LedgerConflictError);
    expect(await store.get(initial.projectId)).toEqual(concurrent.document);
  });

  it("rehydrates by project ID and returns the persisted reduced state", async () => {
    const initial = seedDocument();
    const store = createMemoryWorldstateLedgerStore([initial]);
    const [source, proposal] = placementEvents();
    if (!source || !proposal) throw new Error("Incomplete placement fixture.");
    if (source.type !== "source.captured" || proposal.type !== "delta.proposed") {
      throw new Error("Expected source-capture and placement-proposal events.");
    }

    await createWorldstateLedgerTransactionService({
      store,
      now: () => "2026-07-17T08:01:00.000Z",
    }).append({
      current: { projectId: initial.projectId },
      events: [source],
    });

    const rehydratedSession = createWorldstateLedgerTransactionService({
      store,
      now: () => "2026-07-17T08:02:00.000Z",
    });
    const result = await rehydratedSession.append({
      current: { projectId: initial.projectId },
      events: [proposal],
    });
    const persisted = await store.get(initial.projectId);

    expect(persisted).toEqual(result.document);
    expect(worldstateLedgerFromDocument(result.document)).toEqual(result.ledger);
    expect(worldstateStateFromLedgerDocument(persisted)).toEqual(result.state);
    expect(result.state.operational.sources[source.payload.source.id]).toEqual(
      source.payload.source,
    );
    expect(
      result.state.operational.deltas[proposal.payload.delta.id]?.disposition,
    ).toBe("pending");
    expect(result.version.eventCount).toBe(initial.events.length + 2);
  });
});
