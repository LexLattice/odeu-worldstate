import {
  AgentRunRequestSchema,
  type AgentRunRequest,
  type AgentBrief as CodexAgentBrief,
} from "@/adapters/codex/schema";
import { projectAgentBrief } from "@/domain/projection";
import type { AgentBrief as DomainAgentBrief, NodeKind } from "@/domain/schema";

type SharedKind = CodexAgentBrief["context"]["shared"][number]["kind"];

function sharedKind(kind: NodeKind): SharedKind {
  switch (kind) {
    case "World":
      return "world";
    case "Project":
      return "project";
    case "Goal":
      return "goal";
    case "Idea":
      return "idea";
    case "Decision":
      return "decision";
    case "Constraint":
      return "constraint";
    case "OpenQuestion":
      return "unknown";
    case "Task":
      return "work";
    case "Artifact":
      return "artifact";
    case "AgentRun":
      return "agent_run";
    case "Evidence":
      return "evidence";
  }
}

/**
 * Adapts the kernel's inspectable brief into the Codex route contract. Private
 * omissions remain available to the human preview; compileCodexPrompt performs
 * the final deny-by-omission projection before provider execution.
 */
export function domainBriefToCodexRunRequest(
  brief: DomainAgentBrief,
  requestId: string,
): AgentRunRequest {
  const projected = projectAgentBrief(brief);
  const nonSharedNode = projected.context.nodes.find((node) => node.visibility !== "shared");
  if (nonSharedNode) {
    throw new Error(`Execution projection contains non-shared node ${nonSharedNode.id}.`);
  }

  const unknowns = projected.context.nodes
    .filter((node) => node.kind === "OpenQuestion")
    .map((node) => node.description ?? node.title);
  const constraints = projected.context.nodes
    .filter((node) => node.kind === "Constraint")
    .map((node) => node.description ?? node.title);
  return AgentRunRequestSchema.parse({
    requestId,
    authorization: null,
    brief: {
      briefId: brief.id,
      sourceRevisionId: brief.baseRevisionId,
      artifactBaseRef: brief.artifactBaseRef,
      goal: brief.goal,
      doneMeans: brief.doneMeans,
      environment: projected.environment,
      agentProfile: projected.agentProfile,
      context: {
        shared: projected.context.nodes.map((node) => ({
          id: node.id,
          kind: sharedKind(node.kind),
          label: node.title,
          summary: node.description ?? node.title,
        })),
        relations: projected.context.relations.map((relation) => ({
          id: relation.id,
          kind: relation.kind,
          fromId: relation.fromNodeId,
          toId: relation.toNodeId,
          label: relation.label ?? null,
        })),
        omittedCount: brief.omittedContext.length,
      },
      unknowns,
      constraints,
      actions: {
        allowed: brief.allowedActions,
        denied: brief.deniedActions,
        confirmationRequired: brief.confirmationRequired,
      },
      evidenceContract: {
        requiredChecks: brief.evidenceContract.requirements.map((requirement) => ({
          checkId: requirement.id,
          label: requirement.label,
          kind: requirement.kind,
          command: null,
          blocking: requirement.required,
        })),
        expectedArtifacts: [],
        blockIntegration: brief.evidenceContract.policy.blockIntegration,
      },
      escalationPath: brief.escalationPath,
    },
  });
}
