import type { AgentRunRequest } from "./schema";

export class CodexRequestModeMismatchError extends Error {
  constructor(
    readonly requestMode: AgentRunRequest["mode"],
    readonly adapterMode: AgentRunRequest["mode"],
  ) {
    super(
      `The ${adapterMode} Codex adapter cannot execute a ${requestMode} run request.`,
    );
    this.name = "CodexRequestModeMismatchError";
  }
}

export function assertCodexRequestMode(
  request: AgentRunRequest,
  adapterMode: AgentRunRequest["mode"],
): void {
  if (request.mode !== adapterMode) {
    throw new CodexRequestModeMismatchError(request.mode, adapterMode);
  }
}
