import { describe, expect, it } from "vitest";

import {
  invalidJsonPlacementResponse,
  placeSource,
  PlacementErrorResponseSchema,
  PlacementSuccessResponseSchema,
  type PlacementResponse,
  type PlacementSuccessResponse,
} from "@/adapters/manager";
import {
  appendLedgerEvent,
  buildDeltaAcceptedEvent,
  createLedgerEvent,
  deltaDispositionEvent,
  deltaProposedEvent,
  reduceWorldstateLedger,
  sourceCapturedEvent,
  type WorldstateDelta,
  type WorldstateLedger,
} from "@/domain";
import {
  createHomeMoveSeedFixture,
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
} from "@/fixtures/home-move";
import {
  placementAttemptSourceEvent,
  placementExchangeSourceEvent,
  placementExchangeSourceId,
} from "@/integration/placement-evidence";
import { placementResponseToKernelDelta } from "@/integration/placement-to-kernel";
import { compilePlacementRequest } from "@/integration/worldstate-to-placement";

import { buildWorkbenchViewModel } from "./view-model";

const SOURCE_ID = "source-workbench-view-model";
const SOURCE_TEXT = "Compare our moving provider quotes.";
const SOURCE_TIME = "2026-07-17T10:00:00.000Z";
const ATTEMPT_TIME = "2026-07-17T10:00:00.500Z";
const EXCHANGE_TIME = "2026-07-17T10:00:01.000Z";
const PROPOSAL_TIME = "2026-07-17T10:00:02.000Z";
const ACCEPT_TIME = "2026-07-17T10:00:03.000Z";

function append(ledger: WorldstateLedger, event: Parameters<typeof appendLedgerEvent>[1]) {
  return appendLedgerEvent(ledger, event).ledger;
}

function durablePlacementAttempt() {
  let { ledger } = createHomeMoveSeedFixture();
  ledger = append(
    ledger,
    sourceCapturedEvent({
      eventId: "event-workbench-source",
      commandId: "command-workbench-source",
      occurredAt: SOURCE_TIME,
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: SOURCE_ID,
          kind: "text",
          content: SOURCE_TEXT,
          visibility: "shared",
        },
      },
    }),
  );

  const sourceState = reduceWorldstateLedger(ledger);
  const request = compilePlacementRequest({
    state: sourceState,
    sourceId: SOURCE_ID,
    requestId: "request-workbench-view-model",
    scopeId: HOME_MOVE_IDS.project,
    projectId: HOME_MOVE_IDS.projectNode,
    selectedNodeId: HOME_MOVE_IDS.budget,
  });
  ledger = append(
    ledger,
    placementAttemptSourceEvent({
      request,
      eventId: "event-workbench-attempt",
      commandId: "command-workbench-attempt",
      occurredAt: ATTEMPT_TIME,
      actor: HOME_MOVE_ACTORS.manager,
    }),
  );

  return { ledger, request };
}

async function placementAttempt(
  transformResponse: (
    response: PlacementSuccessResponse,
  ) => PlacementResponse = (response) => response,
) {
  const durableAttempt = durablePlacementAttempt();
  let { ledger } = durableAttempt;
  const { request } = durableAttempt;
  const gatewayResult = await placeSource(request, {
    environment: { ODEU_MANAGER_MODE: "fixture" },
  });
  if (!gatewayResult.body.ok) throw new Error("Expected fixture placement success.");
  const response = transformResponse(gatewayResult.body);
  ledger = append(
    ledger,
    placementExchangeSourceEvent({
      request,
      response,
      eventId: "event-workbench-exchange",
      commandId: "command-workbench-exchange",
      occurredAt: EXCHANGE_TIME,
      actor: HOME_MOVE_ACTORS.manager,
    }),
  );

  let kernelDelta: WorldstateDelta | null = null;
  if (response.ok && response.delta) {
    kernelDelta = placementResponseToKernelDelta(response, {
      evidenceSourceId: placementExchangeSourceId(request.requestId),
    });
    if (!kernelDelta) throw new Error("Expected a placement delta.");
    ledger = append(
      ledger,
      deltaProposedEvent({
        eventId: "event-workbench-proposal",
        commandId: "command-workbench-proposal",
        occurredAt: PROPOSAL_TIME,
        actor: HOME_MOVE_ACTORS.manager,
        payload: { delta: kernelDelta },
      }),
    );
  }

  return {
    ledger,
    state: reduceWorldstateLedger(ledger),
    request,
    response,
    kernelDelta,
  };
}

describe("buildWorkbenchViewModel", () => {
  it("projects the seed ledger as stable, shared-only canonical truth", () => {
    const seed = createHomeMoveSeedFixture();
    const model = buildWorkbenchViewModel({
      ledger: seed.ledger,
      state: seed.state,
      runtimeFallback: { mode: "fixture", label: "Configured fixture manager" },
    });

    expect(model).toMatchObject({
      project: "Plan our home move",
      projectId: HOME_MOVE_IDS.project,
      projectNodeId: HOME_MOVE_IDS.projectNode,
      revision: `Revision ${seed.state.canonical.head.number} · ${seed.state.canonical.head.id}`,
      placement: {
        state: "idle",
        canAccept: false,
      },
      runtime: { mode: "fixture", label: "Configured fixture manager" },
      work: {
        available: false,
        reason: "Agent execution is not wired for this persisted source yet.",
      },
    });
    expect(model.nodes).toHaveLength(8);
    expect(model.relations).toHaveLength(7);
    expect(model.nodes.some((node) => node.id === HOME_MOVE_IDS.privateConstraint)).toBe(
      false,
    );
    expect(
      model.relations.some(
        (relation) =>
          relation.source === HOME_MOVE_IDS.privateConstraint ||
          relation.target === HOME_MOVE_IDS.privateConstraint,
      ),
    ).toBe(false);
    expect(model.nodes.map((node) => node.id)).toEqual(
      [...model.nodes.map((node) => node.id)].sort(),
    );
    expect(
      model.nodes.find((node) => node.id === HOME_MOVE_IDS.budget)?.parentId,
    ).toBe(HOME_MOVE_IDS.projectNode);
  });

  it("surfaces a durable placement attempt without an exchange as retryable evidence", () => {
    const attempt = durablePlacementAttempt();
    const state = reduceWorldstateLedger(attempt.ledger);
    const model = buildWorkbenchViewModel({
      ledger: attempt.ledger,
      state,
      runtimeFallback: { mode: "fixture", label: "Configured fixture manager" },
    });

    expect(model.placement).toMatchObject({
      state: "failed",
      sourceId: SOURCE_ID,
      sourceText: SOURCE_TEXT,
      sourceCapturedAt: SOURCE_TIME,
      errorCode: "placement_incomplete",
      errorMessage: "The persisted placement request has no matching manager exchange.",
      retryable: true,
      canAccept: false,
    });
    expect(model.placement.gateReason).toContain("can be retried");
    expect(model.events.find((event) => event.id === "event-workbench-attempt")).toEqual({
      id: "event-workbench-attempt",
      kind: "evidence",
      label: "Placement request persisted",
      detail:
        "Request request-workbench-view-model was durably recorded before manager dispatch.",
      time: ATTEMPT_TIME,
      worldstateId: HOME_MOVE_IDS.budget,
    });
  });

  it("overlays a persisted pending placement as Suggested without advancing the head", async () => {
    const attempt = await placementAttempt();
    const model = buildWorkbenchViewModel({
      ledger: attempt.ledger,
      state: attempt.state,
    });
    if (!attempt.response.ok || !attempt.response.delta) {
      throw new Error("Expected reviewable response.");
    }
    const candidateId = attempt.response.receipt.proposed.nodeId;
    const candidate = model.nodes.find((node) => node.id === candidateId);

    expect(model.revision).toBe(
      `Revision ${attempt.state.canonical.head.number} · ${attempt.state.canonical.head.id}`,
    );
    expect(attempt.state.canonical.head.id).toBe(attempt.request.baseRevisionId);
    expect(model.placement).toMatchObject({
      state: "reviewable",
      sourceId: SOURCE_ID,
      sourceText: SOURCE_TEXT,
      sourceCapturedAt: SOURCE_TIME,
      deltaId: attempt.response.delta.deltaId,
      candidateId,
      receiptId: attempt.response.receipt.receiptId,
      locationLabel: "Budget",
      affectedTitles: ["Budget"],
      managerLabel: "Fixture placement manager",
      canAccept: true,
    });
    expect(model.runtime).toEqual({
      mode: "fixture",
      label: "Deterministic fixture manager",
    });
    expect(candidate).toMatchObject({
      id: candidateId,
      parentId: HOME_MOVE_IDS.budget,
      status: {
        knowledge: "Draft",
        governance: "Suggested",
        work: "Planned",
      },
    });
    expect(
      model.relations.find((relation) => relation.source === candidateId),
    ).toMatchObject({ target: HOME_MOVE_IDS.budget, posture: "proposed" });
  });

  it("renders an accepted placement as canonical at the exact committed revision", async () => {
    const attempt = await placementAttempt();
    if (!attempt.kernelDelta || !attempt.response.ok) {
      throw new Error("Expected pending placement.");
    }
    const acceptedEvent = buildDeltaAcceptedEvent(attempt.state, {
      eventId: "event-workbench-accepted",
      commandId: "command-workbench-accepted",
      occurredAt: ACCEPT_TIME,
      actor: HOME_MOVE_ACTORS.human,
      deltaId: attempt.kernelDelta.id,
    });
    const ledger = append(attempt.ledger, acceptedEvent);
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });
    const candidateId = attempt.response.receipt.proposed.nodeId;

    expect(model.placement).toMatchObject({
      state: "adopted",
      canAccept: false,
      candidateId,
    });
    expect(model.nodes.find((node) => node.id === candidateId)).toMatchObject({
      eyebrow: "Task · Canonical",
      status: { governance: "Adopted" },
    });
    expect(
      model.relations.find((relation) => relation.source === candidateId),
    ).toMatchObject({ posture: "canonical" });
    expect(model.revision).toBe(`Revision ${state.canonical.head.number} · ${state.canonical.head.id}`);
    expect(model.events.at(-1)).toEqual({
      id: "event-workbench-accepted",
      kind: "revision",
      label: "Semantic update adopted",
      detail: `Revision ${state.canonical.head.number} · ${state.canonical.head.id} adopted ${attempt.kernelDelta.id}.`,
      time: ACCEPT_TIME,
      revision: state.canonical.head.id,
      worldstateId: candidateId,
    });
    expect(model.events.find((event) => event.id === "event-workbench-source")?.time).toBe(
      SOURCE_TIME,
    );
  });

  it("surfaces clarification and error exchanges without a committable overlay", async () => {
    const clarification = await placementAttempt((response) =>
      PlacementSuccessResponseSchema.parse({
        ...response,
        manager: {
          requestedMode: "live",
          effectiveMode: "live",
          status: "available",
          provider: "openai",
          model: "gpt-test",
          responseId: "response-test",
        },
        receipt: {
          ...response.receipt,
          decisionState: "needs_clarification",
          location: {
            targetNodeId: null,
            label: "Project area not resolved",
            breadcrumb: ["Plan our home move"],
          },
          clarificationQuestion: "Which project area should contain this task?",
        },
        delta: null,
      }),
    );
    const clarificationModel = buildWorkbenchViewModel({
      ledger: clarification.ledger,
      state: clarification.state,
    });

    expect(clarificationModel.placement).toMatchObject({
      state: "needs_clarification",
      clarificationQuestion: "Which project area should contain this task?",
      canAccept: false,
    });
    expect(clarificationModel.runtime).toEqual({
      mode: "live",
      label: "Live manager · OpenAI · gpt-test",
    });
    expect(
      clarificationModel.nodes.some(
        (node) => node.id === clarificationModel.placement.candidateId,
      ),
    ).toBe(false);

    const failure = await placementAttempt(
      () => invalidJsonPlacementResponse({ ODEU_MANAGER_MODE: "fixture" }).body,
    );
    const failureModel = buildWorkbenchViewModel({
      ledger: failure.ledger,
      state: failure.state,
    });
    expect(failureModel.placement).toMatchObject({
      state: "failed",
      errorCode: "invalid_json",
      canAccept: false,
      sourceId: SOURCE_ID,
      exchangeId: placementExchangeSourceId(failure.request.requestId),
    });
    expect(failureModel.runtime.mode).toBe("unavailable");
  });

  it("keeps a stale pending proposal visible but blocks semantic commit", async () => {
    const attempt = await placementAttempt();
    const advancingDelta: WorldstateDelta = {
      id: "delta-advance-after-placement",
      baseRevisionId: attempt.state.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "correction",
      proposedBy: HOME_MOVE_ACTORS.human,
      operations: [
        {
          op: "node.add",
          node: {
            id: "node-advance-after-placement",
            scopeId: HOME_MOVE_IDS.project,
            kind: "Idea",
            title: "Advance the canonical head",
            visibility: "shared",
            sourceRefs: [SOURCE_ID],
            data: {},
          },
        },
      ],
      rationale: ["Advance the head to exercise stale placement handling."],
      sourceRefs: [SOURCE_ID],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "A separate canonical idea advances the project head.",
    };
    let ledger = append(
      attempt.ledger,
      deltaProposedEvent({
        eventId: "event-advance-proposed",
        commandId: "command-advance-proposed",
        occurredAt: "2026-07-17T10:01:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta: advancingDelta },
      }),
    );
    const beforeAdvance = reduceWorldstateLedger(ledger);
    ledger = append(
      ledger,
      buildDeltaAcceptedEvent(beforeAdvance, {
        eventId: "event-advance-accepted",
        commandId: "command-advance-accepted",
        occurredAt: "2026-07-17T10:01:01.000Z",
        actor: HOME_MOVE_ACTORS.human,
        deltaId: advancingDelta.id,
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(model.placement).toMatchObject({ state: "stale", canAccept: false });
    expect(model.placement.gateReason).toContain(attempt.state.canonical.head.id);
    expect(model.placement.gateReason).toContain(state.canonical.head.id);
    expect(
      model.nodes.find((node) => node.id === model.placement.candidateId)?.status.governance,
    ).toBe("Suggested");
  });

  it("does not keep a deferred delta provisional or committable", async () => {
    const attempt = await placementAttempt();
    if (!attempt.kernelDelta) throw new Error("Expected pending placement.");
    const ledger = append(
      attempt.ledger,
      deltaDispositionEvent({
        type: "delta.deferred",
        eventId: "event-workbench-deferred",
        commandId: "command-workbench-deferred",
        occurredAt: "2026-07-17T10:00:04.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: {
          deltaId: attempt.kernelDelta.id,
          baseRevisionId: attempt.kernelDelta.baseRevisionId,
          reason: "Wait for an updated provider list.",
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(model.placement).toMatchObject({
      state: "failed",
      errorCode: "delta_deferred",
      canAccept: false,
    });
    expect(model.nodes.some((node) => node.id === model.placement.candidateId)).toBe(false);
  });

  it("lets a later persisted failure block the receipt without erasing responded runtime truth", async () => {
    const attempt = await placementAttempt();
    const ledger = append(
      attempt.ledger,
      createLedgerEvent({
        type: "manager.failure_recorded",
        eventId: "event-workbench-retry-failed",
        commandId: "command-workbench-retry-failed",
        occurredAt: "2026-07-17T10:02:00.000Z",
        actor: HOME_MOVE_ACTORS.manager,
        payload: {
          sourceId: SOURCE_ID,
          code: "network_retry_failed",
          message: "The retry could not reach the placement manager.",
          retriable: true,
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(model.placement).toMatchObject({
      state: "failed",
      sourceId: SOURCE_ID,
      errorCode: "network_retry_failed",
      retryable: true,
      canAccept: false,
      exchangeId: placementExchangeSourceId(attempt.request.requestId),
    });
    expect(model.runtime).toEqual({
      mode: "fixture",
      label: "Deterministic fixture manager",
    });
    expect(model.nodes.some((node) => node.id === model.placement.candidateId)).toBe(false);

    const nextSourceId = "source-workbench-next-attempt";
    const nextLedger = append(
      ledger,
      sourceCapturedEvent({
        eventId: "event-workbench-next-source",
        commandId: "command-workbench-next-source",
        occurredAt: "2026-07-17T10:03:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: {
          source: {
            id: nextSourceId,
            kind: "text",
            content: "Add a packing checklist.",
            visibility: "shared",
          },
        },
      }),
    );
    const nextModel = buildWorkbenchViewModel({
      ledger: nextLedger,
      state: reduceWorldstateLedger(nextLedger),
    });
    expect(nextModel.placement).toMatchObject({
      state: "idle",
      sourceId: nextSourceId,
      sourceText: "Add a packing checklist.",
      canAccept: false,
    });
    expect(nextModel.runtime.mode).toBe("fixture");
  });

  it("retains failed live-provider metadata after its failure event is recorded", async () => {
    const attempt = await placementAttempt(() =>
      PlacementErrorResponseSchema.parse({
        ok: false,
        manager: {
          requestedMode: "live",
          effectiveMode: "live",
          status: "failed",
          provider: "openai",
          model: "gpt-live-test",
          responseId: "response-live-test",
        },
        sourcePreserved: true,
        error: {
          code: "provider_request_failed",
          message: "The live provider did not complete the request.",
          retryable: true,
          issues: [],
        },
      }),
    );
    const ledger = append(
      attempt.ledger,
      createLedgerEvent({
        type: "manager.failure_recorded",
        eventId: "event-workbench-live-failure",
        commandId: "command-workbench-live-failure",
        occurredAt: "2026-07-17T10:02:00.000Z",
        actor: HOME_MOVE_ACTORS.manager,
        payload: {
          sourceId: SOURCE_ID,
          code: "provider_request_failed",
          message: "The live provider did not complete the request.",
          retriable: true,
        },
      }),
    );
    const model = buildWorkbenchViewModel({
      ledger,
      state: reduceWorldstateLedger(ledger),
    });

    expect(model.placement).toMatchObject({
      state: "failed",
      errorCode: "provider_request_failed",
      retryable: true,
    });
    expect(model.runtime).toEqual({
      mode: "live",
      label: "Live manager failed · OpenAI · gpt-live-test",
    });
    expect(model.placement.managerLabel).toBe(
      "Live manager failed · OpenAI · gpt-live-test",
    );
  });
});
