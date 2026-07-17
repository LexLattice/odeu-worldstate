"use client";

import { type DBSchema, type IDBPDatabase, openDB } from "idb";

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

const DATABASE_NAME = "odeu-worldstate";
const DATABASE_VERSION = 1;
const DOCUMENT_STORE = "project-ledgers";

interface WorldstateDatabase extends DBSchema {
  [DOCUMENT_STORE]: {
    key: string;
    value: LedgerDocument<unknown>;
    indexes: { "by-updated-at": string };
  };
}

let databasePromise: Promise<IDBPDatabase<WorldstateDatabase>> | null = null;

function database(): Promise<IDBPDatabase<WorldstateDatabase>> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable in this runtime.");
  }

  databasePromise ??= openDB<WorldstateDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(DOCUMENT_STORE, { keyPath: "projectId" });
      store.createIndex("by-updated-at", "updatedAt");
    },
  }).catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

export function createIndexedDbLedgerStore<TEvent>(
  options: LedgerStoreOptions<TEvent>,
): ProjectLedgerStore<TEvent> {
  const parse = (document: unknown) =>
    parseLedgerDocument(document, options.eventSchema, options.validateDocument);

  return {
    async get(projectId) {
      const document = await (await database()).get(DOCUMENT_STORE, projectId);
      return document ? parse(document) : null;
    },
    async put(document, expectedVersion) {
      const parsed = parse(document);
      const transaction = (await database()).transaction(DOCUMENT_STORE, "readwrite");
      try {
        const stored = await transaction.store.get(parsed.projectId);
        const existing = stored ? parse(stored) : null;
        assertExpectedLedgerVersion(existing, parsed.projectId, expectedVersion);
        assertImmutableEventPrefix(existing, parsed);
        await transaction.store.put(parsed);
        await transaction.done;
      } catch (error) {
        try {
          transaction.abort();
          await transaction.done;
        } catch {
          // The transaction may already have aborted. Preserve the original error.
        }
        throw error;
      }
    },
    async replace(document, expectedVersion) {
      const parsed = parse(document);
      const transaction = (await database()).transaction(
        DOCUMENT_STORE,
        "readwrite",
      );
      try {
        const stored = await transaction.store.get(parsed.projectId);
        const existing = stored ? parse(stored) : null;
        assertExpectedLedgerVersion(
          existing,
          parsed.projectId,
          expectedVersion,
        );
        await transaction.store.put(parsed);
        await transaction.done;
      } catch (error) {
        try {
          transaction.abort();
          await transaction.done;
        } catch {
          // The transaction may already have aborted. Preserve the original error.
        }
        throw error;
      }
    },
    async list(): Promise<ProjectLedgerSummary[]> {
      const documents = await (await database()).getAll(DOCUMENT_STORE);
      return documents
        .map(parse)
        .map(ledgerSummary)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async delete(projectId) {
      await (await database()).delete(DOCUMENT_STORE, projectId);
    },
    async clear() {
      await (await database()).clear(DOCUMENT_STORE);
    },
  };
}
