import type { AgentBrief } from "./schema";

export function compileCodexPrompt(brief: AgentBrief): string {
  const workerProjection = {
    briefId: brief.briefId,
    sourceRevisionId: brief.sourceRevisionId,
    artifactBaseRef: brief.artifactBaseRef,
    goal: brief.goal,
    doneMeans: brief.doneMeans,
    environment: brief.environment,
    agentProfile: brief.agentProfile,
    context: { shared: brief.context.shared, relations: brief.context.relations },
    omittedContextCount: brief.context.omittedCount,
    unknowns: brief.unknowns,
    constraints: brief.constraints,
    actions: brief.actions,
    evidenceContract: brief.evidenceContract,
    escalationPath: brief.escalationPath,
  };

  return [
    "You are the bounded execution worker for an ODEU Worldstate agent brief.",
    "The immutable brief below is the complete authority boundary for this run.",
    "Work only inside the configured repository. Do not publish, push, message people, or broaden scope.",
    "If a required action is outside the allowed classes or needs confirmation, stop and report it as unresolved.",
    "Material outside this projection is intentionally unavailable; do not attempt to infer or retrieve it.",
    "Run the required checks you can lawfully run. Report observations and stable repo-local references, not hidden reasoning.",
    "Returning work does not commit worldstate and does not prove completion or verification.",
    "Respond only with the requested structured worker result. A blocked result is resumable and is not a closure witness.",
    "",
    "IMMUTABLE AGENT BRIEF",
    JSON.stringify(workerProjection, null, 2),
  ].join("\n");
}
