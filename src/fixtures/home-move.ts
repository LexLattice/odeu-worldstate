import {
  appendLedgerEvent,
  briefCompiledEvent,
  buildDeltaAcceptedEvent,
  closureStagedEvent,
  compileAgentBrief,
  deltaDispositionEvent,
  deltaProposedEvent,
  evidenceValidationEvent,
  projectAgentBrief,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  runLifecycleEvent,
  sourceCapturedEvent,
  createWorldstateLedger,
  type Actor,
  type AgentBrief,
  type AgentBriefPayload,
  type LedgerEventOf,
  type WorldstateDelta,
  type WorldstateLedger,
  type WorldstateNodeInput,
  type WorldstateState,
} from "@/domain";

export const HOME_MOVE_IDS = {
  project: "project-home-move",
  projectNode: "node-project-home-move",
  goal: "node-goal-under-4000",
  schedule: "node-area-schedule",
  budget: "node-area-budget",
  providers: "node-area-providers",
  packing: "node-area-packing",
  artifact: "node-artifact-planning-page",
  adoptedDecision: "node-decision-three-quotes",
  privateConstraint: "node-private-new-address",
  source: "source-moving-cost-tool",
  compareQuotes: "node-compare-provider-quotes",
  storageQuestion: "node-storage-cost-question",
  resultEvidence: "node-evidence-cost-tool-tests",
  brief: "brief-moving-cost-tool",
  run: "run-moving-cost-tool",
  closure: "closure-moving-cost-tool",
} as const;

export const HOME_MOVE_ACTORS = {
  human: { id: "actor-human-demo", kind: "human", label: "Demo owner" },
  manager: { id: "actor-manager-gpt", kind: "manager", label: "Worldstate Manager" },
  codex: { id: "actor-codex", kind: "agent", label: "Codex" },
  system: { id: "actor-kernel", kind: "system", label: "Worldstate kernel" },
} satisfies Readonly<Record<string, Actor>>;

const T = {
  genesis: "2026-07-16T09:00:00.000Z",
  seedProposal: "2026-07-16T09:00:01.000Z",
  seedCommit: "2026-07-16T09:00:02.000Z",
  source: "2026-07-16T09:01:00.000Z",
  proposal: "2026-07-16T09:01:01.000Z",
  disposition: "2026-07-16T09:01:02.000Z",
  commit: "2026-07-16T09:01:03.000Z",
  brief: "2026-07-16T09:02:00.000Z",
  authorize: "2026-07-16T09:02:01.000Z",
  received: "2026-07-16T09:02:02.000Z",
  working: "2026-07-16T09:02:03.000Z",
  returned: "2026-07-16T09:02:04.000Z",
  closure: "2026-07-16T09:02:05.000Z",
  validation: "2026-07-16T09:02:06.000Z",
  reconciliationProposal: "2026-07-16T09:03:00.000Z",
  reconciliationCommit: "2026-07-16T09:03:01.000Z",
  compensationProposal: "2026-07-16T09:04:00.000Z",
  compensationCommit: "2026-07-16T09:04:01.000Z",
} as const;

export interface HomeMoveFixture {
  readonly ledger: WorldstateLedger;
  readonly state: WorldstateState;
  readonly ids: typeof HOME_MOVE_IDS;
}

function append(
  ledger: WorldstateLedger,
  event: Parameters<typeof appendLedgerEvent>[1],
): WorldstateLedger {
  return appendLedgerEvent(ledger, event).ledger;
}

function accepted(
  ledger: WorldstateLedger,
  input: {
    eventId: string;
    commandId: string;
    occurredAt: string;
    deltaId: string;
    actor?: Actor;
    artifactBaseRef?: string;
  },
): WorldstateLedger {
  const state = reduceWorldstateLedger(ledger);
  const event = buildDeltaAcceptedEvent(state, {
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor ?? HOME_MOVE_ACTORS.human,
    deltaId: input.deltaId,
    ...(input.artifactBaseRef ? { artifactBaseRef: input.artifactBaseRef } : {}),
  });
  return append(ledger, event);
}

function baseNode(
  id: string,
  kind: WorldstateNodeInput["kind"],
  title: string,
  overrides: Partial<WorldstateNodeInput> = {},
): WorldstateNodeInput {
  return {
    id,
    scopeId: HOME_MOVE_IDS.project,
    kind,
    title,
    visibility: "shared",
    sourceRefs: [],
    data: {},
    ...overrides,
  };
}

function fixture(ledger: WorldstateLedger): HomeMoveFixture {
  return { ledger, state: reduceWorldstateLedger(ledger), ids: HOME_MOVE_IDS };
}

export function createHomeMoveSeedFixture(): HomeMoveFixture {
  let ledger = createWorldstateLedger({
    projectId: HOME_MOVE_IDS.project,
    createdAt: T.genesis,
  });

  const seedDelta: WorldstateDelta = {
    id: "delta-home-move-seed",
    baseRevisionId: ledger.genesisRevision.id,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "placement",
    proposedBy: HOME_MOVE_ACTORS.system,
    operations: [
      {
        op: "node.add",
        node: baseNode(HOME_MOVE_IDS.projectNode, "Project", "Plan our home move", {
          knowledge: { standing: "supported", freshness: "current" },
          governance: { standing: "adopted", approval: "granted" },
        }),
      },
      {
        op: "node.add",
        node: baseNode(HOME_MOVE_IDS.goal, "Goal", "Complete the move for less than €4,000", {
          knowledge: { standing: "supported", freshness: "current" },
          governance: { standing: "adopted", approval: "granted" },
          work: { phase: "planned", verification: "unverified" },
          data: { budgetCeiling: 4000, currency: "EUR" },
        }),
      },
      ...[
        [HOME_MOVE_IDS.schedule, "Schedule"],
        [HOME_MOVE_IDS.budget, "Budget"],
        [HOME_MOVE_IDS.providers, "Providers"],
        [HOME_MOVE_IDS.packing, "Packing"],
      ].map(([id, title]) => ({
        op: "node.add" as const,
        node: baseNode(id, "Idea", title, {
          knowledge: { standing: "supported", freshness: "current" },
          governance: { standing: "adopted", approval: "not_required" },
          data: { role: "area" },
        }),
      })),
      {
        op: "node.add",
        node: baseNode(HOME_MOVE_IDS.artifact, "Artifact", "Local planning page", {
          knowledge: { standing: "supported", freshness: "current" },
          governance: { standing: "adopted", approval: "not_required" },
          data: { path: "demo/moving-costs.html" },
        }),
      },
      {
        op: "node.add",
        node: baseNode(
          HOME_MOVE_IDS.adoptedDecision,
          "Decision",
          "Request at least three written provider quotes",
          {
            knowledge: { standing: "supported", freshness: "current" },
            governance: { standing: "adopted", approval: "granted" },
          },
        ),
      },
      {
        op: "node.add",
        node: baseNode(
          HOME_MOVE_IDS.privateConstraint,
          "Constraint",
          "Keep the new address private until the lease is signed",
          {
            visibility: "private",
            knowledge: { standing: "supported", freshness: "current" },
            governance: { standing: "restricted", approval: "required" },
          },
        ),
      },
      ...[
        HOME_MOVE_IDS.goal,
        HOME_MOVE_IDS.schedule,
        HOME_MOVE_IDS.budget,
        HOME_MOVE_IDS.providers,
        HOME_MOVE_IDS.packing,
        HOME_MOVE_IDS.artifact,
        HOME_MOVE_IDS.adoptedDecision,
        HOME_MOVE_IDS.privateConstraint,
      ].map((childId) => ({
        op: "relation.add" as const,
        relation: {
          id: `relation-${childId}-belongs-home-move`,
          scopeId: HOME_MOVE_IDS.project,
          kind: "belongs_to" as const,
          fromNodeId: childId,
          toNodeId: HOME_MOVE_IDS.projectNode,
          sourceRefs: [],
          data: {},
        },
      })),
    ],
    rationale: ["Create the deterministic sandbox project used by the onboarding demo."],
    sourceRefs: [],
    uncertainty: [],
    alternatives: [],
    conflicts: [],
    visibleConsequence: "The home-move project, goal, areas, artifact, and policies become visible.",
  };

  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-seed-proposed",
      commandId: "command-seed-proposed",
      occurredAt: T.seedProposal,
      actor: HOME_MOVE_ACTORS.system,
      payload: { delta: seedDelta },
    }),
  );
  ledger = accepted(ledger, {
    eventId: "event-seed-accepted",
    commandId: "command-seed-accepted",
    occurredAt: T.seedCommit,
    deltaId: seedDelta.id,
    actor: HOME_MOVE_ACTORS.system,
  });
  return fixture(ledger);
}

function withSampleSource(ledger: WorldstateLedger, suffix = ""): WorldstateLedger {
  return append(
    ledger,
    sourceCapturedEvent({
      eventId: `event-source-moving-tool${suffix}`,
      commandId: `command-source-moving-tool${suffix}`,
      occurredAt: T.source,
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: `${HOME_MOVE_IDS.source}${suffix}`,
          kind: "text",
          content: "Ask Codex to add a simple moving-cost comparison tool to my relocation project.",
          visibility: "shared",
        },
      },
    }),
  );
}

function placementDelta(input: {
  baseRevisionId: string;
  id?: string;
  sourceId?: string;
  parentId?: string;
  supersedesDeltaId?: string;
}): WorldstateDelta {
  const sourceId = input.sourceId ?? HOME_MOVE_IDS.source;
  const id = input.id ?? "delta-place-moving-cost-tool";
  return {
    id,
    baseRevisionId: input.baseRevisionId,
    scopeId: HOME_MOVE_IDS.project,
    purpose: input.supersedesDeltaId ? "correction" : "placement",
    proposedBy: HOME_MOVE_ACTORS.manager,
    operations: [
      {
        op: "node.add",
        node: baseNode(HOME_MOVE_IDS.compareQuotes, "Task", "Compare provider quotes", {
          description: "Add a small moving-cost comparison tool to the local planning page.",
          knowledge: { standing: "draft", freshness: "current" },
          governance: { standing: "adopted", approval: "granted" },
          work: { phase: "planned", verification: "unverified" },
          sourceRefs: [sourceId],
        }),
      },
      {
        op: "node.add",
        node: baseNode(
          HOME_MOVE_IDS.storageQuestion,
          "OpenQuestion",
          "Should recurring storage costs be compared separately?",
          {
            knowledge: { standing: "open", freshness: "current" },
            governance: { standing: "adopted", approval: "not_required" },
            sourceRefs: [sourceId],
          },
        ),
      },
      {
        op: "relation.add",
        relation: {
          id: "relation-compare-quotes-placement",
          scopeId: HOME_MOVE_IDS.project,
          kind: "belongs_to",
          fromNodeId: HOME_MOVE_IDS.compareQuotes,
          toNodeId: input.parentId ?? HOME_MOVE_IDS.budget,
          sourceRefs: [sourceId],
          data: {},
        },
      },
      {
        op: "relation.add",
        relation: {
          id: "relation-compare-quotes-goal",
          scopeId: HOME_MOVE_IDS.project,
          kind: "refines",
          fromNodeId: HOME_MOVE_IDS.compareQuotes,
          toNodeId: HOME_MOVE_IDS.goal,
          sourceRefs: [sourceId],
          data: {},
        },
      },
      {
        op: "relation.add",
        relation: {
          id: "relation-compare-quotes-artifact",
          scopeId: HOME_MOVE_IDS.project,
          kind: "implements",
          fromNodeId: HOME_MOVE_IDS.compareQuotes,
          toNodeId: HOME_MOVE_IDS.artifact,
          sourceRefs: [sourceId],
          data: {},
        },
      },
      {
        op: "relation.add",
        relation: {
          id: "relation-storage-question-budget",
          scopeId: HOME_MOVE_IDS.project,
          kind: "belongs_to",
          fromNodeId: HOME_MOVE_IDS.storageQuestion,
          toNodeId: HOME_MOVE_IDS.budget,
          sourceRefs: [sourceId],
          data: {},
        },
      },
    ],
    rationale: [
      "The request compares moving costs, so Budget is the strongest placement.",
      "The tool directly supports the accepted €4,000 goal and modifies the planning artifact.",
    ],
    sourceRefs: [sourceId],
    uncertainty: ["Recurring storage costs may need a separate comparison."],
    alternatives: ["Place the task under Providers instead of Budget."],
    conflicts: [],
    visibleConsequence: "Budget gains a provider-quote comparison task and one open question.",
    ...(input.supersedesDeltaId ? { supersedesDeltaId: input.supersedesDeltaId } : {}),
  };
}

export function createHappyPlacementFixture(): HomeMoveFixture {
  let { ledger } = createHomeMoveSeedFixture();
  ledger = withSampleSource(ledger);
  const state = reduceWorldstateLedger(ledger);
  const delta = placementDelta({ baseRevisionId: state.canonical.head.id });
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-placement-proposed",
      commandId: "command-placement-proposed",
      occurredAt: T.proposal,
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta },
    }),
  );
  ledger = accepted(ledger, {
    eventId: "event-placement-accepted",
    commandId: "command-placement-accepted",
    occurredAt: T.commit,
    deltaId: delta.id,
  });
  return fixture(ledger);
}

export function createManualMoveFixture(): HomeMoveFixture {
  let { ledger } = createHomeMoveSeedFixture();
  ledger = withSampleSource(ledger, "-manual");
  const state = reduceWorldstateLedger(ledger);
  const original = placementDelta({
    id: "delta-placement-providers",
    sourceId: `${HOME_MOVE_IDS.source}-manual`,
    baseRevisionId: state.canonical.head.id,
    parentId: HOME_MOVE_IDS.providers,
  });
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-placement-providers-proposed",
      commandId: "command-placement-providers-proposed",
      occurredAt: T.proposal,
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta: original },
    }),
  );
  const replacement = placementDelta({
    id: "delta-placement-moved-budget",
    sourceId: `${HOME_MOVE_IDS.source}-manual`,
    baseRevisionId: state.canonical.head.id,
    parentId: HOME_MOVE_IDS.budget,
    supersedesDeltaId: original.id,
  });
  ledger = append(
    ledger,
    deltaDispositionEvent({
      eventId: "event-placement-moved",
      commandId: "command-placement-moved",
      occurredAt: T.disposition,
      actor: HOME_MOVE_ACTORS.human,
      type: "delta.superseded",
      payload: {
        deltaId: original.id,
        baseRevisionId: original.baseRevisionId,
        reason: "The user moved the task from Providers to Budget before committing.",
        replacement,
      },
    }),
  );
  ledger = accepted(ledger, {
    eventId: "event-moved-placement-accepted",
    commandId: "command-moved-placement-accepted",
    occurredAt: T.commit,
    deltaId: replacement.id,
  });
  return fixture(ledger);
}

export function createAmbiguousPlacementFixture(): HomeMoveFixture {
  let { ledger } = createHomeMoveSeedFixture();
  ledger = withSampleSource(ledger, "-ambiguous");
  const state = reduceWorldstateLedger(ledger);
  const delta = placementDelta({
    id: "delta-placement-ambiguous",
    sourceId: `${HOME_MOVE_IDS.source}-ambiguous`,
    baseRevisionId: state.canonical.head.id,
    parentId: HOME_MOVE_IDS.providers,
  });
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-ambiguous-proposed",
      commandId: "command-ambiguous-proposed",
      occurredAt: T.proposal,
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta },
    }),
  );
  ledger = append(
    ledger,
    deltaDispositionEvent({
      eventId: "event-ambiguous-remanded",
      commandId: "command-ambiguous-remanded",
      occurredAt: T.disposition,
      actor: HOME_MOVE_ACTORS.human,
      type: "delta.remanded",
      payload: {
        deltaId: delta.id,
        baseRevisionId: delta.baseRevisionId,
        reason: "Budget and Providers are materially different placements.",
        requiredCorrections: ["Ask the owner to choose Budget or Providers."],
      },
    }),
  );
  return fixture(ledger);
}

export function createAdoptedDecisionConflictFixture(): HomeMoveFixture {
  let { ledger } = createHomeMoveSeedFixture();
  ledger = append(
    ledger,
    sourceCapturedEvent({
      eventId: "event-source-conflict",
      commandId: "command-source-conflict",
      occurredAt: T.source,
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: "source-use-single-quote",
          kind: "text",
          content: "Let's just use the first provider quote and stop comparing.",
          visibility: "shared",
        },
      },
    }),
  );
  const state = reduceWorldstateLedger(ledger);
  const delta: WorldstateDelta = {
    id: "delta-challenge-three-quotes",
    baseRevisionId: state.canonical.head.id,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "placement",
    proposedBy: HOME_MOVE_ACTORS.manager,
    operations: [
      {
        op: "node.add",
        node: baseNode("node-idea-use-first-quote", "Idea", "Use the first acceptable quote", {
          knowledge: { standing: "challenged", freshness: "current" },
          governance: { standing: "adopted", approval: "granted" },
          sourceRefs: ["source-use-single-quote"],
        }),
      },
      {
        op: "relation.add",
        relation: {
          id: "relation-first-quote-conflicts-three-quotes",
          scopeId: HOME_MOVE_IDS.project,
          kind: "conflicts_with",
          fromNodeId: "node-idea-use-first-quote",
          toNodeId: HOME_MOVE_IDS.adoptedDecision,
          sourceRefs: ["source-use-single-quote"],
          data: {},
        },
      },
    ],
    rationale: ["The new idea contradicts an adopted comparison decision and must not overwrite it."],
    sourceRefs: ["source-use-single-quote"],
    uncertainty: [],
    alternatives: ["Revisit the adopted decision explicitly."],
    conflicts: [HOME_MOVE_IDS.adoptedDecision],
    visibleConsequence: "A challenging idea appears beside the unchanged adopted decision.",
  };
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-conflict-proposed",
      commandId: "command-conflict-proposed",
      occurredAt: T.proposal,
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta },
    }),
  );
  ledger = accepted(ledger, {
    eventId: "event-conflict-accepted",
    commandId: "command-conflict-accepted",
    occurredAt: T.commit,
    deltaId: delta.id,
  });
  return fixture(ledger);
}

export interface StaleProposalFixture extends HomeMoveFixture {
  readonly staleAcceptedEvent: LedgerEventOf<"delta.accepted">;
  readonly staleDeltaId: string;
}

export function createStaleProposalFixture(): StaleProposalFixture {
  let { ledger } = createHomeMoveSeedFixture();
  ledger = withSampleSource(ledger, "-stale");
  let state = reduceWorldstateLedger(ledger);
  const staleDelta = placementDelta({
    id: "delta-placement-stale",
    sourceId: `${HOME_MOVE_IDS.source}-stale`,
    baseRevisionId: state.canonical.head.id,
  });
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-stale-proposed",
      commandId: "command-stale-proposed",
      occurredAt: T.proposal,
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta: staleDelta },
    }),
  );
  state = reduceWorldstateLedger(ledger);
  const staleAcceptedEvent = buildDeltaAcceptedEvent(state, {
    eventId: "event-stale-accept-attempt",
    commandId: "command-stale-accept-attempt",
    occurredAt: T.commit,
    actor: HOME_MOVE_ACTORS.human,
    deltaId: staleDelta.id,
  });

  const advancingDelta: WorldstateDelta = {
    id: "delta-record-moving-window",
    baseRevisionId: state.canonical.head.id,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "correction",
    proposedBy: HOME_MOVE_ACTORS.human,
    operations: [
      {
        op: "node.patch",
        nodeId: HOME_MOVE_IDS.schedule,
        patch: { data: { movingWindow: "Late September" } },
      },
    ],
    rationale: ["Record the newly selected moving window."],
    sourceRefs: [],
    uncertainty: [],
    alternatives: [],
    conflicts: [],
    visibleConsequence: "Schedule shows a late-September moving window.",
  };
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-advance-proposed",
      commandId: "command-advance-proposed",
      occurredAt: "2026-07-16T09:01:02.500Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: { delta: advancingDelta },
    }),
  );
  ledger = accepted(ledger, {
    eventId: "event-advance-accepted",
    commandId: "command-advance-accepted",
    occurredAt: "2026-07-16T09:01:02.750Z",
    deltaId: advancingDelta.id,
  });
  return {
    ...fixture(ledger),
    staleAcceptedEvent,
    staleDeltaId: staleDelta.id,
  };
}

function addBrief(ledger: WorldstateLedger): { ledger: WorldstateLedger; brief: AgentBrief } {
  const state = reduceWorldstateLedger(ledger);
  const brief = compileAgentBrief(state, {
    id: HOME_MOVE_IDS.brief,
    baseRevisionId: state.canonical.head.id,
    artifactBaseRef: "git:demo-base-001",
    targetNodeId: HOME_MOVE_IDS.compareQuotes,
    shareNodeIds: [
      HOME_MOVE_IDS.projectNode,
      HOME_MOVE_IDS.goal,
      HOME_MOVE_IDS.budget,
      HOME_MOVE_IDS.artifact,
      HOME_MOVE_IDS.compareQuotes,
      HOME_MOVE_IDS.storageQuestion,
    ],
    goal: "Add a simple moving-cost comparison tool to the demo planning page.",
    doneMeans: [
      "A user can enter at least two provider quotes and compare totals.",
      "Focused tests for total calculation pass.",
    ],
    environment: "Disposable local demo workspace",
    agentProfile: "Codex, repository-local implementation",
    allowedActions: ["Read and edit files inside the disposable demo workspace", "Run focused tests"],
    deniedActions: ["Publish externally", "Read omitted worldstate context"],
    confirmationRequired: ["Any action outside the disposable workspace"],
    evidenceContract: {
      requirements: [
        {
          id: "requirement-focused-tests",
          label: "Focused moving-cost calculation tests pass",
          kind: "test",
          required: true,
        },
        {
          id: "requirement-artifact-change",
          label: "The planning-page artifact change is addressable",
          kind: "artifact",
          required: true,
        },
      ],
      policy: { blockIntegration: true },
    },
    escalationPath: "Return blocked with the exact missing authorization or information.",
  });
  return {
    brief,
    ledger: append(
      ledger,
      briefCompiledEvent({
        eventId: "event-brief-compiled",
        commandId: "command-brief-compiled",
        occurredAt: T.brief,
        actor: HOME_MOVE_ACTORS.manager,
        payload: { brief },
      }),
    ),
  };
}

export interface PrivateProjectionFixture extends HomeMoveFixture {
  readonly brief: AgentBrief;
  readonly agentPayload: AgentBriefPayload;
}

export function createPrivateProjectionFixture(): PrivateProjectionFixture {
  const happy = createHappyPlacementFixture();
  const result = addBrief(happy.ledger);
  return {
    ...fixture(result.ledger),
    brief: result.brief,
    agentPayload: projectAgentBrief(result.brief),
  };
}

export interface WorkerClosureFixture extends PrivateProjectionFixture {
  readonly mode: "live" | "replay";
  readonly evidencePosture: "passing" | "missing";
}

function createWorkerFixture(input: {
  mode: "live" | "replay";
  evidencePosture: "passing" | "missing";
  staleBeforeClosure?: boolean;
}): WorkerClosureFixture {
  const projected = createPrivateProjectionFixture();
  let ledger = projected.ledger;
  const baseRevisionId = projected.state.canonical.head.id;
  ledger = append(
    ledger,
    runAuthorizedEvent({
      eventId: `event-run-authorized-${input.mode}`,
      commandId: `command-run-authorized-${input.mode}`,
      occurredAt: T.authorize,
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        run: {
          id: HOME_MOVE_IDS.run,
          briefId: HOME_MOVE_IDS.brief,
          baseRevisionId,
          artifactBaseRef: projected.brief.artifactBaseRef,
          mode: input.mode,
        },
      },
    }),
  );
  ledger = append(
    ledger,
    runLifecycleEvent({
      eventId: `event-run-received-${input.mode}`,
      commandId: `command-run-received-${input.mode}`,
      occurredAt: T.received,
      actor: HOME_MOVE_ACTORS.codex,
      payload: { runId: HOME_MOVE_IDS.run, status: "received", evidenceRefs: [] },
    }),
  );
  ledger = append(
    ledger,
    runLifecycleEvent({
      eventId: `event-run-working-${input.mode}`,
      commandId: `command-run-working-${input.mode}`,
      occurredAt: T.working,
      actor: HOME_MOVE_ACTORS.codex,
      payload: { runId: HOME_MOVE_IDS.run, status: "working", evidenceRefs: [] },
    }),
  );
  ledger = append(
    ledger,
    runLifecycleEvent({
      eventId: `event-run-returned-${input.mode}`,
      commandId: `command-run-returned-${input.mode}`,
      occurredAt: T.returned,
      actor: HOME_MOVE_ACTORS.codex,
      payload: {
        runId: HOME_MOVE_IDS.run,
        status: "returned",
        message: "The comparison tool and focused tests are ready for review.",
        evidenceRefs: ["evidence:test-output", "evidence:artifact-diff"],
      },
    }),
  );

  if (input.staleBeforeClosure) {
    const state = reduceWorldstateLedger(ledger);
    const advance: WorldstateDelta = {
      id: "delta-advance-before-closure",
      baseRevisionId: state.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "correction",
      proposedBy: HOME_MOVE_ACTORS.human,
      operations: [
        {
          op: "node.patch",
          nodeId: HOME_MOVE_IDS.packing,
          patch: { data: { boxCountEstimate: 30 } },
        },
      ],
      rationale: ["Record a packing estimate while the agent result is in flight."],
      sourceRefs: [],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "Packing shows an estimate of thirty boxes.",
    };
    ledger = append(
      ledger,
      deltaProposedEvent({
        eventId: "event-advance-before-closure-proposed",
        commandId: "command-advance-before-closure-proposed",
        occurredAt: "2026-07-16T09:02:04.250Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta: advance },
      }),
    );
    ledger = accepted(ledger, {
      eventId: "event-advance-before-closure-accepted",
      commandId: "command-advance-before-closure-accepted",
      occurredAt: "2026-07-16T09:02:04.500Z",
      deltaId: advance.id,
    });
  }

  ledger = append(
    ledger,
    closureStagedEvent({
      eventId: `event-closure-staged-${input.mode}`,
      commandId: `command-closure-staged-${input.mode}`,
      occurredAt: T.closure,
      actor: HOME_MOVE_ACTORS.codex,
      payload: {
        closure: {
          id: HOME_MOVE_IDS.closure,
          runId: HOME_MOVE_IDS.run,
          briefId: HOME_MOVE_IDS.brief,
          baseRevisionId,
          artifactBaseRef: projected.brief.artifactBaseRef,
          mode: input.mode,
          outcome: "returned",
          claimedCompletion: true,
          summary: "Added the quote comparison form, calculation logic, and focused tests.",
          changes: ["Added quote rows and total comparison to the demo planning page."],
          artifactRefs: ["artifact:demo/moving-costs.html@result-001"],
          evidenceRefs: ["evidence:test-output", "evidence:artifact-diff"],
          failures: [],
          unresolved: ["Decide whether recurring storage costs need a separate row."],
        },
      },
    }),
  );

  if (input.evidencePosture === "passing") {
    ledger = append(
      ledger,
      evidenceValidationEvent({
        eventId: `event-evidence-validated-${input.mode}`,
        commandId: `command-evidence-validated-${input.mode}`,
        occurredAt: T.validation,
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          validation: {
            id: `validation-moving-tool-${input.mode}`,
            closureId: HOME_MOVE_IDS.closure,
            briefId: HOME_MOVE_IDS.brief,
            baseRevisionId,
            validator: HOME_MOVE_ACTORS.system,
            observedAt: T.validation,
            observations: [
              {
                requirementId: "requirement-focused-tests",
                result: "passed",
                freshness: "current",
                evidenceRefs: ["evidence:test-output"],
              },
              {
                requirementId: "requirement-artifact-change",
                result: "passed",
                freshness: "current",
                evidenceRefs: ["evidence:artifact-diff"],
              },
            ],
          },
        },
      }),
    );
  }

  return {
    ...fixture(ledger),
    brief: projected.brief,
    agentPayload: projected.agentPayload,
    mode: input.mode,
    evidencePosture: input.evidencePosture,
  };
}

export const createLiveWorkerClosureFixture = (): WorkerClosureFixture =>
  createWorkerFixture({ mode: "live", evidencePosture: "passing" });

export const createReplayClosureFixture = (): WorkerClosureFixture =>
  createWorkerFixture({ mode: "replay", evidencePosture: "passing" });

export const createMissingEvidenceFixture = (): WorkerClosureFixture =>
  createWorkerFixture({ mode: "live", evidencePosture: "missing" });

export const createStaleClosureFixture = (): WorkerClosureFixture =>
  createWorkerFixture({ mode: "live", evidencePosture: "missing", staleBeforeClosure: true });

function resultReconciliationDelta(state: WorldstateState): WorldstateDelta {
  return {
    id: "delta-integrate-moving-cost-result",
    baseRevisionId: state.canonical.head.id,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "reconciliation",
    proposedBy: HOME_MOVE_ACTORS.manager,
    operations: [
      {
        op: "node.patch",
        nodeId: HOME_MOVE_IDS.compareQuotes,
        patch: {
          knowledge: { standing: "supported", freshness: "current" },
          work: { phase: "completed", verification: "verified" },
          data: { resultArtifactRef: "artifact:demo/moving-costs.html@result-001" },
        },
      },
      {
        op: "node.add",
        node: baseNode(HOME_MOVE_IDS.resultEvidence, "Evidence", "Moving-cost tool checks", {
          knowledge: { standing: "supported", freshness: "current" },
          governance: { standing: "adopted", approval: "not_required" },
          data: { closureId: HOME_MOVE_IDS.closure, validationId: "validation-moving-tool-live" },
        }),
      },
      {
        op: "relation.add",
        relation: {
          id: "relation-compare-quotes-evidence",
          scopeId: HOME_MOVE_IDS.project,
          kind: "evidenced_by",
          fromNodeId: HOME_MOVE_IDS.compareQuotes,
          toNodeId: HOME_MOVE_IDS.resultEvidence,
          sourceRefs: [],
          data: { closureId: HOME_MOVE_IDS.closure },
        },
      },
    ],
    rationale: ["The returned artifact and required checks support completion and verification."],
    sourceRefs: [HOME_MOVE_IDS.source],
    uncertainty: ["Recurring storage costs remain an open product question."],
    alternatives: ["Leave the returned result staged for later review."],
    conflicts: [],
    visibleConsequence: "The task becomes completed and verified with linked evidence.",
    closureRef: HOME_MOVE_IDS.closure,
  };
}

export interface BlockedIntegrationFixture extends WorkerClosureFixture {
  readonly deltaId: string;
  readonly blockedAcceptedEvent: LedgerEventOf<"delta.accepted">;
}

export function createBlockedIntegrationFixture(): BlockedIntegrationFixture {
  const worker = createMissingEvidenceFixture();
  let ledger = worker.ledger;
  const delta = resultReconciliationDelta(reduceWorldstateLedger(ledger));
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-blocked-reconciliation-proposed",
      commandId: "command-blocked-reconciliation-proposed",
      occurredAt: T.reconciliationProposal,
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta },
    }),
  );
  const state = reduceWorldstateLedger(ledger);
  const blockedAcceptedEvent = buildDeltaAcceptedEvent(state, {
    eventId: "event-blocked-reconciliation-accepted",
    commandId: "command-blocked-reconciliation-accepted",
    occurredAt: T.reconciliationCommit,
    actor: HOME_MOVE_ACTORS.human,
    deltaId: delta.id,
    artifactBaseRef: worker.brief.artifactBaseRef,
  });
  return {
    ...worker,
    ledger,
    state,
    deltaId: delta.id,
    blockedAcceptedEvent,
  };
}

export function createIntegratedResultFixture(): WorkerClosureFixture {
  const worker = createLiveWorkerClosureFixture();
  let ledger = worker.ledger;
  const state = reduceWorldstateLedger(ledger);
  const delta = resultReconciliationDelta(state);
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-reconciliation-proposed",
      commandId: "command-reconciliation-proposed",
      occurredAt: T.reconciliationProposal,
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta },
    }),
  );
  ledger = accepted(ledger, {
    eventId: "event-reconciliation-accepted",
    commandId: "command-reconciliation-accepted",
    occurredAt: T.reconciliationCommit,
    deltaId: delta.id,
    artifactBaseRef: worker.brief.artifactBaseRef,
  });
  return {
    ...worker,
    ledger,
    state: reduceWorldstateLedger(ledger),
  };
}

export function createCompensatingRevisionFixture(): HomeMoveFixture {
  const integrated = createIntegratedResultFixture();
  let ledger = integrated.ledger;
  const state = reduceWorldstateLedger(ledger);
  const relationIds = [
    "relation-compare-quotes-placement",
    "relation-compare-quotes-goal",
    "relation-compare-quotes-artifact",
    "relation-compare-quotes-evidence",
  ];
  const delta: WorldstateDelta = {
    id: "delta-compensate-remove-comparison",
    baseRevisionId: state.canonical.head.id,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "compensation",
    proposedBy: HOME_MOVE_ACTORS.human,
    operations: [
      ...relationIds.map((relationId) => ({ op: "relation.retire" as const, relationId })),
      { op: "node.retire", nodeId: HOME_MOVE_IDS.compareQuotes },
    ],
    rationale: ["Undo the accepted comparison task with a compensating revision."],
    sourceRefs: [HOME_MOVE_IDS.source],
    uncertainty: [],
    alternatives: ["Keep the completed task as historical project content."],
    conflicts: [],
    visibleConsequence: "The comparison task leaves the current view while its lineage remains addressable.",
  };
  ledger = append(
    ledger,
    deltaProposedEvent({
      eventId: "event-compensation-proposed",
      commandId: "command-compensation-proposed",
      occurredAt: T.compensationProposal,
      actor: HOME_MOVE_ACTORS.human,
      payload: { delta },
    }),
  );
  ledger = accepted(ledger, {
    eventId: "event-compensation-accepted",
    commandId: "command-compensation-accepted",
    occurredAt: T.compensationCommit,
    deltaId: delta.id,
  });
  return fixture(ledger);
}

/** Full deterministic happy-path fixture suitable for a replay/demo controller. */
export const createHomeMoveDemoFixture = createIntegratedResultFixture;
