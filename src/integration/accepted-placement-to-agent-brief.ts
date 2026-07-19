import {
  compileAgentBrief,
  MOVING_COST_DELEGATION_PROFILE_ID,
  registeredDelegationProfile,
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
      | "accepted_task_topology_unsupported"
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
      node.delegationProfileId === MOVING_COST_DELEGATION_PROFILE_ID,
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
  let frontier: Array<{
    readonly nodeId: string;
    readonly ancestors: readonly WorldstateNode[];
    readonly visited: ReadonlySet<string>;
  }> = [{ nodeId: target.id, ancestors: [], visited: new Set([target.id]) }];
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
        if (!active(parent) || entry.visited.has(parent.id)) continue;
        const ancestors = [...entry.ancestors, parent];
        if (parent.kind === "Project") {
          paths.push({ project: parent, ancestors });
        } else {
          next.push({
            nodeId: parent.id,
            ancestors,
            visited: new Set([...entry.visited, parent.id]),
          });
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
  const delegationProfileId = target.delegationProfileId;
  if (!delegationProfileId) {
    throw new AcceptedPlacementBriefError(
      "accepted_task_unsupported",
      `Task ${target.id} does not match the registered moving-cost replay scenario.`,
    );
  }
  const profile = registeredDelegationProfile(delegationProfileId);
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
  if (
    project.id !== profile.expectedProjectId ||
    !ancestors.some(
      (ancestor) => ancestor.id === profile.expectedAncestorId,
    ) ||
    goal.id !== profile.expectedGoalId ||
    artifact.id !== profile.expectedArtifactId
  ) {
    throw new AcceptedPlacementBriefError(
      "accepted_task_topology_unsupported",
      `Task ${target.id} carries ${profile.id}, but its canonical project, required ancestry, goal, or artifact does not match that host-registered profile.`,
    );
  }
  const artifactPath = artifact.data.path;
  if (typeof artifactPath !== "string" || artifactPath.trim().length === 0) {
    throw new AcceptedPlacementBriefError(
      "artifact_path_missing",
      `Artifact ${artifact.id} has no stable repo-local path.`,
    );
  }
  if (artifactPath !== profile.expectedArtifacts[0]) {
    throw new AcceptedPlacementBriefError(
      "accepted_task_topology_unsupported",
      `Artifact ${artifact.id} does not bind the registered moving-cost path.`,
    );
  }
  const nonProjectAncestors = ancestors.filter((node) => node.id !== project.id);

  return compileAgentBrief(state, {
    id: input.briefId,
    executionMode: input.executionMode ?? "replay",
    baseRevisionId: state.canonical.head.id,
    artifactBaseRef: input.artifactBaseRef,
    targetNodeId: target.id,
    delegationProfileId: profile.id,
    shareNodeIds: [
      project.id,
      goal.id,
      artifact.id,
      ...nonProjectAncestors.reverse().map((node) => node.id),
      target.id,
    ],
    goal: profile.goal,
    doneMeans: profile.doneMeans,
    unknowns: [...delta.uncertainty],
    constraints: profile.constraints,
    expectedArtifacts: profile.expectedArtifacts,
    environment: profile.environment,
    agentProfile: profile.agentProfile,
    allowedActions: profile.allowedActions,
    deniedActions: profile.deniedActions,
    confirmationRequired: profile.confirmationRequired,
    evidenceContract: {
      requirements: profile.evidenceContract.requirements.map((requirement) => ({
        ...requirement,
      })),
      policy: { ...profile.evidenceContract.policy },
    },
    escalationPath: profile.escalationPath,
  });
}
