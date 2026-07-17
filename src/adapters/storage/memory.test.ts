import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  LEDGER_EXPORT_FORMAT,
  LEDGER_EXPORT_VERSION,
  parseLedgerDocument,
  serializeLedgerDocument,
  LedgerConflictError,
  LedgerHistoryRewriteError,
  ledgerVersion,
  type LedgerDocument,
} from "./contracts";
import { createMemoryLedgerStore } from "./memory";

const EventSchema = z.object({ id: z.string(), type: z.string() });
type TestEvent = z.infer<typeof EventSchema>;

const document: LedgerDocument<TestEvent> = {
  format: LEDGER_EXPORT_FORMAT,
  formatVersion: LEDGER_EXPORT_VERSION,
  projectId: "project-home-move",
  projectLabel: "Plan our home move",
  headRevisionId: "revision-001",
  updatedAt: "2026-07-16T10:00:00.000Z",
  metadata: {},
  events: [{ id: "event-001", type: "source.captured" }],
};

describe("project ledger storage", () => {
  it("keeps projects isolated and returns defensive copies", async () => {
    const store = createMemoryLedgerStore<TestEvent>({ eventSchema: EventSchema });
    await store.put(document, null);

    const loaded = await store.get(document.projectId);
    loaded?.events.push({ id: "local-only", type: "test" });

    expect((await store.get(document.projectId))?.events).toHaveLength(1);
    expect(await store.get("another-project")).toBeNull();
  });

  it("exports and validates a portable ledger envelope", () => {
    const serialized = serializeLedgerDocument(document, EventSchema);
    const parsed = parseLedgerDocument(JSON.parse(serialized), EventSchema);

    expect(parsed).toEqual(document);
  });

  it("supports explicit deletion", async () => {
    const store = createMemoryLedgerStore({ eventSchema: EventSchema }, [document]);
    expect(await store.list()).toEqual([
      expect.objectContaining({ projectId: document.projectId, eventCount: 1 }),
    ]);

    await store.delete(document.projectId);
    expect(await store.list()).toEqual([]);
  });

  it("uses the complete ledger version instead of canonical-head last-write-wins", async () => {
    const store = createMemoryLedgerStore({ eventSchema: EventSchema });
    await store.put(document, null);
    const next = {
      ...document,
      headRevisionId: "revision-002",
      events: [...document.events, { id: "event-002", type: "delta.accepted" }],
    };
    await store.put(next, ledgerVersion(document));

    await expect(store.put(document, ledgerVersion(document))).rejects.toBeInstanceOf(
      LedgerConflictError,
    );
    expect((await store.get(document.projectId))?.headRevisionId).toBe("revision-002");
  });

  it("detects concurrent operational appends that leave the canonical head unchanged", async () => {
    const store = createMemoryLedgerStore({ eventSchema: EventSchema });
    await store.put(document, null);
    const versionReadByBothWriters = ledgerVersion(document);
    const firstAppend = {
      ...document,
      events: [...document.events, { id: "event-002-a", type: "source.captured" }],
    };
    const secondAppend = {
      ...document,
      events: [...document.events, { id: "event-002-b", type: "manager.failed" }],
    };

    await store.put(firstAppend, versionReadByBothWriters);

    await expect(
      store.put(secondAppend, versionReadByBothWriters),
    ).rejects.toMatchObject({
      name: "LedgerConflictError",
      actualVersion: expect.objectContaining({
        headRevisionId: document.headRevisionId,
        eventCount: 2,
      }),
    });
    expect((await store.get(document.projectId))?.events).toEqual(firstAppend.events);
  });

  it("requires every replacement to preserve the exact existing event prefix", async () => {
    const store = createMemoryLedgerStore({ eventSchema: EventSchema });
    await store.put(document, null);
    const currentVersion = ledgerVersion(document);
    const rewrite = {
      ...document,
      events: [{ id: "event-rewritten", type: "source.captured" }],
    };

    await expect(store.put(rewrite, currentVersion)).rejects.toBeInstanceOf(
      LedgerHistoryRewriteError,
    );
    await expect(
      store.put({ ...document, events: [] }, currentVersion),
    ).rejects.toBeInstanceOf(LedgerHistoryRewriteError);
    expect(await store.get(document.projectId)).toEqual(document);
  });

  it("validates event payloads on write", async () => {
    const store = createMemoryLedgerStore({ eventSchema: EventSchema });
    const invalid = { ...document, events: [{ id: "event-without-type" }] };

    await expect(store.put(invalid as LedgerDocument<TestEvent>, null)).rejects.toThrow();
  });
});
