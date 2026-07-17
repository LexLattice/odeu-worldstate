import {
  appendLedgerEvent,
  reduceWorldstateLedger,
  type LedgerEvent,
  type WorldstateLedger,
  type WorldstateState,
} from "@/domain";
import {
  assertExpectedLedgerVersion,
  ledgerVersion,
  type LedgerVersion,
  type ProjectLedgerStore,
} from "@/adapters/storage/contracts";
import {
  parseWorldstateLedgerDocument,
  worldstateLedgerDocument,
  worldstateStateFromLedgerDocument,
  type WorldstateLedgerDocument,
} from "@/adapters/storage/worldstate";

export type NonEmptyLedgerEvents = readonly [LedgerEvent, ...LedgerEvent[]];

export type WorldstateLedgerTransactionBase =
  | {
      readonly document: WorldstateLedgerDocument;
      readonly expectedVersion: LedgerVersion;
    }
  | { readonly projectId: string };

export interface WorldstateLedgerTransactionInput {
  readonly current: WorldstateLedgerTransactionBase;
  readonly events: NonEmptyLedgerEvents;
}

export interface WorldstateLedgerTransactionResult {
  readonly document: WorldstateLedgerDocument;
  readonly ledger: WorldstateLedger;
  readonly state: WorldstateState;
  readonly version: LedgerVersion;
  readonly appendedEventIds: readonly string[];
  readonly replayedEventIds: readonly string[];
}

export interface WorldstateLedgerTransactionService {
  append(
    input: WorldstateLedgerTransactionInput,
  ): Promise<WorldstateLedgerTransactionResult>;
}

export class WorldstateLedgerNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Worldstate ledger ${projectId} does not exist.`);
    this.name = "WorldstateLedgerNotFoundError";
  }
}

export class EmptyWorldstateLedgerTransactionError extends Error {
  constructor() {
    super("A worldstate ledger transaction requires at least one event.");
    this.name = "EmptyWorldstateLedgerTransactionError";
  }
}

interface ResolvedTransactionBase {
  readonly document: WorldstateLedgerDocument;
  readonly expectedVersion: LedgerVersion;
}

export function worldstateLedgerFromDocument(
  document: WorldstateLedgerDocument,
): WorldstateLedger {
  const parsedDocument = parseWorldstateLedgerDocument(document);
  const state = worldstateStateFromLedgerDocument(parsedDocument);
  const genesisRevisionId = state.canonical.revisionOrder[0];
  const genesisRevision = state.canonical.revisions[genesisRevisionId];

  if (!genesisRevision) {
    throw new Error(
      `Worldstate ledger ${parsedDocument.projectId} has no genesis revision.`,
    );
  }

  return {
    projectId: parsedDocument.projectId,
    genesisRevision,
    events: [...parsedDocument.events],
  };
}

async function resolveTransactionBase(
  store: ProjectLedgerStore<LedgerEvent>,
  current: WorldstateLedgerTransactionBase,
): Promise<ResolvedTransactionBase> {
  if ("document" in current) {
    const document = parseWorldstateLedgerDocument(current.document);
    assertExpectedLedgerVersion(
      document,
      document.projectId,
      current.expectedVersion,
    );
    return {
      document,
      expectedVersion: current.expectedVersion,
    };
  }

  const loaded = await store.get(current.projectId);
  if (!loaded) {
    throw new WorldstateLedgerNotFoundError(current.projectId);
  }
  const document = parseWorldstateLedgerDocument(loaded);
  const expectedVersion = ledgerVersion(document);

  if (!expectedVersion) {
    throw new WorldstateLedgerNotFoundError(current.projectId);
  }

  return { document, expectedVersion };
}

/**
 * Append a batch locally, validate its final reduction, then publish it with one
 * full-ledger compare-and-swap. Kernel failures therefore cannot persist a
 * partial batch, while storage conflicts remain visible to the caller.
 */
export async function appendWorldstateLedgerEvents(input: {
  readonly store: ProjectLedgerStore<LedgerEvent>;
  readonly current: WorldstateLedgerTransactionBase;
  readonly events: NonEmptyLedgerEvents;
  readonly now?: () => string;
}): Promise<WorldstateLedgerTransactionResult> {
  if (input.events.length === 0) {
    throw new EmptyWorldstateLedgerTransactionError();
  }

  const { document: currentDocument, expectedVersion } =
    await resolveTransactionBase(input.store, input.current);
  let ledger = worldstateLedgerFromDocument(currentDocument);
  const appendedEventIds: string[] = [];
  const replayedEventIds: string[] = [];

  for (const event of input.events) {
    const result = appendLedgerEvent(ledger, event);
    ledger = result.ledger;
    (result.replayed ? replayedEventIds : appendedEventIds).push(
      ...result.emittedEventIds,
    );
  }

  const state = reduceWorldstateLedger(ledger);
  const document = worldstateLedgerDocument({
    ledger,
    projectLabel: currentDocument.projectLabel,
    updatedAt:
      appendedEventIds.length === 0
        ? currentDocument.updatedAt
        : (input.now ?? (() => new Date().toISOString()))(),
  });
  const version = ledgerVersion(document);

  if (!version) {
    throw new Error(
      `Worldstate ledger ${document.projectId} did not produce a persistence version.`,
    );
  }

  await input.store.put(document, expectedVersion);

  return {
    document,
    ledger,
    state,
    version,
    appendedEventIds,
    replayedEventIds,
  };
}

export function createWorldstateLedgerTransactionService(input: {
  readonly store: ProjectLedgerStore<LedgerEvent>;
  readonly now?: () => string;
}): WorldstateLedgerTransactionService {
  return {
    append(transaction) {
      return appendWorldstateLedgerEvents({
        store: input.store,
        now: input.now,
        ...transaction,
      });
    },
  };
}
