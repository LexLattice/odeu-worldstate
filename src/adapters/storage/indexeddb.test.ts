import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openDatabase } = vi.hoisted(() => ({
  openDatabase: vi.fn(),
}));

vi.mock("idb", () => ({ openDB: openDatabase }));

afterEach(() => {
  openDatabase.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("IndexedDB ledger store", () => {
  it("retries database initialization after a transient open failure", async () => {
    vi.stubGlobal("indexedDB", {});
    const transientFailure = new Error("IndexedDB was temporarily blocked.");
    const database = { get: vi.fn().mockResolvedValue(undefined) };
    openDatabase
      .mockRejectedValueOnce(transientFailure)
      .mockResolvedValueOnce(database);

    const { createIndexedDbLedgerStore } = await import("./indexeddb");
    const store = createIndexedDbLedgerStore({ eventSchema: z.string() });

    await expect(store.get("project-retry")).rejects.toBe(transientFailure);
    await expect(store.get("project-retry")).resolves.toBeNull();
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(database.get).toHaveBeenCalledWith(
      "project-ledgers",
      "project-retry",
    );
  });
});
