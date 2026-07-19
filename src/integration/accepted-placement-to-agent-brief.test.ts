import { describe, expect, it } from "vitest";

import {
  appendLedgerEvent,
  briefCompiledEvent,
  buildDeltaAcceptedEvent,
  deltaProposedEvent,
  MOVING_COST_DELEGATION_PROFILE,
  MOVING_COST_DELEGATION_PROFILE_ID,
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
    readonly delegationProfileId?: typeof MOVING_COST_DELEGATION_PROFILE_ID | null;
    readonly parentId?: string;
    readonly convergentParentPath?: boolean;
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
          ...(input.delegationProfileId === null
            ? {}
            : {
                delegationProfileId:
                  input.delegationProfileId ??
                  MOVING_COST_DELEGATION_PROFILE_ID,
              }),
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
          toNodeId: input.parentId ?? HOME_MOVE_IDS.budget,
          sourceRefs: [sourceId],
          data: {},
        },
      },
      ...(input.convergentParentPath
        ? ([
            {
              op: "node.add" as const,
              node: {
                id: `node-convergent-parent-${suffix}`,
                scopeId: HOME_MOVE_IDS.project,
                kind: "Idea" as const,
                title: "Convergent Budget sub-area",
                visibility: "shared" as const,
                sourceRefs: [sourceId],
                data: {},
              },
            },
            {
              op: "relation.add" as const,
              relation: {
                id: `relation-task-convergent-parent-${suffix}`,
                scopeId: HOME_MOVE_IDS.project,
                kind: "belongs_to" as const,
                fromNodeId: taskId,
                toNodeId: `node-convergent-parent-${suffix}`,
                sourceRefs: [sourceId],
                data: {},
              },
            },
            {
              op: "relation.add" as const,
              relation: {
                id: `relation-convergent-parent-budget-${suffix}`,
                scopeId: HOME_MOVE_IDS.project,
                kind: "belongs_to" as const,
                fromNodeId: `node-convergent-parent-${suffix}`,
                toNodeId: HOME_MOVE_IDS.budget,
                sourceRefs: [sourceId],
                data: {},
              },
            },
          ])
        : []),
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
    expect(MOVING_COST_DELEGATION_PROFILE).toMatchObject({
      expectedProjectId: HOME_MOVE_IDS.projectNode,
      expectedAncestorId: HOME_MOVE_IDS.budget,
      expectedGoalId: HOME_MOVE_IDS.goal,
      expectedArtifactId: HOME_MOVE_IDS.artifact,
    });
    expect(brief.baseRevisionId).toBe(state.canonical.head.id);
    expect(brief.delegationProfileId).toBe(
      MOVING_COST_DELEGATION_PROFILE_ID,
    );
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
    expect(brief.constraints).toEqual([
      "demo/moving-costs.html must import ./moving-costs.mjs exactly once, and demo/moving-costs.mjs must export calculateMovingTotalCents for independent fixed-vector verification.",
    ]);
    expect(brief.expectedArtifacts).toEqual(["demo/moving-costs.html"]);
    expect(brief.allowedActions).toEqual([
      "Read files inside the disposable demo workspace",
      "Edit only demo/moving-costs.html and demo/moving-costs.mjs",
      "Run the declared focused test command",
    ]);
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

  it("binds the registered profile independently of editable title and description prose", () => {
    const state = reduceWorldstateLedger(
      acceptedDynamicTask(createHomeMoveSeedFixture().ledger, {
        taskId: "candidate-renamed-moving-cost-task",
        suffix: "renamed",
        title: "Build a quote totaler",
        description:
          "A human-edited description that no longer matches the fixture wording.",
      }),
    );

    const brief = compileAcceptedPlacementAgentBrief(state, {
      briefId: "brief-renamed-moving-cost-task",
      artifactBaseRef: "git:demo-base-001",
    });

    expect(brief.targetNodeId).toBe("candidate-renamed-moving-cost-task");
    expect(brief.delegationProfileId).toBe(
      MOVING_COST_DELEGATION_PROFILE_ID,
    );
  });

  it("rejects a proposed profile whose accepted Task is outside its registered topology", () => {
    const state = reduceWorldstateLedger(
      acceptedDynamicTask(createHomeMoveSeedFixture().ledger, {
        taskId: "candidate-moving-cost-in-packing",
        suffix: "wrong-topology",
        parentId: HOME_MOVE_IDS.packing,
      }),
    );

    expect(() =>
      compileAcceptedPlacementAgentBrief(state, {
        briefId: "brief-wrong-moving-cost-topology",
        artifactBaseRef: "git:demo-base-001",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AcceptedPlacementBriefError>>({
        name: "AcceptedPlacementBriefError",
        code: "accepted_task_topology_unsupported",
      }),
    );
  });

  it("rejects convergent topology when two distinct ancestor paths reach one Project", () => {
    const state = reduceWorldstateLedger(
      acceptedDynamicTask(createHomeMoveSeedFixture().ledger, {
        taskId: "candidate-moving-cost-convergent",
        suffix: "convergent",
        convergentParentPath: true,
      }),
    );

    expect(() =>
      compileAcceptedPlacementAgentBrief(state, {
        briefId: "brief-convergent-moving-cost-topology",
        artifactBaseRef: "git:demo-base-001",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AcceptedPlacementBriefError>>({
        name: "AcceptedPlacementBriefError",
        code: "project_ambiguous",
      }),
    );
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
        delegationProfileId: null,
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
