import { z } from "zod";

import { fingerprint, stableStringify } from "@/domain";

export const LEDGER_EXPORT_FORMAT = "odeu-worldstate-ledger" as const;
export const LEDGER_EXPORT_VERSION = 1 as const;

export const LedgerDocumentSchema = z.object({
  format: z.literal(LEDGER_EXPORT_FORMAT),
  formatVersion: z.literal(LEDGER_EXPORT_VERSION),
  projectId: z.string().trim().min(1).max(160),
  projectLabel: z.string().trim().min(1).max(240),
  headRevisionId: z.string().trim().min(1).max(160),
  updatedAt: z.iso.datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  events: z.array(z.unknown()),
}).strict();

export type LedgerDocument<
  TEvent = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
  z.infer<typeof LedgerDocumentSchema>,
  "events" | "metadata"
> & {
  events: TEvent[];
  metadata: TMetadata;
};

export type ProjectLedgerSummary = Pick<
  LedgerDocument,
  "projectId" | "projectLabel" | "headRevisionId" | "updatedAt"
> & {
  eventCount: number;
};

/**
 * The optimistic-concurrency token for an append-only ledger.
 *
 * A canonical revision alone is insufficient because operational events do not
 * advance that revision. The event count catches concurrent appends and the
 * fingerprint binds the token to the exact event history that was read.
 */
export interface LedgerVersion {
  readonly headRevisionId: string;
  readonly eventCount: number;
  readonly eventLogFingerprint: string;
}

export interface ProjectLedgerStore<TEvent> {
  get(projectId: string): Promise<LedgerDocument<TEvent> | null>;
  put(
    document: LedgerDocument<TEvent>,
    expectedVersion: LedgerVersion | null,
  ): Promise<void>;
  list(): Promise<ProjectLedgerSummary[]>;
  delete(projectId: string): Promise<void>;
  clear(): Promise<void>;
}

export type LedgerDocumentValidator<TEvent> = (
  document: LedgerDocument<TEvent>,
) => void;

export interface LedgerStoreOptions<TEvent> {
  eventSchema: z.ZodType<TEvent>;
  validateDocument?: LedgerDocumentValidator<TEvent>;
}

export class LedgerConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly expectedVersion: LedgerVersion | null,
    readonly actualVersion: LedgerVersion | null,
  ) {
    super(
      `Ledger ${projectId} expected version ${describeLedgerVersion(expectedVersion)}, but found ${describeLedgerVersion(actualVersion)}.`,
    );
    this.name = "LedgerConflictError";
  }

  /** @deprecated Prefer the complete expectedVersion token. */
  get expectedHeadRevisionId(): string | null {
    return this.expectedVersion?.headRevisionId ?? null;
  }

  /** @deprecated Prefer the complete actualVersion token. */
  get actualHeadRevisionId(): string | null {
    return this.actualVersion?.headRevisionId ?? null;
  }
}

export class LedgerCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCorruptionError";
  }
}

export class LedgerHistoryRewriteError extends LedgerCorruptionError {
  constructor(projectId: string, eventIndex: number) {
    super(
      `Ledger ${projectId} cannot replace or remove immutable event ${eventIndex}.`,
    );
    this.name = "LedgerHistoryRewriteError";
  }
}

function describeLedgerVersion(version: LedgerVersion | null): string {
  if (!version) return "<new>";
  return `${version.headRevisionId}/${version.eventCount}/${version.eventLogFingerprint}`;
}

export function ledgerVersion<TEvent>(
  document: LedgerDocument<TEvent> | null,
): LedgerVersion | null {
  if (!document) return null;
  return {
    headRevisionId: document.headRevisionId,
    eventCount: document.events.length,
    eventLogFingerprint: fingerprint(document.events),
  };
}

function versionsEqual(
  left: LedgerVersion | null,
  right: LedgerVersion | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.headRevisionId === right.headRevisionId &&
      left.eventCount === right.eventCount &&
      left.eventLogFingerprint === right.eventLogFingerprint)
  );
}

export function assertExpectedLedgerVersion<TEvent>(
  document: LedgerDocument<TEvent> | null,
  projectId: string,
  expectedVersion: LedgerVersion | null,
): void {
  const actualVersion = ledgerVersion(document);
  if (!versionsEqual(actualVersion, expectedVersion)) {
    throw new LedgerConflictError(
      projectId,
      expectedVersion,
      actualVersion,
    );
  }
}

export function assertImmutableEventPrefix<TEvent>(
  existing: LedgerDocument<TEvent> | null,
  replacement: LedgerDocument<TEvent>,
): void {
  if (!existing) return;

  for (let index = 0; index < existing.events.length; index += 1) {
    const priorEvent = existing.events[index];
    const replacementEvent = replacement.events[index];
    if (
      index >= replacement.events.length ||
      stableStringify(priorEvent) !== stableStringify(replacementEvent)
    ) {
      throw new LedgerHistoryRewriteError(existing.projectId, index);
    }
  }
}

export function parseLedgerDocument<TEvent>(
  input: unknown,
  eventSchema: z.ZodType<TEvent>,
  validateDocument?: LedgerDocumentValidator<TEvent>,
): LedgerDocument<TEvent> {
  const envelope = LedgerDocumentSchema.parse(input);
  const document = {
    ...envelope,
    events: envelope.events.map((event) => eventSchema.parse(event)),
  };
  validateDocument?.(document);
  return document;
}

export function serializeLedgerDocument<TEvent>(
  document: LedgerDocument<TEvent>,
  eventSchema: z.ZodType<TEvent>,
  validateDocument?: LedgerDocumentValidator<TEvent>,
): string {
  const parsed = parseLedgerDocument(document, eventSchema, validateDocument);
  return JSON.stringify(parsed, null, 2);
}

export function ledgerSummary<TEvent>(document: LedgerDocument<TEvent>): ProjectLedgerSummary {
  return {
    projectId: document.projectId,
    projectLabel: document.projectLabel,
    headRevisionId: document.headRevisionId,
    updatedAt: document.updatedAt,
    eventCount: document.events.length,
  };
}
