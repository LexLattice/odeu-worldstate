"use client";

import { createIndexedDbLedgerStore } from "./indexeddb";
import { worldstateLedgerStoreOptions } from "./worldstate";

export function createBrowserWorldstateLedgerStore() {
  return createIndexedDbLedgerStore(worldstateLedgerStoreOptions);
}
