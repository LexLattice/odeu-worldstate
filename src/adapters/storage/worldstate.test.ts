import { describe, expect, it } from "vitest";

import { LedgerCorruptionError } from "./contracts";
import {
  createMemoryWorldstateLedgerStore,
  validateWorldstateLedgerDocument,
  worldstateLedgerDocument,
} from "./worldstate";
import { createHappyPlacementFixture } from "@/fixtures";
import { createWorldstateLedger } from "@/domain";

describe("worldstate ledger persistence", () => {
  it("round-trips a reduced ledger with a matching declared head", async () => {
    const fixture = createHappyPlacementFixture();
    const document = worldstateLedgerDocument({
      ledger: fixture.ledger,
      projectLabel: "Plan our home move",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });
    const store = createMemoryWorldstateLedgerStore();
    await store.put(document, null);

    expect(await store.get(document.projectId)).toEqual(document);
  });

  it("rejects a claimed head that does not match deterministic reduction", () => {
    const fixture = createHappyPlacementFixture();
    const document = worldstateLedgerDocument({
      ledger: fixture.ledger,
      projectLabel: "Plan our home move",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });

    expect(() =>
      validateWorldstateLedgerDocument({
        ...document,
        headRevisionId: "rev-tampered",
      }),
    ).toThrow(LedgerCorruptionError);
  });

  it("rejects a schema-valid but fabricated genesis identity", () => {
    const ledger = createWorldstateLedger({
      projectId: "project-fabricated-genesis",
      createdAt: "2026-07-16T10:00:00.000Z",
    });
    const document = worldstateLedgerDocument({
      ledger,
      projectLabel: "Fabricated genesis check",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });
    const fabricatedGenesis = {
      ...ledger.genesisRevision,
      id: "rev-0000-fabricated",
    };

    expect(() =>
      validateWorldstateLedgerDocument({
        ...document,
        headRevisionId: fabricatedGenesis.id,
        metadata: { genesisRevision: fabricatedGenesis },
      }),
    ).toThrowError(/non-deterministic genesis revision/);
  });

  it("rejects fabricated genesis invariants even when the declared head agrees", () => {
    const ledger = createWorldstateLedger({
      projectId: "project-invalid-genesis-invariants",
      createdAt: "2026-07-16T10:00:00.000Z",
    });
    const document = worldstateLedgerDocument({
      ledger,
      projectLabel: "Genesis invariant check",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });
    const fabricatedGenesis = {
      ...ledger.genesisRevision,
      number: 4,
    };

    expect(() =>
      validateWorldstateLedgerDocument({
        ...document,
        metadata: { genesisRevision: fabricatedGenesis },
      }),
    ).toThrow(LedgerCorruptionError);
  });
});
