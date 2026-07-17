import { KernelError, invariant } from "./errors";
import { AgentBriefSchema, type AgentBrief, type EvidenceContract } from "./schema";
import type { WorldstateState } from "./types";

export interface CompileAgentBriefInput {
  readonly id: string;
  readonly baseRevisionId: string;
  readonly artifactBaseRef: string;
  readonly targetNodeId: string;
  /** Explicit allow-list. Anything else is denied by omission. */
  readonly shareNodeIds: readonly string[];
  readonly goal: string;
  readonly doneMeans: readonly string[];
  readonly environment: string;
  readonly agentProfile: string;
  readonly allowedActions: readonly string[];
  readonly deniedActions: readonly string[];
  readonly confirmationRequired?: readonly string[];
  readonly evidenceContract: EvidenceContract;
  readonly escalationPath: string;
}

export interface AgentBriefPayload {
  readonly id: string;
  readonly baseRevisionId: string;
  readonly artifactBaseRef: string;
  readonly targetNodeId: string;
  readonly goal: string;
  readonly doneMeans: readonly string[];
  readonly context: {
    readonly nodes: AgentBrief["sharedNodes"];
    readonly relations: AgentBrief["sharedRelations"];
  };
  readonly environment: string;
  readonly agentProfile: string;
  readonly authority: {
    readonly allowedActions: readonly string[];
    readonly deniedActions: readonly string[];
    readonly confirmationRequired: readonly string[];
  };
  readonly evidenceContract: EvidenceContract;
  readonly escalationPath: string;
}

export function compileAgentBrief(
  state: WorldstateState,
  input: CompileAgentBriefInput,
): AgentBrief {
  invariant(
    input.baseRevisionId === state.canonical.head.id,
    "revision_conflict",
    `Brief ${input.id} must bind the current worldstate revision.`,
    { baseRevisionId: input.baseRevisionId, headRevisionId: state.canonical.head.id },
  );
  const target = state.canonical.nodes[input.targetNodeId];
  invariant(
    target && !target.retiredRevisionId,
    "reference_missing",
    `Brief target ${input.targetNodeId} is not active.`,
    { targetNodeId: input.targetNodeId },
  );

  const shareIds = new Set(input.shareNodeIds);
  invariant(
    shareIds.has(input.targetNodeId),
    "reference_missing",
    "The brief target must be present in the explicit context allow-list.",
    { targetNodeId: input.targetNodeId },
  );

  const activeNodes = Object.values(state.canonical.nodes).filter(
    (node) => !node.retiredRevisionId,
  );
  const visibleSourceRefs = (sourceRefs: readonly string[]): string[] =>
    sourceRefs.filter((sourceId) => state.operational.sources[sourceId]?.visibility === "shared");
  const sharedNodes = [...shareIds].map((nodeId) => {
    const node = state.canonical.nodes[nodeId];
    invariant(
      node && !node.retiredRevisionId,
      "reference_missing",
      `Shared node ${nodeId} is not active.`,
      { nodeId },
    );
    if (node.visibility === "private") {
      throw new KernelError(
        "scope_violation",
        `Private node ${nodeId} cannot enter an agent projection.`,
        { nodeId },
      );
    }
    return { ...node, sourceRefs: visibleSourceRefs(node.sourceRefs) };
  });
  const sharedRelations = Object.values(state.canonical.relations).filter(
    (relation) =>
      !relation.retiredRevisionId &&
      shareIds.has(relation.fromNodeId) &&
      shareIds.has(relation.toNodeId),
  ).map((relation) => ({
    ...relation,
    sourceRefs: visibleSourceRefs(relation.sourceRefs),
  }));
  const omittedContext = activeNodes
    .filter((node) => !shareIds.has(node.id))
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      reason: node.visibility === "private" ? ("private" as const) : ("out_of_scope" as const),
    }));

  return AgentBriefSchema.parse({
    id: input.id,
    baseRevisionId: input.baseRevisionId,
    artifactBaseRef: input.artifactBaseRef,
    targetNodeId: input.targetNodeId,
    goal: input.goal,
    doneMeans: input.doneMeans,
    sharedNodes,
    sharedRelations,
    omittedContext,
    environment: input.environment,
    agentProfile: input.agentProfile,
    allowedActions: input.allowedActions,
    deniedActions: input.deniedActions,
    confirmationRequired: [...(input.confirmationRequired ?? [])],
    evidenceContract: input.evidenceContract,
    escalationPath: input.escalationPath,
  });
}

/**
 * This is the only shape an execution adapter should serialize. Local omission
 * receipts are deliberately absent, so private/out-of-scope nodes are not leaked.
 */
export function projectAgentBrief(brief: AgentBrief): AgentBriefPayload {
  return {
    id: brief.id,
    baseRevisionId: brief.baseRevisionId,
    artifactBaseRef: brief.artifactBaseRef,
    targetNodeId: brief.targetNodeId,
    goal: brief.goal,
    doneMeans: [...brief.doneMeans],
    context: {
      nodes: brief.sharedNodes,
      relations: brief.sharedRelations,
    },
    environment: brief.environment,
    agentProfile: brief.agentProfile,
    authority: {
      allowedActions: [...brief.allowedActions],
      deniedActions: [...brief.deniedActions],
      confirmationRequired: [...brief.confirmationRequired],
    },
    evidenceContract: brief.evidenceContract,
    escalationPath: brief.escalationPath,
  };
}
