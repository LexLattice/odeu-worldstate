import { describe, expect, it } from "vitest";

import {
  appendLedgerEvent,
  briefCompiledEvent,
  buildDeltaAcceptedEvent,
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
} from "@/fixtures";
import { runCodexReplay } from "@/adapters/codex/replay";

import {
  AcceptedPlacementBriefError,
  compileAcceptedPlacementAgentBrief,
} from "./accepted-placement-to-agent-brief";
import { domainBriefToCodexRunRequest } from "./domain-brief-to-codex";

const SOURCE_ID = "source-runtime-moving-tool";
const TASK_ID = "candidate-runtime-7f92";

function append(ledger: WorldstateLedger, event: Parameters<typeof appendLedgerEvent>[1]) {
  return appendLedgerEvent(ledger, event).ledger;
}

function acceptedDynamicTask(
  ledger: WorldstateLedger = createHomeMoveSeedFixture().ledger,
  input: {
    readonly taskId?: string;
    readonly suffix?: string;
    readonly uncertainty?: readonly string[];
    readonly title?: string;
    readonly description?: string;
  } = {},
): WorldstateLedger {
  const suffix = input.suffix ?? "runtime";
  const sourceId = suffix === "runtime" ? SOURCE_ID : `${SOURCE_ID}-${suffix}`;
  const taskId = input.taskId ?? TASK_ID;
  const sourceEvent = sourceCapturedEvent({
    eventId: `event-source-${suffix}`,
    commandId: `command-source-${suffix}`,
    occurredAt: "2026-07-17T13:00:00.000Z",
    actor: HOME_MOVE_ACTORS.human,
    payload: {
      source: {
        id: sourceId,
        kind: "text",
        content: "Ask Codex to add a moving-cost comparison tool.",
        visibility: "shared",
      },
    },
  });
  ledger = append(ledger, sourceEvent);
  const state = reduceWorldstateLedger(ledger);
  const delta: WorldstateDelta = {
    id: `delta-dynamic-task-${suffix}`,
    baseRevisionId: state.canonical.head.id,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "placement",
    proposedBy: HOME_MOVE_ACTORS.manager,
    operations: [
      {
        op: "node.add",
        node: {
          id: taskId,
          scopeId: HOME_MOVE_IDS.project,
          kind: "Task",
          title: input.title ?? "Compare provider quotes",
          description:
            input.description ??
            "Create a small comparison tool for moving-provider costs and return focused implementation evidence.",
          visibility: "shared",
          knowledge: { standing: "draft", freshness: "current" },
          governance: { standing: "adopted", approval: "granted" },
          work: { phase: "planned", verification: "unverified" },
          sourceRefs: [sourceId],
          data: { managerOperationId: `operation-${suffix}-1` },
        },
      },
      {
        op: "relation.add",
        relation: {
          id: `relation-dynamic-task-${suffix}`,
          scopeId: HOME_MOVE_IDS.project,
          kind: "belongs_to",
          fromNodeId: taskId,
          toNodeId: HOME_MOVE_IDS.budget,
          sourceRefs: [sourceId],
          data: {},
        },
      },
    ],
    rationale: ["The comparison task belongs in the accepted Budget area."],
    sourceRefs: [sourceId],
    uncertainty: [
      ...(input.uncertainty ?? ["Recurring storage costs may need a separate comparison."]),
    ],
    alternatives: ["Keep the task at project level."],
    conflicts: [],
    visibleConsequence: "Budget gains a provider-quote comparison task.",
  };
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: `event-delta-proposed-${suffix}`,
      commandId: `command-delta-proposed-${suffix}`,
      occurredAt: "2026-07-17T13:00:01.000Z",
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta },
    }),
  );
  const proposed = reduceWorldstateLedger(ledger);
  return append(
    ledger,
    buildDeltaAcceptedEvent(proposed, {
      eventId: `event-delta-accepted-${suffix}`,
      commandId: `command-delta-accepted-${suffix}`,
      occurredAt: "2026-07-17T13:00:02.000Z",
      actor: HOME_MOVE_ACTORS.human,
      deltaId: delta.id,
    }),
  );
}

describe("compileAcceptedPlacementAgentBrief", () => {
  it("compiles the current dynamic Task without relying on fixture Task IDs", () => {
    const ledger = acceptedDynamicTask();
    const state = reduceWorldstateLedger(ledger);
    const brief = compileAcceptedPlacementAgentBrief(state, {
      briefId: "brief-runtime-moving-tool",
      artifactBaseRef: "git:demo-base-001",
    });

    expect(brief.targetNodeId).toBe(TASK_ID);
    expect(brief.targetNodeId).not.toBe(HOME_MOVE_IDS.compareQuotes);
    expect(brief.baseRevisionId).toBe(state.canonical.head.id);
    expect(brief.sharedNodes.map((node) => node.id)).toEqual([
      HOME_MOVE_IDS.projectNode,
      HOME_MOVE_IDS.goal,
      HOME_MOVE_IDS.artifact,
      HOME_MOVE_IDS.budget,
      TASK_ID,
    ]);
    expect(brief.goal).toBe(
      "Add a simple moving-cost comparison tool to the demo planning page.",
    );
    expect(brief.unknowns).toEqual([
      "Recurring storage costs may need a separate comparison.",
    ]);
    expect(brief.constraints).toEqual([]);
    expect(brief.expectedArtifacts).toEqual(["demo/moving-costs.html"]);
    expect(brief.evidenceContract).toEqual({
      requirements: [
        {
          id: "requirement-focused-tests",
          label: "Focused moving-cost calculation tests pass",
          kind: "test",
          command: "npm test -- moving-cost",
          required: true,
        },
        {
          id: "requirement-artifact-change",
          label: "The planning-page artifact change is addressable",
          kind: "artifact",
          command: null,
          required: true,
        },
      ],
      policy: { blockIntegration: true },
    });
    expect(brief.omittedContext).toContainEqual({
      nodeId: HOME_MOVE_IDS.privateConstraint,
      title: "Keep the new address private until the lease is signed",
      reason: "private",
    });
    expect(brief.sharedNodes).not.toContainEqual(
      expect.objectContaining({ id: HOME_MOVE_IDS.privateConstraint }),
    );

    const withBrief = append(
      ledger,
      briefCompiledEvent({
        eventId: "event-runtime-brief-compiled",
        commandId: "command-runtime-brief-compiled",
        occurredAt: "2026-07-17T13:00:03.000Z",
        actor: HOME_MOVE_ACTORS.manager,
        payload: { brief },
      }),
    );
    const reduced = reduceWorldstateLedger(withBrief);
    expect(reduced.operational.briefs[brief.id]).toEqual(brief);
    expect(reduced.canonical.head.id).toBe(state.canonical.head.id);
  });

  it("matches the explicit browser-placement replay contract", () => {
    const state = reduceWorldstateLedger(acceptedDynamicTask());
    const brief = compileAcceptedPlacementAgentBrief(state, {
      briefId: "brief-browser-moving-tool",
      artifactBaseRef: "git:demo-base-001",
    });
    const request = domainBriefToCodexRunRequest(
      brief,
      "run-browser-moving-tool",
      "replay",
      "request-browser-moving-tool",
    );

    expect(runCodexReplay(request).closure).toMatchObject({
      runId: "run-browser-moving-tool",
      briefId: "brief-browser-moving-tool",
      sourceRevisionIdUsed: state.canonical.head.id,
      artifactBaseRefUsed: "git:demo-base-001",
    });
  });

  it("chooses the latest accepted active Task from revision history", () => {
    let ledger = acceptedDynamicTask();
    ledger = acceptedDynamicTask(ledger, {
      taskId: "candidate-runtime-later",
      suffix: "later",
      uncertainty: ["The later task has its own unresolved choice."],
    });
    const brief = compileAcceptedPlacementAgentBrief(reduceWorldstateLedger(ledger), {
      briefId: "brief-latest-runtime-task",
      artifactBaseRef: "git:demo-base-002",
    });

    expect(brief.targetNodeId).toBe("candidate-runtime-later");
    expect(brief.unknowns).toEqual(["The later task has its own unresolved choice."]);
  });

  it("fails closed when no accepted active Task exists", () => {
    expect(() =>
      compileAcceptedPlacementAgentBrief(createHomeMoveSeedFixture().state, {
        briefId: "brief-without-task",
        artifactBaseRef: "git:demo-base-001",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AcceptedPlacementBriefError>>({
        name: "AcceptedPlacementBriefError",
        code: "accepted_task_missing",
      }),
    );
  });

  it("fails closed before compiling an authored replay brief around an unrelated Task", () => {
    const state = reduceWorldstateLedger(
      acceptedDynamicTask(createHomeMoveSeedFixture().ledger, {
        taskId: "candidate-packing-checklist",
        suffix: "packing",
        title: "Add a packing checklist",
        description: "Create a reusable checklist for packing rooms.",
      }),
    );

    expect(() =>
      compileAcceptedPlacementAgentBrief(state, {
        briefId: "brief-unrelated-task",
        artifactBaseRef: "git:demo-base-001",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AcceptedPlacementBriefError>>({
        name: "AcceptedPlacementBriefError",
        code: "accepted_task_unsupported",
      }),
    );
    expect(Object.keys(state.operational.briefs)).toHaveLength(0);
  });
});
