import { describe, expect, it, vi } from "vitest";

import {
  PlacementErrorResponseSchema,
  PlacementSuccessResponseSchema,
  placeSource,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  LedgerConflictError,
  createMemoryWorldstateLedgerStore,
  ledgerVersion,
  type ProjectLedgerStore,
} from "@/adapters/storage";
import {
  buildDeltaAcceptedEvent,
  createLedgerEvent,
  deltaProposedEvent,
  type LedgerEvent,
  type WorldstateDelta,
} from "@/domain";
import {
  createHomeMoveSeedFixture,
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
} from "@/fixtures";
import {
  parsePlacementAttemptSource,
  parsePlacementExchange,
  parsePlacementExchangeSource,
} from "@/integration/placement-evidence";

import { appendWorldstateLedgerEvents } from "./worldstate-ledger-transaction";
import {
  createWorldstateSession,
  WorldstateSessionBusyError,
  type WorldstateSession,
  type WorldstateSessionIdKind,
} from "./worldstate-session";

const NOW = "2026-07-17T12:00:00.000Z";
const SOURCE_TEXT =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";

function deterministicIds(seed = "session") {
  let ordinal = 0;
  return (kind: WorldstateSessionIdKind) => `${seed}:${kind}:${++ordinal}`;
}

async function fixtureGateway(
  request: PlacementRequest,
): Promise<PlacementResponse> {
  return (
    await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    })
  ).body;
}

function createSession(input: {
  store?: ProjectLedgerStore<LedgerEvent>;
  gateway?: (request: PlacementRequest) => Promise<PlacementResponse>;
  seed?: string;
} = {}): {
  readonly store: ProjectLedgerStore<LedgerEvent>;
  readonly session: WorldstateSession;
} {
  const store = input.store ?? createMemoryWorldstateLedgerStore();
  return {
    store,
    session: createWorldstateSession({
      store,
      placementGateway: input.gateway ?? fixtureGateway,
      now: () => NOW,
      nextId: deterministicIds(input.seed),
    }),
  };
}

function eventTypes(session: WorldstateSession): LedgerEvent["type"][] {
  return session.getSnapshot().ledger?.events.map((event) => event.type) ?? [];
}

function apiError(request: PlacementRequest, retryable = true): PlacementResponse {
  return PlacementErrorResponseSchema.parse({
    ok: false,
    manager: {
      requestedMode: "live",
      effectiveMode: "live",
      status: "failed",
      provider: "openai",
      model: "test-model",
      responseId: null,
    },
    sourcePreserved: true,
    error: {
      code: "provider_request_failed",
      message: `Placement failed for ${request.source.sourceId}.`,
      retryable,
      issues: [],
    },
  });
}

async function clarificationResponse(
  request: PlacementRequest,
): Promise<PlacementResponse> {
  const fixture = await fixtureGateway(request);
  if (!fixture.ok) throw new Error("The fixture gateway unexpectedly failed.");

  return PlacementSuccessResponseSchema.parse({
    ...fixture,
    receipt: {
      ...fixture.receipt,
      decisionState: "needs_clarification",
      location: {
        targetNodeId: null,
        label: "Project selection required",
        breadcrumb: ["World"],
      },
      proposedRelations: [],
      clarificationQuestion: "Which area should contain this task?",
    },
    delta: null,
  });
}

describe("worldstate browser session", () => {
  it("seeds an absent browser ledger once and reloads it thereafter", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const put = vi.spyOn(store, "put");
    const first = createSession({ store, seed: "first" }).session;

    expect(first.getSnapshot().persistenceState).toBe("loading");
    await first.initialize();

    expect(first.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      operationState: "idle",
      activeSourceId: null,
    });
    expect(first.getSnapshot().document?.projectId).toBe(HOME_MOVE_IDS.project);
    expect(first.getSnapshot().ledger?.events).toHaveLength(2);
    expect(put).toHaveBeenCalledTimes(1);

    const second = createSession({ store, seed: "second" }).session;
    await second.initialize();

    expect(second.getSnapshot().version).toEqual(first.getSnapshot().version);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("reloads a concurrent seed winner without reporting a false failure", async () => {
    const base = createMemoryWorldstateLedgerStore();
    const racingStore: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        if (expectedVersion === null && !(await base.get(document.projectId))) {
          await base.put(document, null);
          throw new LedgerConflictError(
            document.projectId,
            null,
            ledgerVersion(document),
          );
        }
        await base.put(document, expectedVersion);
      },
    };
    const { session } = createSession({ store: racingStore });

    await session.initialize();

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      operationState: "idle",
      error: null,
    });
    expect(session.getSnapshot().persistenceDetail).toContain("concurrent");
  });

  it("persists the human source before the gateway and atomically saves the exact exchange plus pending delta", async () => {
    const base = createMemoryWorldstateLedgerStore();
    const persistedEventCounts: number[] = [];
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        await base.put(document, expectedVersion);
        persistedEventCounts.push(document.events.length);
      },
    };
    let returnedResponse: PlacementResponse | null = null;
    const gateway = vi.fn(async (request: PlacementRequest) => {
      const atGateway = await base.get(HOME_MOVE_IDS.project);
      expect(atGateway?.events.map((event) => event.type)).toEqual([
        "delta.proposed",
        "delta.accepted",
        "source.captured",
        "source.captured",
      ]);
      const durableAttempt = atGateway?.events.at(-1);
      if (durableAttempt?.type !== "source.captured") {
        throw new Error("Expected a durable placement attempt before dispatch.");
      }
      expect(
        parsePlacementAttemptSource(durableAttempt.payload.source)?.request,
      ).toEqual(request);
      returnedResponse = await fixtureGateway(request);
      return returnedResponse;
    });
    const { session } = createSession({ store, gateway });
    await session.initialize();
    const originalHead = session.getSnapshot().state?.canonical.head.id;

    await session.captureAndPlace(SOURCE_TEXT);

    expect(gateway).toHaveBeenCalledTimes(1);
    expect(persistedEventCounts).toEqual([2, 4, 6]);
    expect(eventTypes(session)).toEqual([
      "delta.proposed",
      "delta.accepted",
      "source.captured",
      "source.captured",
      "source.captured",
      "delta.proposed",
    ]);
    expect(session.getSnapshot().state?.canonical.head.id).toBe(originalHead);
    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      operationState: "idle",
      error: null,
    });

    const events = session.getSnapshot().ledger?.events ?? [];
    const exchangeEvent = events[4];
    expect(exchangeEvent?.type).toBe("source.captured");
    if (exchangeEvent?.type !== "source.captured") {
      throw new Error("Expected a durable placement exchange source.");
    }
    const exchange = parsePlacementExchange(exchangeEvent.payload.source.content);
    expect(exchange?.response).toEqual(returnedResponse);
    expect(exchange?.request.source.sourceId).toBe(
      session.getSnapshot().activeSourceId,
    );

    const activeDelta = session.getSnapshot().activeDeltaId;
    expect(activeDelta).toBeTruthy();
    expect(
      activeDelta
        ? session.getSnapshot().state?.operational.deltas[activeDelta]
            ?.disposition
        : null,
    ).toBe("pending");
    expect(
      activeDelta
        ? session.getSnapshot().state?.operational.deltas[activeDelta]?.delta
            .sourceRefs
        : [],
    ).toContain(exchangeEvent.payload.source.id);
  });

  it("keeps the operation busy across the source-to-gateway boundary", async () => {
    let releaseGateway: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    const gateway = vi.fn(async (request: PlacementRequest) => {
      const response = await fixtureGateway(request);
      await gate;
      return response;
    });
    const { session } = createSession({ gateway });
    await session.initialize();

    const first = session.captureAndPlace(SOURCE_TEXT);
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledTimes(1));

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      operationState: "placing",
      activeDeltaId: null,
    });
    await expect(session.captureAndPlace("A duplicate click")).rejects.toBeInstanceOf(
      WorldstateSessionBusyError,
    );

    releaseGateway?.();
    await first;
    expect(session.getSnapshot().operationState).toBe("idle");
  });

  it("commits only the active delta as one new revision after persistence", async () => {
    const { session } = createSession();
    await session.initialize();
    await session.captureAndPlace(SOURCE_TEXT);
    const before = session.getSnapshot();
    const beforeEventCount = before.ledger?.events.length ?? 0;
    const beforeRevisionCount = before.state?.canonical.revisionOrder.length ?? 0;
    const deltaId = before.activeDeltaId;

    await session.acceptActivePlacement();

    const after = session.getSnapshot();
    expect(after.ledger?.events.slice(beforeEventCount).map((event) => event.type)).toEqual([
      "delta.accepted",
    ]);
    expect(after.state?.canonical.revisionOrder).toHaveLength(
      beforeRevisionCount + 1,
    );
    expect(after.state?.canonical.head.id).not.toBe(
      before.state?.canonical.head.id,
    );
    expect(deltaId ? after.state?.operational.deltas[deltaId]?.disposition : null).toBe(
      "accepted",
    );
    expect(
      eventTypes(session).some((type) =>
        ["brief.compiled", "run.authorized", "closure.staged"].includes(type),
      ),
    ).toBe(false);
  });

  it("keeps a pending delta visibly retryable after semantic-commit storage failure", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let writes = 0;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        writes += 1;
        if (writes === 4) throw new Error("commit transaction aborted");
        await base.put(document, expectedVersion);
      },
    };
    const { session } = createSession({ store });
    await session.initialize();
    await session.captureAndPlace(SOURCE_TEXT);
    const deltaId = session.getSnapshot().activeDeltaId;

    await session.acceptActivePlacement();

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "unavailable",
      activeDeltaId: deltaId,
      error: {
        code: "storage_unavailable",
        retryable: true,
        scope: "semantic_commit",
      },
    });
    expect(
      deltaId
        ? session.getSnapshot().state?.operational.deltas[deltaId]?.disposition
        : null,
    ).toBe("pending");

    await session.acceptActivePlacement();

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      error: null,
    });
    expect(
      deltaId
        ? session.getSnapshot().state?.operational.deltas[deltaId]?.disposition
        : null,
    ).toBe("accepted");
  });

  it("retries placement with the durable source without capturing it twice", async () => {
    let calls = 0;
    const gateway = vi.fn(async (request: PlacementRequest) => {
      calls += 1;
      return calls === 1 ? apiError(request) : fixtureGateway(request);
    });
    const { session } = createSession({ gateway });
    await session.initialize();

    await session.captureAndPlace(SOURCE_TEXT);
    const sourceId = session.getSnapshot().activeSourceId;
    expect(session.getSnapshot().retry).toMatchObject({
      operation: "placement",
      sourceId,
    });

    await session.retryPlacement();

    expect(gateway).toHaveBeenCalledTimes(2);
    const humanSourceIds =
      session.getSnapshot().ledger?.events.flatMap((event) =>
        event.type === "source.captured" &&
        event.payload.source.kind === "text"
          ? [event.payload.source.id]
          : [],
      ) ?? [];
    expect(humanSourceIds).toEqual([sourceId]);
    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      error: null,
      retry: null,
    });
    expect(session.getSnapshot().activeDeltaId).toBeTruthy();
  });

  it("persists clarification evidence without creating a committable delta", async () => {
    const { session } = createSession({ gateway: clarificationResponse });
    await session.initialize();

    await session.captureAndPlace("Help me organize a moving task.");

    expect(eventTypes(session).slice(-2)).toEqual([
      "source.captured",
      "source.captured",
    ]);
    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      operationState: "idle",
      activeDeltaId: null,
      error: null,
      retry: null,
    });
  });

  it("persists an API error beside its exact response and preserves retry", async () => {
    const { session } = createSession({
      gateway: async (request) => apiError(request, true),
    });
    await session.initialize();

    await session.captureAndPlace(SOURCE_TEXT);

    expect(eventTypes(session).slice(-3)).toEqual([
      "source.captured",
      "source.captured",
      "manager.failure_recorded",
    ]);
    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      activeDeltaId: null,
      error: { code: "provider_request_failed", retryable: true },
      retry: { operation: "placement" },
    });
    const exchangeEvent = session.getSnapshot().ledger?.events.at(-2);
    if (exchangeEvent?.type !== "source.captured") {
      throw new Error("Expected the API error exchange to be durable.");
    }
    expect(parsePlacementExchange(exchangeEvent.payload.source.content)?.response.ok).toBe(
      false,
    );
  });

  it("persists a thrown gateway failure without inventing a response exchange", async () => {
    const { session } = createSession({
      gateway: async () => {
        throw new Error("network offline");
      },
    });
    await session.initialize();

    await session.captureAndPlace(SOURCE_TEXT);

    expect(eventTypes(session).slice(-2)).toEqual([
      "source.captured",
      "manager.failure_recorded",
    ]);
    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      activeDeltaId: null,
      error: {
        code: "placement_gateway_failed",
        message: "network offline",
        retryable: true,
      },
      retry: { operation: "placement" },
    });
    expect(
      session
        .getSnapshot()
        .ledger?.events.some(
          (event) =>
            event.type === "source.captured" &&
            parsePlacementExchangeSource(event.payload.source) !== null,
        ),
    ).toBe(false);
  });

  it("reloads a failed attempt with its selected target and retries under a new request id", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const requests: PlacementRequest[] = [];
    const gateway = vi.fn(async (request: PlacementRequest) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("network offline");
      return fixtureGateway(request);
    });
    const first = createSession({ store, gateway, seed: "first" }).session;
    await first.initialize();
    await first.captureAndPlace(SOURCE_TEXT, HOME_MOVE_IDS.providers);
    const failedRequestId = first.getSnapshot().activeRequestId;

    const reloaded = createSession({ store, gateway, seed: "reload" }).session;
    await reloaded.initialize();

    expect(reloaded.getSnapshot()).toMatchObject({
      activeRequestId: failedRequestId,
      error: { code: "placement_gateway_failed", retryable: true },
      retry: {
        operation: "placement",
        selectedNodeId: HOME_MOVE_IDS.providers,
      },
    });

    await reloaded.retryPlacement();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.requestId).not.toBe(failedRequestId);
    expect(requests[1]?.projection.selectedNodeId).toBe(
      HOME_MOVE_IDS.providers,
    );
    expect(reloaded.getSnapshot()).toMatchObject({
      activeRequestId: requests[1]?.requestId,
      error: null,
      retry: null,
    });
  });

  it("persists and rejects a success cached from an earlier request id", async () => {
    const { session } = createSession({
      gateway: async (request) => {
        const response = await fixtureGateway(request);
        if (!response.ok) throw new Error("Expected fixture placement success.");
        const mismatched = structuredClone(response);
        mismatched.receipt.requestId = "request-from-an-earlier-retry";
        return mismatched;
      },
    });
    await session.initialize();

    await session.captureAndPlace(SOURCE_TEXT);

    expect(eventTypes(session).slice(-2)).toEqual([
      "source.captured",
      "manager.failure_recorded",
    ]);
    expect(session.getSnapshot()).toMatchObject({
      activeDeltaId: null,
      error: { code: "placement_response_mismatch", retryable: true },
      retry: { operation: "placement" },
    });
    const exchangeEvent = session.getSnapshot().ledger?.events.at(-2);
    if (exchangeEvent?.type !== "source.captured") {
      throw new Error("Expected the rejected exchange to remain durable evidence.");
    }
    expect(
      parsePlacementExchangeSource(exchangeEvent.payload.source)?.response.ok,
    ).toBe(true);
  });

  it("persists the exchange when a coherent candidate fails kernel validation", async () => {
    const { session } = createSession({
      gateway: async (request) => {
        const response = await fixtureGateway(request);
        if (!response.ok || !response.delta) {
          throw new Error("Expected fixture placement with a candidate delta.");
        }
        const incompatible = structuredClone(response);
        const relation = incompatible.delta?.operations.find(
          (operation) => operation.op === "relation.add",
        );
        if (!relation || relation.op !== "relation.add") {
          throw new Error("Expected the fixture relation operation.");
        }
        relation.relation.id =
          `relation-${HOME_MOVE_IDS.budget}-belongs-home-move`;
        return PlacementSuccessResponseSchema.parse(incompatible);
      },
    });
    await session.initialize();

    await session.captureAndPlace(SOURCE_TEXT);

    expect(eventTypes(session).slice(-2)).toEqual([
      "source.captured",
      "manager.failure_recorded",
    ]);
    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      activeDeltaId: null,
      error: { code: "placement_conversion_failed", retryable: true },
      retry: { operation: "placement" },
    });
    const exchangeEvent = session.getSnapshot().ledger?.events.at(-2);
    if (exchangeEvent?.type !== "source.captured") {
      throw new Error("Expected the incompatible exchange to remain durable.");
    }
    expect(parsePlacementExchangeSource(exchangeEvent.payload.source)).not.toBeNull();
  });

  it("keeps only confirmed state visible when placement-result storage fails", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let writes = 0;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        writes += 1;
        if (writes === 3) throw new Error("quota exceeded");
        await base.put(document, expectedVersion);
      },
    };
    const { session } = createSession({ store });
    await session.initialize();

    await session.captureAndPlace(SOURCE_TEXT);

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "unavailable",
      operationState: "idle",
      activeDeltaId: null,
      error: { code: "storage_unavailable", retryable: true },
      retry: { operation: "placement" },
    });
    expect(eventTypes(session).slice(-1)).toEqual(["source.captured"]);
    expect(session.getSnapshot().state?.operational.deltas).toEqual(
      createHomeMoveSeedFixture().state.operational.deltas,
    );
    expect((await base.get(HOME_MOVE_IDS.project))?.events).toHaveLength(4);

    const reloaded = createSession({ store: base, seed: "storage-reload" }).session;
    await reloaded.initialize();
    expect(reloaded.getSnapshot()).toMatchObject({
      activeSourceId: session.getSnapshot().activeSourceId,
      activeRequestId: session.getSnapshot().activeRequestId,
      retry: { operation: "placement" },
    });
  });

  it("reloads and surfaces a placement CAS conflict without claiming success", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let writes = 0;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        writes += 1;
        if (writes === 3) {
          const current = await base.get(document.projectId);
          if (!current) throw new Error("Expected a seeded ledger.");
          const sourceId = current.events.at(-1);
          if (sourceId?.type !== "source.captured") {
            throw new Error("Expected the captured source before the CAS race.");
          }
          await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: current,
              expectedVersion: ledgerVersion(current)!,
            },
            events: [
              createLedgerEvent({
                eventId: "external:event",
                commandId: "external:command",
                occurredAt: NOW,
                actor: HOME_MOVE_ACTORS.manager,
                type: "manager.failure_recorded",
                payload: {
                  sourceId: sourceId.payload.source.id,
                  code: "external_append",
                  message: "Another tab appended an operational event.",
                  retriable: true,
                },
              }),
            ],
            now: () => NOW,
          });
        }
        await base.put(document, expectedVersion);
      },
    };
    const { session } = createSession({ store });
    await session.initialize();

    await session.captureAndPlace(SOURCE_TEXT);

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "conflict",
      operationState: "idle",
      activeDeltaId: null,
      error: { code: "ledger_conflict", retryable: true },
      retry: { operation: "placement" },
    });
    expect(eventTypes(session).slice(-2)).toEqual([
      "source.captured",
      "manager.failure_recorded",
    ]);
  });

  it("rehydrates the active source, request, receipt, and pending delta", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const first = createSession({ store, seed: "first" }).session;
    await first.initialize();
    await first.captureAndPlace(SOURCE_TEXT);
    const before = first.getSnapshot();

    const reloaded = createSession({ store, seed: "reload" }).session;
    await reloaded.initialize();
    const after = reloaded.getSnapshot();

    expect(after).toMatchObject({
      persistenceState: "saved",
      activeSourceId: before.activeSourceId,
      activeRequestId: before.activeRequestId,
      activeDeltaId: before.activeDeltaId,
      error: null,
    });
    expect(after.version).toEqual(before.version);
    expect(
      after.activeDeltaId
        ? after.state?.operational.deltas[after.activeDeltaId]?.disposition
        : null,
    ).toBe("pending");
    const exchangeEvent = after.ledger?.events.find(
      (event) =>
        event.type === "source.captured" &&
        parsePlacementExchangeSource(event.payload.source) !== null,
    );
    if (exchangeEvent?.type !== "source.captured") {
      throw new Error("Expected the persisted placement exchange after reload.");
    }
    expect(parsePlacementExchange(exchangeEvent.payload.source.content)?.request.requestId).toBe(
      before.activeRequestId,
    );
  });

  it("blocks a stale semantic commit before writing", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const { session } = createSession({ store });
    await session.initialize();
    await session.captureAndPlace(SOURCE_TEXT);
    const pendingDeltaId = session.getSnapshot().activeDeltaId;
    const current = await store.get(HOME_MOVE_IDS.project);
    const state = session.getSnapshot().state;
    if (!current || !state || !pendingDeltaId) {
      throw new Error("Expected a persisted pending placement.");
    }

    const unrelated: WorldstateDelta = {
      id: "delta-external-head-advance",
      baseRevisionId: state.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "placement",
      proposedBy: HOME_MOVE_ACTORS.system,
      operations: [
        {
          op: "node.add",
          node: {
            id: "node-external-head-advance",
            scopeId: HOME_MOVE_IDS.project,
            kind: "Idea",
            title: "External concurrent idea",
            visibility: "shared",
            sourceRefs: [],
            data: {},
          },
        },
      ],
      rationale: ["Advance the canonical head in another session."],
      sourceRefs: [],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "A concurrent idea becomes canonical.",
    };
    const proposed = deltaProposedEvent({
      eventId: "event-external-proposed",
      commandId: "command-external-proposed",
      occurredAt: NOW,
      actor: HOME_MOVE_ACTORS.system,
      payload: { delta: unrelated },
    });
    const proposalResult = await appendWorldstateLedgerEvents({
      store,
      current: {
        document: current,
        expectedVersion: ledgerVersion(current)!,
      },
      events: [proposed],
      now: () => NOW,
    });
    const accepted = buildDeltaAcceptedEvent(proposalResult.state, {
      eventId: "event-external-accepted",
      commandId: "command-external-accepted",
      occurredAt: NOW,
      actor: HOME_MOVE_ACTORS.system,
      deltaId: unrelated.id,
    });
    await appendWorldstateLedgerEvents({
      store,
      current: {
        document: proposalResult.document,
        expectedVersion: proposalResult.version,
      },
      events: [accepted],
      now: () => NOW,
    });

    await session.initialize();
    const latest = await store.get(HOME_MOVE_IDS.project);
    if (!latest) throw new Error("Expected the concurrently advanced ledger.");
    const writesBefore = latest.events.length;
    await session.acceptActivePlacement();

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      operationState: "idle",
      activeDeltaId: pendingDeltaId,
      error: { code: "stale_delta", retryable: false },
    });
    expect((await store.get(HOME_MOVE_IDS.project))?.events).toHaveLength(
      writesBefore,
    );
  });

  it("atomically replaces the project with a clean, repeatable sandbox", async () => {
    const { session, store } = createSession();
    const replace = vi.spyOn(store, "replace");
    const remove = vi.spyOn(store, "delete");
    await session.initialize();
    await session.captureAndPlace(SOURCE_TEXT);

    await session.resetSandbox();

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "saved",
      operationState: "idle",
      activeSourceId: null,
      activeRequestId: null,
      activeDeltaId: null,
      error: null,
    });
    expect(session.getSnapshot().ledger?.events).toHaveLength(2);
    expect(replace).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains the confirmed durable ledger when atomic reset fails", async () => {
    const base = createMemoryWorldstateLedgerStore();
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async replace() {
        throw new Error("atomic reset failed");
      },
    };
    const { session } = createSession({ store });
    await session.initialize();
    await session.captureAndPlace(SOURCE_TEXT);
    const beforeReset = session.getSnapshot().document;

    await session.resetSandbox();

    const durable = await base.get(HOME_MOVE_IDS.project);
    expect(durable).toEqual(beforeReset);
    expect(session.getSnapshot()).toMatchObject({
      document: durable,
      persistenceState: "unavailable",
      operationState: "idle",
      error: {
        code: "storage_unavailable",
        message: "atomic reset failed",
      },
    });
    expect(session.getSnapshot().persistenceDetail).toContain("remains intact");
  });

  it("blocks an atomic reset when another session changed the ledger", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const { session } = createSession({ store });
    await session.initialize();
    const current = await store.get(HOME_MOVE_IDS.project);
    if (!current) throw new Error("Expected the seeded durable ledger.");
    await appendWorldstateLedgerEvents({
      store,
      current: {
        document: current,
        expectedVersion: ledgerVersion(current)!,
      },
      events: [
        createLedgerEvent({
          eventId: "external-reset-race:event",
          commandId: "external-reset-race:command",
          occurredAt: NOW,
          actor: HOME_MOVE_ACTORS.manager,
          type: "manager.failure_recorded",
          payload: {
            code: "external_reset_race",
            message: "Another tab changed the project before reset.",
            retriable: false,
          },
        }),
      ],
      now: () => NOW,
    });

    await session.resetSandbox();

    expect(session.getSnapshot()).toMatchObject({
      persistenceState: "conflict",
      operationState: "idle",
      error: { code: "ledger_conflict", scope: "reset" },
    });
    expect(eventTypes(session).at(-1)).toBe("manager.failure_recorded");
    expect(session.getSnapshot().ledger?.events).toHaveLength(3);
  });

  it("clears stale memory if a broken store violates atomic replacement", async () => {
    const base = createMemoryWorldstateLedgerStore();
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async replace(document) {
        await base.delete(document.projectId);
        throw new Error("broken replacement removed the ledger");
      },
    };
    const { session } = createSession({ store });
    await session.initialize();
    expect(session.getSnapshot().document).not.toBeNull();

    await session.resetSandbox();

    expect(await base.get(HOME_MOVE_IDS.project)).toBeNull();
    expect(session.getSnapshot()).toMatchObject({
      document: null,
      ledger: null,
      state: null,
      version: null,
      persistenceState: "unavailable",
      operationState: "idle",
      error: { code: "storage_unavailable" },
    });
  });
});
