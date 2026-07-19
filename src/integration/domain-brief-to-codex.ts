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
function projectDomainBriefToCodexRunRequest(
  brief: DomainAgentBrief,
  runId: string,
  mode: "live" | "replay",
  requestId: string,
): AgentRunRequest {
  if (brief.executionMode !== mode) {
    throw new Error(
      `Brief ${brief.id} is bound to ${brief.executionMode}; it cannot compile a ${mode} run request.`,
    );
  }
  const projected = projectAgentBrief(brief);
  const nonSharedNode = projected.context.nodes.find((node) => node.visibility !== "shared");
  if (nonSharedNode) {
    throw new Error(`Execution projection contains non-shared node ${nonSharedNode.id}.`);
  }

  return AgentRunRequestSchema.parse({
    runId,
    mode,
    requestId,
    authorization: null,
    brief: {
      briefId: brief.id,
      sourceRevisionId: brief.baseRevisionId,
      artifactBaseRef: brief.artifactBaseRef,
      delegationProfileId: projected.delegationProfileId,
      goal: projected.goal,
      doneMeans: projected.doneMeans,
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
      unknowns: projected.unknowns,
      constraints: projected.constraints,
      actions: {
        allowed: projected.authority.allowedActions,
        denied: projected.authority.deniedActions,
        confirmationRequired: projected.authority.confirmationRequired,
      },
      evidenceContract: {
        requiredChecks: projected.evidenceContract.requirements.map((requirement) => ({
          checkId: requirement.id,
          label: requirement.label,
          kind: requirement.kind,
          command: requirement.command,
          blocking: requirement.required,
        })),
        expectedArtifacts: projected.expectedArtifacts,
        blockIntegration: projected.evidenceContract.policy.blockIntegration,
      },
      escalationPath: projected.escalationPath,
    },
  });
}

/**
 * Produces a new executable request. Historical format-v1 briefs without a
 * host-owned profile remain readable but cannot cross this authority boundary.
 */
export function domainBriefToCodexRunRequest(
  brief: DomainAgentBrief,
  runId: string,
  mode: "live" | "replay",
  requestId: string,
): AgentRunRequest {
  if (brief.delegationProfileId === null) {
    throw new Error(
      `Legacy brief ${brief.id} has no host-registered delegation profile and is ineligible for execution.`,
    );
  }
  return projectDomainBriefToCodexRunRequest(brief, runId, mode, requestId);
}

/**
 * Reconstructs an immutable historical request for evidence comparison only.
 * Every Codex execution adapter independently rejects a null profile.
 */
export function projectDomainBriefToCodexRunRequestForAttestation(
  brief: DomainAgentBrief,
  runId: string,
  mode: "live" | "replay",
  requestId: string,
): AgentRunRequest {
  return projectDomainBriefToCodexRunRequest(brief, runId, mode, requestId);
}
