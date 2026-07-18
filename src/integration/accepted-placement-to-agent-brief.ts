import {
  compileAgentBrief,
  type AgentBrief,
  type WorldstateDelta,
  type WorldstateNode,
  type WorldstateState,
} from "@/domain";

export interface CompileAcceptedPlacementAgentBriefInput {
  readonly briefId: string;
  readonly artifactBaseRef: string;
  readonly executionMode?: "live" | "replay";
}

export class AcceptedPlacementBriefError extends Error {
  constructor(
    readonly code:
      | "accepted_task_missing"
      | "accepted_task_ambiguous"
      | "accepted_task_unsupported"
      | "project_missing"
      | "project_ambiguous"
      | "goal_missing"
      | "goal_ambiguous"
      | "artifact_missing"
      | "artifact_ambiguous"
      | "artifact_path_missing",
    message: string,
  ) {
    super(message);
    this.name = "AcceptedPlacementBriefError";
  }
}

interface AcceptedTaskPlacement {
  readonly delta: WorldstateDelta;
  readonly target: WorldstateNode;
}

const active = (node: WorldstateNode | undefined): node is WorldstateNode =>
  Boolean(node && !node.retiredRevisionId);

export function isRegisteredMovingCostReplayTarget(
  node: WorldstateNode | undefined,
): boolean {
  return Boolean(
    node &&
      !node.retiredRevisionId &&
      node.kind === "Task" &&
      node.title === "Compare provider quotes" &&
      node.description ===
        "Create a small comparison tool for moving-provider costs and return focused implementation evidence.",
  );
}

function latestAcceptedTaskPlacement(state: WorldstateState): AcceptedTaskPlacement {
  for (const revisionId of [...state.canonical.revisionOrder].reverse()) {
    const revision = state.canonical.revisions[revisionId];
    if (!revision?.deltaId) continue;
    const projection = state.operational.deltas[revision.deltaId];
    if (
      !projection ||
      projection.disposition !== "accepted" ||
      projection.acceptedRevisionId !== revision.id ||
      projection.delta.purpose !== "placement"
    ) {
      continue;
    }

    const taskAdds = projection.delta.operations.filter(
      (operation): operation is Extract<
        WorldstateDelta["operations"][number],
        { op: "node.add" }
      > => operation.op === "node.add" && operation.node.kind === "Task",
    );
    if (taskAdds.length > 1) {
      throw new AcceptedPlacementBriefError(
        "accepted_task_ambiguous",
        `Accepted placement ${projection.delta.id} adds more than one Task; delegation requires one explicit target.`,
      );
    }
    const taskAdd = taskAdds[0];
    if (!taskAdd) continue;
    const target = state.canonical.nodes[taskAdd.node.id];
    if (!active(target)) continue;
    return { delta: projection.delta, target };
  }

  throw new AcceptedPlacementBriefError(
    "accepted_task_missing",
    "No active Task from an accepted placement is available for delegation.",
  );
}

function activeRelations(state: WorldstateState) {
  return Object.values(state.canonical.relations).filter(
    (relation) => !relation.retiredRevisionId,
  );
}

function projectAncestorPath(
  state: WorldstateState,
  target: WorldstateNode,
): { readonly project: WorldstateNode; readonly ancestors: readonly WorldstateNode[] } {
  const relations = activeRelations(state);
  const visited = new Set<string>([target.id]);
  let frontier: Array<{
    readonly nodeId: string;
    readonly ancestors: readonly WorldstateNode[];
  }> = [{ nodeId: target.id, ancestors: [] }];
  const paths: Array<{
    readonly project: WorldstateNode;
    readonly ancestors: readonly WorldstateNode[];
  }> = [];

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const entry of frontier) {
      for (const relation of relations) {
        if (
          relation.kind !== "belongs_to" ||
          relation.fromNodeId !== entry.nodeId
        ) {
          continue;
        }
        const parent = state.canonical.nodes[relation.toNodeId];
        if (!active(parent)) continue;
        const ancestors = [...entry.ancestors, parent];
        if (parent.kind === "Project") {
          paths.push({ project: parent, ancestors });
        } else if (!visited.has(parent.id)) {
          visited.add(parent.id);
          next.push({ nodeId: parent.id, ancestors });
        }
      }
    }
    frontier = next;
  }

  if (paths.length === 0) {
    throw new AcceptedPlacementBriefError(
      "project_missing",
      `Task ${target.id} has no active Project ancestor.`,
    );
  }
  if (paths.length > 1) {
    throw new AcceptedPlacementBriefError(
      "project_ambiguous",
      `Task ${target.id} has more than one Project ancestor path.`,
    );
  }
  return paths[0];
}

function relatedOrOnlyNode(
  state: WorldstateState,
  target: WorldstateNode,
  project: WorldstateNode,
  input: {
    readonly kind: "Goal" | "Artifact";
    readonly relationKind: "refines" | "implements";
    readonly missingCode: "goal_missing" | "artifact_missing";
    readonly ambiguousCode: "goal_ambiguous" | "artifact_ambiguous";
  },
): WorldstateNode {
  const relations = activeRelations(state);
  const directlyRelated = relations
    .filter(
      (relation) =>
        relation.kind === input.relationKind && relation.fromNodeId === target.id,
    )
    .map((relation) => state.canonical.nodes[relation.toNodeId])
    .filter(
      (node): node is WorldstateNode =>
        active(node) &&
        node.visibility === "shared" &&
        node.scopeId === project.scopeId &&
        node.kind === input.kind,
    );
  const candidates =
    directlyRelated.length > 0
      ? directlyRelated
      : Object.values(state.canonical.nodes).filter(
          (node) =>
            active(node) &&
            node.visibility === "shared" &&
            node.scopeId === project.scopeId &&
            node.kind === input.kind,
        );
  const unique = [...new Map(candidates.map((node) => [node.id, node])).values()];

  if (unique.length === 0) {
    throw new AcceptedPlacementBriefError(
      input.missingCode,
      `No shared ${input.kind} is available for Task ${target.id}.`,
    );
  }
  if (unique.length > 1) {
    throw new AcceptedPlacementBriefError(
      input.ambiguousCode,
      `Task ${target.id} does not identify one unambiguous ${input.kind}.`,
    );
  }
  return unique[0];
}

/**
 * Compiles the authored home-move delegation policy around the latest accepted
 * dynamic Task. Identity comes from ledger history rather than fixture Task IDs;
 * every omitted active node remains visible in the human-only omission receipt.
 */
export function compileAcceptedPlacementAgentBrief(
  state: WorldstateState,
  input: CompileAcceptedPlacementAgentBriefInput,
): AgentBrief {
  const { delta, target } = latestAcceptedTaskPlacement(state);
  if (!isRegisteredMovingCostReplayTarget(target)) {
    throw new AcceptedPlacementBriefError(
      "accepted_task_unsupported",
      `Task ${target.id} does not match the registered moving-cost replay scenario.`,
    );
  }
  const { project, ancestors } = projectAncestorPath(state, target);
  const goal = relatedOrOnlyNode(state, target, project, {
    kind: "Goal",
    relationKind: "refines",
    missingCode: "goal_missing",
    ambiguousCode: "goal_ambiguous",
  });
  const artifact = relatedOrOnlyNode(state, target, project, {
    kind: "Artifact",
    relationKind: "implements",
    missingCode: "artifact_missing",
    ambiguousCode: "artifact_ambiguous",
  });
  const artifactPath = artifact.data.path;
  if (typeof artifactPath !== "string" || artifactPath.trim().length === 0) {
    throw new AcceptedPlacementBriefError(
      "artifact_path_missing",
      `Artifact ${artifact.id} has no stable repo-local path.`,
    );
  }
  const nonProjectAncestors = ancestors.filter((node) => node.id !== project.id);

  return compileAgentBrief(state, {
    id: input.briefId,
    executionMode: input.executionMode ?? "replay",
    baseRevisionId: state.canonical.head.id,
    artifactBaseRef: input.artifactBaseRef,
    targetNodeId: target.id,
    shareNodeIds: [
      project.id,
      goal.id,
      artifact.id,
      ...nonProjectAncestors.reverse().map((node) => node.id),
      target.id,
    ],
    goal: "Add a simple moving-cost comparison tool to the demo planning page.",
    doneMeans: [
      "A user can enter at least two provider quotes and compare totals.",
      "Focused tests for total calculation pass.",
    ],
    unknowns: [...delta.uncertainty],
    constraints: [],
    expectedArtifacts: [artifactPath],
    environment: "Disposable local demo workspace",
    agentProfile: "Codex, repository-local implementation",
    allowedActions: [
      "Read and edit files inside the disposable demo workspace",
      "Run focused tests",
    ],
    deniedActions: ["Publish externally", "Read omitted worldstate context"],
    confirmationRequired: ["Any action outside the disposable workspace"],
    evidenceContract: {
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
    },
    escalationPath: "Return blocked with the exact missing authorization or information.",
  });
}
