import { describe, expect, it } from "vitest";

import { LedgerCorruptionError } from "./contracts";
import {
  createMemoryWorldstateLedgerStore,
  parseWorldstateLedgerDocument,
  validateWorldstateLedgerDocument,
  worldstateStateFromLedgerDocument,
  worldstateLedgerDocument,
} from "./worldstate";
import { createHappyPlacementFixture } from "@/fixtures";
import {
  LedgerEventSchema,
  appendLedgerEvent,
  buildDeltaAcceptedEvent,
  createWorldstateLedger,
  deltaProposedEvent,
  reduceWorldstateLedger,
  type WorldstateDelta,
} from "@/domain";

describe("worldstate ledger persistence", () => {
  it("round-trips a reduced ledger with a matching declared head", async () => {
    const fixture = createHappyPlacementFixture();
    const document = worldstateLedgerDocument({
      ledger: fixture.ledger,
      projectLabel: "Plan our home move",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });
    const store = createMemoryWorldstateLedgerStore();
    await store.put(document, null);

    expect(await store.get(document.projectId)).toEqual(document);
  });

  it("rejects a claimed head that does not match deterministic reduction", () => {
    const fixture = createHappyPlacementFixture();
    const document = worldstateLedgerDocument({
      ledger: fixture.ledger,
      projectLabel: "Plan our home move",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });

    expect(() =>
      validateWorldstateLedgerDocument({
        ...document,
        headRevisionId: "rev-tampered",
      }),
    ).toThrow(LedgerCorruptionError);
  });

  it("rejects a schema-valid but fabricated genesis identity", () => {
    const ledger = createWorldstateLedger({
      projectId: "project-fabricated-genesis",
      createdAt: "2026-07-16T10:00:00.000Z",
    });
    const document = worldstateLedgerDocument({
      ledger,
      projectLabel: "Fabricated genesis check",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });
    const fabricatedGenesis = {
      ...ledger.genesisRevision,
      id: "rev-0000-fabricated",
    };

    expect(() =>
      validateWorldstateLedgerDocument({
        ...document,
        headRevisionId: fabricatedGenesis.id,
        metadata: { genesisRevision: fabricatedGenesis },
      }),
    ).toThrowError(/non-deterministic genesis revision/);
  });

  it("rejects fabricated genesis invariants even when the declared head agrees", () => {
    const ledger = createWorldstateLedger({
      projectId: "project-invalid-genesis-invariants",
      createdAt: "2026-07-16T10:00:00.000Z",
    });
    const document = worldstateLedgerDocument({
      ledger,
      projectLabel: "Genesis invariant check",
      updatedAt: "2026-07-16T10:00:00.000Z",
    });
    const fabricatedGenesis = {
      ...ledger.genesisRevision,
      number: 4,
    };

    expect(() =>
      validateWorldstateLedgerDocument({
        ...document,
        metadata: { genesisRevision: fabricatedGenesis },
      }),
    ).toThrow(LedgerCorruptionError);
  });

  it("loads a format-v1 ledger whose historical brief has no profile binding", () => {
    const actor = {
      id: "actor-legacy-owner",
      kind: "human" as const,
      label: "Legacy owner",
    };
    let ledger = createWorldstateLedger({
      projectId: "project-legacy-unbound",
      createdAt: "2026-07-16T08:00:00.000Z",
    });
    const delta: WorldstateDelta = {
      id: "delta-legacy-unbound-task",
      baseRevisionId: ledger.genesisRevision.id,
      scopeId: ledger.projectId,
      purpose: "placement",
      proposedBy: actor,
      operations: [
        {
          op: "node.add",
          node: {
            id: "node-legacy-project",
            scopeId: ledger.projectId,
            kind: "Project",
            title: "Legacy project",
            visibility: "shared",
            sourceRefs: [],
            data: {},
          },
        },
        {
          op: "node.add",
          node: {
            id: "node-legacy-task",
            scopeId: ledger.projectId,
            kind: "Task",
            title: "Legacy task",
            visibility: "shared",
            sourceRefs: [],
            data: {},
          },
        },
        {
          op: "relation.add",
          relation: {
            id: "relation-legacy-task-project",
            scopeId: ledger.projectId,
            kind: "belongs_to",
            fromNodeId: "node-legacy-task",
            toNodeId: "node-legacy-project",
            sourceRefs: [],
            data: {},
          },
        },
      ],
      rationale: ["Reconstruct a pre-profile format-v1 history."],
      sourceRefs: [],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "A legacy task is placed.",
    };
    ledger = appendLedgerEvent(
      ledger,
      deltaProposedEvent({
        eventId: "event-legacy-delta-proposed",
        commandId: "command-legacy-delta-proposed",
        occurredAt: "2026-07-16T08:00:01.000Z",
        actor,
        payload: { delta },
      }),
    ).ledger;
    ledger = appendLedgerEvent(
      ledger,
      buildDeltaAcceptedEvent(reduceWorldstateLedger(ledger), {
        eventId: "event-legacy-delta-accepted",
        commandId: "command-legacy-delta-accepted",
        occurredAt: "2026-07-16T08:00:02.000Z",
        actor,
        deltaId: delta.id,
      }),
    ).ledger;
    const accepted = reduceWorldstateLedger(ledger);
    const legacyBriefEvent = LedgerEventSchema.parse({
      eventId: "event-legacy-brief-compiled",
      commandId: "command-legacy-brief-compiled",
      occurredAt: "2026-07-16T08:00:03.000Z",
      actor,
      type: "brief.compiled",
      payload: {
        brief: {
          id: "brief-legacy-unbound",
          baseRevisionId: accepted.canonical.head.id,
          artifactBaseRef: "git:legacy-base",
          targetNodeId: "node-legacy-task",
          goal: "Preserve a historical task record.",
          doneMeans: ["The historical record remains inspectable."],
          sharedNodes: Object.values(accepted.canonical.nodes),
          sharedRelations: Object.values(accepted.canonical.relations),
          omittedContext: [],
          environment: "Historical environment",
          agentProfile: "Historical agent",
          allowedActions: ["Inspect the historical record"],
          deniedActions: ["Execute the legacy brief"],
          evidenceContract: {
            requirements: [
              {
                id: "requirement-legacy-record",
                label: "Historical record is intact",
                kind: "review",
                required: true,
              },
            ],
            policy: { blockIntegration: true },
          },
          escalationPath: "Recompile under a registered profile.",
        },
      },
    });
    ledger = appendLedgerEvent(ledger, legacyBriefEvent).ledger;
    const document = worldstateLedgerDocument({
      ledger,
      projectLabel: "Legacy unbound project",
      updatedAt: "2026-07-16T08:00:04.000Z",
    });
    const persisted = structuredClone(document) as typeof document;
    const persistedBrief = persisted.events.find(
      (event) => event.type === "brief.compiled",
    );
    if (!persistedBrief || persistedBrief.type !== "brief.compiled") {
      throw new Error("Expected the historical brief event.");
    }
    delete (persistedBrief.payload.brief as { delegationProfileId?: unknown })
      .delegationProfileId;

    const parsed = parseWorldstateLedgerDocument(persisted);
    const parsedBrief = parsed.events.find(
      (event) => event.type === "brief.compiled",
    );
    expect(
      parsedBrief?.type === "brief.compiled"
        ? parsedBrief.payload.brief.delegationProfileId
        : undefined,
    ).toBeNull();
    expect(
      worldstateStateFromLedgerDocument(persisted).operational.briefs[
        "brief-legacy-unbound"
      ]?.delegationProfileId,
    ).toBeNull();
  });
});
