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

export class CodexUnboundDelegationProfileError extends Error {
  constructor(readonly briefId: string) {
    super(
      `Legacy brief ${briefId} has no host-registered delegation profile and is ineligible for Codex execution.`,
    );
    this.name = "CodexUnboundDelegationProfileError";
  }
}

export function assertCodexRequestMode(
  request: AgentRunRequest,
  adapterMode: AgentRunRequest["mode"],
): void {
  if (request.brief.delegationProfileId === null) {
    throw new CodexUnboundDelegationProfileError(request.brief.briefId);
  }
  if (request.mode !== adapterMode) {
    throw new CodexRequestModeMismatchError(request.mode, adapterMode);
  }
}
