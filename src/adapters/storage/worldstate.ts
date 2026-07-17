import { z } from "zod";

import {
  createWorldstateLedger,
  LedgerEventSchema,
  RevisionRecordSchema,
  reduceWorldstateLedger,
  stableStringify,
  type LedgerEvent,
  type WorldstateLedger,
} from "@/domain";

import {
  LEDGER_EXPORT_FORMAT,
  LEDGER_EXPORT_VERSION,
  LedgerCorruptionError,
  parseLedgerDocument,
  type LedgerDocument,
  type LedgerStoreOptions,
} from "./contracts";
import { createMemoryLedgerStore } from "./memory";

const WorldstateMetadataSchema = z.object({
  genesisRevision: RevisionRecordSchema,
}).strict();

export type WorldstateLedgerDocument = LedgerDocument<LedgerEvent>;

export function parseWorldstateLedgerDocument(
  input: unknown,
): WorldstateLedgerDocument {
  return parseLedgerDocument(
    input,
    LedgerEventSchema,
    validateWorldstateLedgerDocument,
  );
}

export function worldstateStateFromLedgerDocument(input: unknown) {
  const document = parseWorldstateLedgerDocument(input);
  const metadata = WorldstateMetadataSchema.parse(document.metadata);
  return reduceWorldstateLedger({
    projectId: document.projectId,
    genesisRevision: metadata.genesisRevision,
    events: document.events,
  });
}

export function validateWorldstateLedgerDocument(
  document: WorldstateLedgerDocument,
): void {
  try {
    const metadata = WorldstateMetadataSchema.parse(document.metadata);
    const expectedGenesis = createWorldstateLedger({
      projectId: document.projectId,
      createdAt: metadata.genesisRevision.committedAt,
    }).genesisRevision;
    if (
      stableStringify(metadata.genesisRevision) !==
      stableStringify(expectedGenesis)
    ) {
      throw new LedgerCorruptionError(
        `Ledger ${document.projectId} has a non-deterministic genesis revision.`,
      );
    }
    const state = reduceWorldstateLedger({
      projectId: document.projectId,
      genesisRevision: metadata.genesisRevision,
      events: document.events,
    });
    if (state.canonical.head.id !== document.headRevisionId) {
      throw new LedgerCorruptionError(
        `Ledger ${document.projectId} claims head ${document.headRevisionId}, but reduction produced ${state.canonical.head.id}.`,
      );
    }
  } catch (error) {
    if (error instanceof LedgerCorruptionError) throw error;
    throw new LedgerCorruptionError(
      `Ledger ${document.projectId} failed deterministic validation: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export const worldstateLedgerStoreOptions: LedgerStoreOptions<LedgerEvent> = {
  eventSchema: LedgerEventSchema,
  validateDocument: validateWorldstateLedgerDocument,
};

export function worldstateLedgerDocument(input: {
  ledger: WorldstateLedger;
  projectLabel: string;
  updatedAt: string;
}): WorldstateLedgerDocument {
  const state = reduceWorldstateLedger(input.ledger);
  const document: WorldstateLedgerDocument = {
    format: LEDGER_EXPORT_FORMAT,
    formatVersion: LEDGER_EXPORT_VERSION,
    projectId: input.ledger.projectId,
    projectLabel: input.projectLabel,
    headRevisionId: state.canonical.head.id,
    updatedAt: input.updatedAt,
    metadata: { genesisRevision: input.ledger.genesisRevision },
    events: [...input.ledger.events],
  };
  validateWorldstateLedgerDocument(document);
  return document;
}

export function createMemoryWorldstateLedgerStore(
  seed: WorldstateLedgerDocument[] = [],
) {
  return createMemoryLedgerStore(worldstateLedgerStoreOptions, seed);
}
