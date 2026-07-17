import { describe, expect, it } from "vitest";

import { PlacementRequestSchema } from "@/adapters/manager/schema";
import {
  appendLedgerEvent,
  buildDeltaAcceptedEvent,
  deltaProposedEvent,
  reduceWorldstateLedger,
  sourceCapturedEvent,
  type WorldstateDelta,
  type WorldstateLedger,
  type WorldstateState,
} from "@/domain";
import {
  createHomeMoveSeedFixture,
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
} from "@/fixtures/home-move";

import {
  compilePlacementRequest,
  PlacementRequestCompilationError,
} from "./worldstate-to-placement";

const SOURCE_ID = "source-placement-input";
const SOURCE_TEXT =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";

function stateWithSource(visibility: "shared" | "private" = "shared"): {
  ledger: WorldstateLedger;
  state: WorldstateState;
} {
  const seed = createHomeMoveSeedFixture();
  const ledger = appendLedgerEvent(
    seed.ledger,
    sourceCapturedEvent({
      eventId: `event-placement-input-${visibility}`,
      commandId: `command-placement-input-${visibility}`,
      occurredAt: "2026-07-17T09:00:00.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: SOURCE_ID,
          kind: "text",
          content: SOURCE_TEXT,
          visibility,
        },
      },
    }),
  ).ledger;

  return { ledger, state: reduceWorldstateLedger(ledger) };
}

function compile(state: WorldstateState) {
  return compilePlacementRequest({
    state,
    sourceId: SOURCE_ID,
    requestId: "request-placement-input",
    scopeId: HOME_MOVE_IDS.project,
    projectId: HOME_MOVE_IDS.projectNode,
    selectedNodeId: HOME_MOVE_IDS.budget,
  });
}

describe("compilePlacementRequest", () => {
  it("binds the captured source and current head in a valid placement request", () => {
    const { state } = stateWithSource();

    const request = compile(state);

    expect(PlacementRequestSchema.parse(request)).toEqual(request);
    expect(request).toMatchObject({
      requestId: "request-placement-input",
      source: { sourceId: SOURCE_ID, text: SOURCE_TEXT },
      baseRevisionId: state.canonical.head.id,
      projection: {
        scopeId: HOME_MOVE_IDS.project,
        projectId: HOME_MOVE_IDS.projectNode,
        selectedNodeId: HOME_MOVE_IDS.budget,
      },
    });
  });

  it("projects only active shared nodes and relations between included endpoints", () => {
    const { state } = stateWithSource();

    const request = compile(state);
    const nodeIds = new Set(request.projection.nodes.map((node) => node.id));

    expect(request.projection.nodes).toHaveLength(8);
    expect(request.projection.nodes.every((node) => node.visibility === "shared")).toBe(
      true,
    );
    expect(nodeIds.has(HOME_MOVE_IDS.privateConstraint)).toBe(false);
    expect(request.projection.relations).toHaveLength(7);
    expect(
      request.projection.relations.every(
        (relation) =>
          nodeIds.has(relation.fromNodeId) && nodeIds.has(relation.toNodeId),
      ),
    ).toBe(true);
    expect(
      request.projection.relations.some(
        (relation) =>
          relation.fromNodeId === HOME_MOVE_IDS.privateConstraint ||
          relation.toNodeId === HOME_MOVE_IDS.privateConstraint,
      ),
    ).toBe(false);
  });

  it("preserves domain IDs and kinds without translating the canonical records", () => {
    const { state } = stateWithSource();

    const request = compile(state);

    expect(
      request.projection.nodes.find((node) => node.id === HOME_MOVE_IDS.projectNode),
    ).toEqual({
      id: HOME_MOVE_IDS.projectNode,
      kind: "Project",
      title: "Plan our home move",
      summary: null,
      scopeId: HOME_MOVE_IDS.project,
      visibility: "shared",
    });
    expect(
      request.projection.relations.find(
        (relation) => relation.fromNodeId === HOME_MOVE_IDS.goal,
      ),
    ).toEqual({
      id: `relation-${HOME_MOVE_IDS.goal}-belongs-home-move`,
      kind: "belongs_to",
      fromNodeId: HOME_MOVE_IDS.goal,
      toNodeId: HOME_MOVE_IDS.projectNode,
    });
  });

  it("omits retired canonical records and binds the advanced revision", () => {
    const { ledger: sourceLedger } = stateWithSource();
    const sourceState = reduceWorldstateLedger(sourceLedger);
    const providerRelationId = `relation-${HOME_MOVE_IDS.providers}-belongs-home-move`;
    const retirement: WorldstateDelta = {
      id: "delta-retire-providers-for-placement-test",
      baseRevisionId: sourceState.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "correction",
      proposedBy: HOME_MOVE_ACTORS.human,
      operations: [
        { op: "relation.retire", relationId: providerRelationId },
        { op: "node.retire", nodeId: HOME_MOVE_IDS.providers },
      ],
      rationale: ["Retire a completed provider area."],
      sourceRefs: [SOURCE_ID],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "The provider area leaves the active projection.",
    };
    let ledger = appendLedgerEvent(
      sourceLedger,
      deltaProposedEvent({
        eventId: "event-retire-providers-proposed",
        commandId: "command-retire-providers-proposed",
        occurredAt: "2026-07-17T09:01:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta: retirement },
      }),
    ).ledger;
    const proposedState = reduceWorldstateLedger(ledger);
    ledger = appendLedgerEvent(
      ledger,
      buildDeltaAcceptedEvent(proposedState, {
        eventId: "event-retire-providers-accepted",
        commandId: "command-retire-providers-accepted",
        occurredAt: "2026-07-17T09:02:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        deltaId: retirement.id,
      }),
    ).ledger;
    const state = reduceWorldstateLedger(ledger);

    const request = compile(state);

    expect(request.baseRevisionId).toBe(state.canonical.head.id);
    expect(request.baseRevisionId).not.toBe(sourceState.canonical.head.id);
    expect(
      request.projection.nodes.some((node) => node.id === HOME_MOVE_IDS.providers),
    ).toBe(false);
    expect(
      request.projection.relations.some((relation) => relation.id === providerRelationId),
    ).toBe(false);
  });

  it("fails closed when the source is missing or private", () => {
    const seed = createHomeMoveSeedFixture();

    expect(() => compile(seed.state)).toThrowError(
      expect.objectContaining<Partial<PlacementRequestCompilationError>>({
        code: "source_missing",
      }),
    );
    expect(() => compile(stateWithSource("private").state)).toThrowError(
      expect.objectContaining<Partial<PlacementRequestCompilationError>>({
        code: "source_private",
      }),
    );
  });

  it("rejects a project or selection that is absent from the shared projection", () => {
    const { state } = stateWithSource();

    expect(() =>
      compilePlacementRequest({
        state,
        sourceId: SOURCE_ID,
        requestId: "request-private-selection",
        scopeId: HOME_MOVE_IDS.project,
        projectId: HOME_MOVE_IDS.projectNode,
        selectedNodeId: HOME_MOVE_IDS.privateConstraint,
      }),
    ).toThrow(/selectedNodeId must name a node in the bounded projection/);
  });
});
