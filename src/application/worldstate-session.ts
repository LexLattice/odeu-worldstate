import { z } from "zod";

import {
  LedgerConflictError,
  LedgerCorruptionError,
  ledgerVersion,
  parseWorldstateLedgerDocument,
  worldstateLedgerDocument,
  type LedgerVersion,
  type ProjectLedgerStore,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";
import {
  PlacementResponseSchema,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  appendLedgerEvent,
  buildDeltaAcceptedEvent,
  createLedgerEvent,
  deltaProposedEvent,
  reduceWorldstateLedger,
  sourceCapturedEvent,
  type LedgerEvent,
  type WorldstateLedger,
  type WorldstateState,
} from "@/domain";
import {
  createHomeMoveSeedFixture,
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
} from "@/fixtures";
import {
  assertPlacementResponseMatchesRequest,
  parsePlacementAttemptSource,
  parsePlacementExchangeSource,
  PlacementResponseCoherenceError,
  placementAttemptSourceEvent,
  placementExchangeSourceEvent,
  placementExchangeSourceId,
} from "@/integration/placement-evidence";
import { placementResponseToKernelDelta } from "@/integration/placement-to-kernel";
import { compilePlacementRequest } from "@/integration/worldstate-to-placement";

import {
  createWorldstateLedgerTransactionService,
  worldstateLedgerFromDocument,
  type NonEmptyLedgerEvents,
  type WorldstateLedgerTransactionResult,
  type WorldstateLedgerTransactionService,
} from "./worldstate-ledger-transaction";

export type WorldstateSessionPersistenceState =
  | "loading"
  | "saved"
  | "saving"
  | "conflict"
  | "corrupt"
  | "unavailable";

export type WorldstateSessionOperationState =
  | "idle"
  | "initializing"
  | "capturing"
  | "placing"
  | "persisting_placement"
  | "accepting"
  | "resetting";

export type WorldstateSessionIdKind =
  | "source"
  | "request"
  | "event"
  | "command";

export type WorldstateSessionErrorScope =
  | "placement"
  | "semantic_commit"
  | "persistence"
  | "reset";

export interface WorldstateSessionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly scope: WorldstateSessionErrorScope;
}

export interface WorldstateSessionRetry {
  readonly operation: "placement";
  readonly sourceId: string;
  readonly selectedNodeId: string;
}

export interface WorldstateSessionSnapshot {
  readonly document: WorldstateLedgerDocument | null;
  readonly ledger: WorldstateLedger | null;
  readonly state: WorldstateState | null;
  readonly version: LedgerVersion | null;
  readonly persistenceState: WorldstateSessionPersistenceState;
  readonly persistenceDetail: string | null;
  readonly operationState: WorldstateSessionOperationState;
  readonly activeSourceId: string | null;
  readonly activeRequestId: string | null;
  readonly activeDeltaId: string | null;
  readonly error: WorldstateSessionError | null;
  readonly retry: WorldstateSessionRetry | null;
}

export interface WorldstateSessionDependencies {
  readonly store: ProjectLedgerStore<LedgerEvent>;
  readonly placementGateway: (
    request: PlacementRequest,
  ) => Promise<PlacementResponse>;
  readonly now: () => string;
  readonly nextId: (kind: WorldstateSessionIdKind) => string;
}

export interface WorldstateSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorldstateSessionSnapshot;
  initialize(): Promise<void>;
  captureAndPlace(text: string, selectedNodeId?: string): Promise<void>;
  retryPlacement(): Promise<void>;
  acceptActivePlacement(): Promise<void>;
  resetSandbox(): Promise<void>;
}

export class WorldstateSessionBusyError extends Error {
  constructor(readonly operationState: WorldstateSessionOperationState) {
    super(`Worldstate session is busy with ${operationState}.`);
    this.name = "WorldstateSessionBusyError";
  }
}

export class WorldstateSessionNotReadyError extends Error {
  constructor() {
    super("Worldstate session has not loaded a durable ledger.");
    this.name = "WorldstateSessionNotReadyError";
  }
}

const PROJECT_LABEL = "Plan our home move";

interface ActivityProjection {
  readonly activeSourceId: string | null;
  readonly activeRequestId: string | null;
  readonly activeDeltaId: string | null;
  readonly error: WorldstateSessionError | null;
  readonly retry: WorldstateSessionRetry | null;
}

const EMPTY_ACTIVITY: ActivityProjection = {
  activeSourceId: null,
  activeRequestId: null,
  activeDeltaId: null,
  error: null,
  retry: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function activityFromLedger(ledger: WorldstateLedger): ActivityProjection {
  let activity = EMPTY_ACTIVITY;
  let selectedNodeId: string = HOME_MOVE_IDS.budget;

  for (const event of ledger.events) {
    if (event.type === "source.captured") {
      const attempt = parsePlacementAttemptSource(event.payload.source);
      const exchange = parsePlacementExchangeSource(event.payload.source);
      if (attempt) {
        selectedNodeId =
          attempt.request.projection.selectedNodeId ?? HOME_MOVE_IDS.budget;
        activity = {
          activeSourceId: attempt.request.source.sourceId,
          activeRequestId: attempt.request.requestId,
          activeDeltaId: null,
          error: null,
          retry: {
            operation: "placement",
            sourceId: attempt.request.source.sourceId,
            selectedNodeId,
          },
        };
      } else if (exchange) {
        selectedNodeId =
          exchange.request.projection.selectedNodeId ?? HOME_MOVE_IDS.budget;
        const responseError = exchange.response.ok
          ? null
          : {
              code: exchange.response.error.code,
              message: exchange.response.error.message,
              retryable: exchange.response.error.retryable,
              scope: "placement" as const,
            };
        activity = {
          activeSourceId: exchange.request.source.sourceId,
          activeRequestId: exchange.request.requestId,
          activeDeltaId:
            exchange.response.ok && exchange.response.delta
              ? exchange.response.delta.deltaId
              : null,
          error: responseError,
          retry:
            responseError?.retryable === true
              ? {
                  operation: "placement",
                  sourceId: exchange.request.source.sourceId,
                  selectedNodeId,
                }
              : null,
        };
      } else if (
        event.payload.source.kind === "text" &&
        event.payload.source.visibility === "shared"
      ) {
        activity = {
          ...EMPTY_ACTIVITY,
          activeSourceId: event.payload.source.id,
          retry: {
            operation: "placement",
            sourceId: event.payload.source.id,
            selectedNodeId,
          },
        };
      }
      continue;
    }

    if (event.type === "manager.failure_recorded") {
      activity = {
        ...activity,
        activeSourceId: event.payload.sourceId ?? activity.activeSourceId,
        activeDeltaId: null,
        error: {
          code: event.payload.code,
          message: event.payload.message,
          retryable: event.payload.retriable,
          scope: "placement",
        },
        retry:
          event.payload.retriable && event.payload.sourceId
            ? {
                operation: "placement",
                sourceId: event.payload.sourceId,
                selectedNodeId,
              }
            : null,
      };
    }
  }

  return activity;
}

function loadedDocument(input: unknown): {
  readonly document: WorldstateLedgerDocument;
  readonly ledger: WorldstateLedger;
  readonly state: WorldstateState;
  readonly version: LedgerVersion;
  readonly activity: ActivityProjection;
} {
  const document = parseWorldstateLedgerDocument(input);
  const ledger = worldstateLedgerFromDocument(document);
  const state = reduceWorldstateLedger(ledger);
  const version = ledgerVersion(document);

  if (!version) {
    throw new LedgerCorruptionError(
      `Ledger ${document.projectId} did not produce a persistence version.`,
    );
  }

  return {
    document,
    ledger,
    state,
    version,
    activity: activityFromLedger(ledger),
  };
}

class DurableWorldstateSession implements WorldstateSession {
  private readonly listeners = new Set<() => void>();
  private readonly transaction: WorldstateLedgerTransactionService;
  private snapshot: WorldstateSessionSnapshot = {
    document: null,
    ledger: null,
    state: null,
    version: null,
    persistenceState: "loading",
    persistenceDetail: "Waiting for the browser ledger.",
    operationState: "idle",
    ...EMPTY_ACTIVITY,
  };

  constructor(private readonly dependencies: WorldstateSessionDependencies) {
    this.transaction = createWorldstateLedgerTransactionService({
      store: dependencies.store,
      now: dependencies.now,
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WorldstateSessionSnapshot => this.snapshot;

  async initialize(): Promise<void> {
    this.assertIdle();
    this.patch({
      persistenceState: "loading",
      persistenceDetail: "Loading the browser ledger.",
      operationState: "initializing",
      error: null,
      retry: null,
    });

    try {
      const existing = await this.dependencies.store.get(HOME_MOVE_IDS.project);
      if (existing) {
        this.install(existing, "saved", "Browser ledger loaded.");
        return;
      }

      const fixture = createHomeMoveSeedFixture();
      const document = worldstateLedgerDocument({
        ledger: fixture.ledger,
        projectLabel: PROJECT_LABEL,
        updatedAt: this.dependencies.now(),
      });

      try {
        await this.dependencies.store.put(document, null);
        this.install(document, "saved", "Sandbox ledger created.");
      } catch (error) {
        if (!(error instanceof LedgerConflictError)) throw error;

        const concurrentlyCreated = await this.dependencies.store.get(
          HOME_MOVE_IDS.project,
        );
        if (!concurrentlyCreated) throw error;
        this.install(
          concurrentlyCreated,
          "saved",
          "Sandbox ledger loaded after concurrent creation.",
        );
      }
    } catch (error) {
      this.surfaceLoadFailure(error);
    }
  }

  async captureAndPlace(
    text: string,
    selectedNodeId = HOME_MOVE_IDS.budget,
  ): Promise<void> {
    this.assertIdle();
    const { ledger } = this.requireLoaded();

    const sourceId = this.dependencies.nextId("source");
    const sourceEvent = sourceCapturedEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: sourceId,
          kind: "text",
          content: text,
          visibility: "shared",
        },
      },
    });
    const requestId = this.dependencies.nextId("request");
    let request: PlacementRequest;

    try {
      const previewLedger = appendLedgerEvent(ledger, sourceEvent).ledger;
      request = compilePlacementRequest({
        state: reduceWorldstateLedger(previewLedger),
        sourceId,
        requestId,
        scopeId: HOME_MOVE_IDS.project,
        projectId: HOME_MOVE_IDS.projectNode,
        selectedNodeId,
      });
    } catch (error) {
      await this.persistUnplacedSource({
        sourceEvent,
        sourceId,
        error,
      });
      return;
    }

    const attempt = placementAttemptSourceEvent({
      request,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the source and bounded placement request.",
      operationState: "capturing",
      error: null,
      retry: null,
    });

    try {
      const sourceResult = await this.append([sourceEvent, attempt]);
      this.installTransaction(sourceResult, {
        activeSourceId: sourceId,
        activeRequestId: requestId,
        activeDeltaId: null,
        error: null,
        retry: { operation: "placement", sourceId, selectedNodeId },
      }, {
        operationState: "placing",
        persistenceDetail:
          "The source and exact placement request are durable; placement is in progress.",
      });
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "placement");
      return;
    }

    await this.requestPlacement(request, selectedNodeId);
  }

  async retryPlacement(): Promise<void> {
    this.assertIdle();
    this.requireLoaded();
    const retry = this.snapshot.retry;
    if (!retry || retry.operation !== "placement") {
      throw new WorldstateSessionNotReadyError();
    }
    if (!this.snapshot.state?.operational.sources[retry.sourceId]) {
      throw new WorldstateSessionNotReadyError();
    }

    await this.placeCapturedSource(retry.sourceId, retry.selectedNodeId);
  }

  async acceptActivePlacement(): Promise<void> {
    this.assertIdle();
    const { state } = this.requireLoaded();
    const deltaId = this.snapshot.activeDeltaId;
    const proposal = deltaId ? state.operational.deltas[deltaId] : undefined;

    if (!deltaId || !proposal || proposal.disposition !== "pending") {
      throw new WorldstateSessionNotReadyError();
    }

    if (proposal.delta.baseRevisionId !== state.canonical.head.id) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail:
          "The placement is stale and must be reviewed against the current revision.",
        operationState: "idle",
        error: {
          code: "stale_delta",
          message:
            "This placement was proposed against an older revision and cannot be committed.",
          retryable: false,
          scope: "semantic_commit",
        },
        retry: null,
      });
      return;
    }

    const accepted = buildDeltaAcceptedEvent(state, {
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.human,
      deltaId,
    });

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the semantic commit.",
      operationState: "accepting",
      error: null,
      retry: null,
    });

    try {
      const result = await this.append([accepted]);
      this.installTransaction(result, {
        ...activityFromLedger(result.ledger),
        activeSourceId: this.snapshot.activeSourceId,
        activeRequestId: this.snapshot.activeRequestId,
        activeDeltaId: deltaId,
      });
    } catch (error) {
      await this.surfaceWriteFailure(error, null, "semantic_commit");
    }
  }

  async resetSandbox(): Promise<void> {
    this.assertIdle();
    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Resetting the local sandbox.",
      operationState: "resetting",
      error: null,
      retry: null,
    });

    try {
      const fixture = createHomeMoveSeedFixture();
      const document = worldstateLedgerDocument({
        ledger: fixture.ledger,
        projectLabel: PROJECT_LABEL,
        updatedAt: this.dependencies.now(),
      });
      await this.dependencies.store.replace(document, this.snapshot.version);
      this.install(document, "saved", "Sandbox ledger reset.");
    } catch (error) {
      await this.surfaceResetFailure(error);
    }
  }

  private async persistUnplacedSource(input: {
    readonly sourceEvent: LedgerEvent;
    readonly sourceId: string;
    readonly error: unknown;
  }): Promise<void> {
    const retry: WorldstateSessionRetry = {
      operation: "placement",
      sourceId: input.sourceId,
      selectedNodeId: HOME_MOVE_IDS.budget,
    };
    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the captured source.",
      operationState: "capturing",
      error: null,
      retry: null,
    });

    try {
      const result = await this.append([input.sourceEvent]);
      this.installTransaction(result, {
        activeSourceId: input.sourceId,
        activeRequestId: null,
        activeDeltaId: null,
        error: {
          code: "placement_request_invalid",
          message: errorMessage(input.error, "The placement request is invalid."),
          retryable: true,
          scope: "placement",
        },
        retry,
      }, {
        persistenceDetail:
          "The source is durable, but the placement request was invalid.",
      });
    } catch (writeError) {
      await this.surfaceWriteFailure(writeError, null, "placement");
    }
  }

  private async placeCapturedSource(
    sourceId: string,
    selectedNodeId: string,
  ): Promise<void> {
    const { state } = this.requireLoaded();
    const requestId = this.dependencies.nextId("request");
    let request: PlacementRequest;

    try {
      request = compilePlacementRequest({
        state,
        sourceId,
        requestId,
        scopeId: HOME_MOVE_IDS.project,
        projectId: HOME_MOVE_IDS.projectNode,
        selectedNodeId,
      });
    } catch (error) {
      this.patch({
        persistenceState: "saved",
        persistenceDetail: "The source is saved, but placement could not start.",
        operationState: "idle",
        activeSourceId: sourceId,
        activeRequestId: requestId,
        activeDeltaId: null,
        error: {
          code: "placement_request_invalid",
          message: errorMessage(error, "The placement request is invalid."),
          retryable: false,
          scope: "placement",
        },
        retry: null,
      });
      return;
    }

    const attempt = placementAttemptSourceEvent({
      request,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
    });
    const retry: WorldstateSessionRetry = {
      operation: "placement",
      sourceId,
      selectedNodeId,
    };

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the exact placement retry request.",
      operationState: "placing",
      activeSourceId: sourceId,
      activeRequestId: requestId,
      activeDeltaId: null,
      error: null,
      retry: null,
    });

    try {
      const result = await this.append([attempt]);
      this.installTransaction(result, {
        activeSourceId: sourceId,
        activeRequestId: requestId,
        activeDeltaId: null,
        error: null,
        retry,
      }, {
        operationState: "placing",
        persistenceDetail:
          "The exact placement retry request is durable; placement is in progress.",
      });
    } catch (error) {
      await this.surfaceWriteFailure(error, retry, "placement");
      return;
    }

    await this.requestPlacement(request, selectedNodeId);
  }

  private async requestPlacement(
    request: PlacementRequest,
    selectedNodeId: string,
  ): Promise<void> {
    const sourceId = request.source.sourceId;
    const requestId = request.requestId;

    let response: PlacementResponse;
    try {
      response = PlacementResponseSchema.parse(
        await this.dependencies.placementGateway(request),
      );
    } catch (error) {
      await this.persistNetworkFailure({
        sourceId,
        requestId,
        selectedNodeId,
        message: errorMessage(
          error,
          "The placement gateway failed before returning a response.",
        ),
      });
      return;
    }

    const exchangeSourceId = placementExchangeSourceId(requestId);
    const exchange = placementExchangeSourceEvent({
      request,
      response,
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.system,
    });
    const events: LedgerEvent[] = [exchange];
    let deltaId: string | null = null;
    let surfacedError: WorldstateSessionError | null = null;
    let retry: WorldstateSessionRetry | null = null;

    if (!response.ok) {
      surfacedError = {
        code: response.error.code,
        message: response.error.message,
        retryable: response.error.retryable,
        scope: "placement",
      };
      retry = response.error.retryable
        ? { operation: "placement", sourceId, selectedNodeId }
        : null;
      events.push(
        this.failureEvent({
          sourceId,
          code: response.error.code,
          message: response.error.message,
          retriable: response.error.retryable,
        }),
      );
    } else {
      try {
        assertPlacementResponseMatchesRequest(request, response);
        const delta = placementResponseToKernelDelta(response, {
          evidenceSourceId: exchangeSourceId,
        });
        if (delta) {
          const proposed = deltaProposedEvent({
            eventId: this.dependencies.nextId("event"),
            commandId: this.dependencies.nextId("command"),
            occurredAt: this.dependencies.now(),
            actor: HOME_MOVE_ACTORS.manager,
            payload: { delta },
          });
          const ledgerWithExchange = appendLedgerEvent(
            this.requireLoaded().ledger,
            exchange,
          ).ledger;
          appendLedgerEvent(ledgerWithExchange, proposed);
          deltaId = delta.id;
          events.push(proposed);
        }
      } catch (error) {
        const responseMismatch =
          error instanceof PlacementResponseCoherenceError;
        surfacedError = {
          code: responseMismatch
            ? "placement_response_mismatch"
            : "placement_conversion_failed",
          message: errorMessage(
            error,
            responseMismatch
              ? "The placement response did not match its exact request."
              : "The placement response could not be converted into a pending delta.",
          ),
          retryable: true,
          scope: "placement",
        };
        retry = { operation: "placement", sourceId, selectedNodeId };
        events.push(
          this.failureEvent({
            sourceId,
            code: surfacedError.code,
            message: surfacedError.message,
            retriable: true,
          }),
        );
      }
    }

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the exact placement result.",
      operationState: "persisting_placement",
    });

    try {
      const [firstEvent, ...remainingEvents] = events;
      if (!firstEvent) {
        throw new Error("A placement result must persist at least one event.");
      }
      const result = await this.append([firstEvent, ...remainingEvents]);
      this.installTransaction(result, {
        activeSourceId: sourceId,
        activeRequestId: requestId,
        activeDeltaId: deltaId,
        error: surfacedError,
        retry,
      });
    } catch (error) {
      await this.surfaceWriteFailure(
        error,
        {
          operation: "placement",
          sourceId,
          selectedNodeId,
        },
        "placement",
      );
    }
  }

  private async persistNetworkFailure(input: {
    readonly sourceId: string;
    readonly requestId: string;
    readonly selectedNodeId: string;
    readonly message: string;
  }): Promise<void> {
    const error: WorldstateSessionError = {
      code: "placement_gateway_failed",
      message: input.message,
      retryable: true,
      scope: "placement",
    };
    const retry: WorldstateSessionRetry = {
      operation: "placement",
      sourceId: input.sourceId,
      selectedNodeId: input.selectedNodeId,
    };

    this.patch({
      persistenceState: "saving",
      persistenceDetail: "Saving the placement failure.",
      operationState: "persisting_placement",
      activeSourceId: input.sourceId,
      activeRequestId: input.requestId,
      activeDeltaId: null,
    });

    try {
      const result = await this.append([
        this.failureEvent({
          sourceId: input.sourceId,
          code: error.code,
          message: error.message,
          retriable: true,
        }),
      ]);
      this.installTransaction(result, {
        activeSourceId: input.sourceId,
        activeRequestId: input.requestId,
        activeDeltaId: null,
        error,
        retry,
      });
    } catch (writeError) {
      await this.surfaceWriteFailure(writeError, retry, "placement");
    }
  }

  private failureEvent(input: {
    readonly sourceId: string;
    readonly code: string;
    readonly message: string;
    readonly retriable: boolean;
  }): LedgerEvent {
    return createLedgerEvent({
      eventId: this.dependencies.nextId("event"),
      commandId: this.dependencies.nextId("command"),
      occurredAt: this.dependencies.now(),
      actor: HOME_MOVE_ACTORS.manager,
      type: "manager.failure_recorded",
      payload: input,
    });
  }

  private append(
    events: NonEmptyLedgerEvents,
  ): Promise<WorldstateLedgerTransactionResult> {
    const { document, version } = this.requireLoaded();
    return this.transaction.append({
      current: { document, expectedVersion: version },
      events,
    });
  }

  private installTransaction(
    result: WorldstateLedgerTransactionResult,
    activity: ActivityProjection,
    options: {
      readonly operationState?: WorldstateSessionOperationState;
      readonly persistenceDetail?: string;
    } = {},
  ): void {
    this.snapshot = {
      document: result.document,
      ledger: result.ledger,
      state: result.state,
      version: result.version,
      persistenceState: "saved",
      persistenceDetail: options.persistenceDetail ?? "Browser ledger saved.",
      operationState: options.operationState ?? "idle",
      ...activity,
    };
    this.emit();
  }

  private install(
    input: unknown,
    persistenceState: WorldstateSessionPersistenceState,
    persistenceDetail: string,
  ): void {
    const loaded = loadedDocument(input);
    this.snapshot = {
      document: loaded.document,
      ledger: loaded.ledger,
      state: loaded.state,
      version: loaded.version,
      persistenceState,
      persistenceDetail,
      operationState: "idle",
      ...loaded.activity,
    };
    this.emit();
  }

  private async surfaceWriteFailure(
    error: unknown,
    retry: WorldstateSessionRetry | null,
    scope: WorldstateSessionErrorScope,
  ): Promise<void> {
    if (error instanceof LedgerConflictError) {
      try {
        const current = await this.dependencies.store.get(HOME_MOVE_IDS.project);
        if (!current) throw error;
        const loaded = loadedDocument(current);
        this.snapshot = {
          document: loaded.document,
          ledger: loaded.ledger,
          state: loaded.state,
          version: loaded.version,
          persistenceState: "conflict",
          persistenceDetail:
            "The ledger changed in another session. Durable state was reloaded.",
          operationState: "idle",
          ...loaded.activity,
          error: {
            code: "ledger_conflict",
            message: error.message,
            retryable: true,
            scope,
          },
          retry,
        };
        this.emit();
        return;
      } catch (reloadError) {
        this.surfaceLoadFailure(reloadError);
        return;
      }
    }

    const corruption =
      error instanceof LedgerCorruptionError || error instanceof z.ZodError;
    this.patch({
      persistenceState: corruption ? "corrupt" : "unavailable",
      persistenceDetail: corruption
        ? "The browser ledger failed validation."
        : "The browser ledger could not save this operation.",
      operationState: "idle",
      error: {
        code: corruption ? "ledger_corrupt" : "storage_unavailable",
        message: errorMessage(error, "The browser ledger is unavailable."),
        retryable: !corruption,
        scope,
      },
      retry: corruption ? null : retry,
    });
  }

  private async surfaceResetFailure(
    error: unknown,
  ): Promise<void> {
    let durableDocument: WorldstateLedgerDocument | null = null;
    const conflict = error instanceof LedgerConflictError;

    try {
      durableDocument = await this.dependencies.store.get(HOME_MOVE_IDS.project);
    } catch {
      // A failed read cannot confirm durable state. Continue to the truthful
      // empty-snapshot fallback below rather than retaining stale memory.
    }

    if (durableDocument) {
      try {
        const loaded = loadedDocument(durableDocument);
        this.snapshot = {
          document: loaded.document,
          ledger: loaded.ledger,
          state: loaded.state,
          version: loaded.version,
          persistenceState: conflict ? "conflict" : "unavailable",
          persistenceDetail: conflict
            ? "Atomic reset was blocked because the durable ledger changed; current truth was reloaded."
            : "Atomic reset failed; the prior durable ledger remains intact.",
          operationState: "idle",
          ...loaded.activity,
          error: {
            code: conflict ? "ledger_conflict" : "storage_unavailable",
            message: errorMessage(error, "The local sandbox could not reset."),
            retryable: true,
            scope: "reset",
          },
        };
        this.emit();
        return;
      } catch {
        // Corrupt or unreadable durable content must not remain installed as
        // though it were the confirmed browser ledger.
      }
    }

    this.snapshot = {
      document: null,
      ledger: null,
      state: null,
      version: null,
      persistenceState: "unavailable",
      persistenceDetail:
        "Reset failed and no durable browser ledger could be confirmed.",
      operationState: "idle",
      ...EMPTY_ACTIVITY,
      error: {
        code: "storage_unavailable",
        message: errorMessage(error, "The local sandbox could not reset."),
        retryable: true,
        scope: "reset",
      },
    };
    this.emit();
  }

  private surfaceLoadFailure(error: unknown): void {
    const corruption =
      error instanceof LedgerCorruptionError || error instanceof z.ZodError;
    this.patch({
      persistenceState: corruption ? "corrupt" : "unavailable",
      persistenceDetail: corruption
        ? "The browser ledger failed validation."
        : "The browser ledger is unavailable.",
      operationState: "idle",
      error: {
        code: corruption ? "ledger_corrupt" : "storage_unavailable",
        message: errorMessage(error, "The browser ledger is unavailable."),
        retryable: !corruption,
        scope: "persistence",
      },
      retry: null,
    });
  }

  private requireLoaded(): {
    readonly document: WorldstateLedgerDocument;
    readonly ledger: WorldstateLedger;
    readonly state: WorldstateState;
    readonly version: LedgerVersion;
  } {
    const { document, ledger, state, version } = this.snapshot;
    if (!document || !ledger || !state || !version) {
      throw new WorldstateSessionNotReadyError();
    }
    return { document, ledger, state, version };
  }

  private assertIdle(): void {
    if (this.snapshot.operationState !== "idle") {
      throw new WorldstateSessionBusyError(this.snapshot.operationState);
    }
  }

  private patch(patch: Partial<WorldstateSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createWorldstateSession(
  dependencies: WorldstateSessionDependencies,
): WorldstateSession {
  return new DurableWorldstateSession(dependencies);
}
