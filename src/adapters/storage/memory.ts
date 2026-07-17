import {
  assertExpectedLedgerVersion,
  assertImmutableEventPrefix,
  ledgerSummary,
  parseLedgerDocument,
  type LedgerDocument,
  type LedgerStoreOptions,
  type ProjectLedgerStore,
  type ProjectLedgerSummary,
} from "./contracts";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryLedgerStore<TEvent>(
  options: LedgerStoreOptions<TEvent>,
  seed: LedgerDocument<TEvent>[] = [],
): ProjectLedgerStore<TEvent> {
  const parse = (document: unknown) =>
    parseLedgerDocument(document, options.eventSchema, options.validateDocument);
  const documents = new Map(
    seed.map((document) => {
      const parsed = parse(document);
      return [parsed.projectId, copy(parsed)] as const;
    }),
  );

  return {
    async get(projectId) {
      const document = documents.get(projectId);
      return document ? copy(parse(document)) : null;
    },
    async put(document, expectedVersion) {
      const parsed = parse(document);
      const existing = documents.get(parsed.projectId) ?? null;
      assertExpectedLedgerVersion(
        existing,
        parsed.projectId,
        expectedVersion,
      );
      assertImmutableEventPrefix(existing, parsed);
      documents.set(parsed.projectId, copy(parsed));
    },
    async list(): Promise<ProjectLedgerSummary[]> {
      return [...documents.values()]
        .map(ledgerSummary)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async delete(projectId) {
      documents.delete(projectId);
    },
    async clear() {
      documents.clear();
    },
  };
}
