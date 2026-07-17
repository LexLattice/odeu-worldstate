import "server-only";

export {
  RunAuthorizationConsumedError,
  RunClaimBusyError,
  withUnclaimedRunMutation,
} from "./consumption";

import {
  runLiveCodex,
  LiveCodexBlockedError,
  LiveCodexConfigurationError,
  LiveCodexPreflightError,
} from "./live";
import { CodexReplayNotApplicableError, runCodexReplay } from "./replay";
import {
  AgentRunFailureSchema,
  AgentRunRequestSchema,
  type AgentRunFailure,
  type AgentRunRequest,
  type AgentRunSuccess,
} from "./schema";

export class CodexModeConfigurationError extends Error {
  constructor(readonly requestedMode: string) {
    super(`Codex mode ${requestedMode} is not supported. Use replay or live.`);
    this.name = "CodexModeConfigurationError";
  }
}

function requestedMode(): string {
  return process.env.ODEU_CODEX_MODE?.trim().toLowerCase() || "replay";
}

export async function runCodexAdapter(request: AgentRunRequest): Promise<AgentRunSuccess> {
  const mode = requestedMode();
  if (mode === "replay") {
    return runCodexReplay(request);
  }
  if (mode === "live") {
    return runLiveCodex(request);
  }
  throw new CodexModeConfigurationError(mode);
}

export function parseAgentRunRequest(input: unknown): AgentRunRequest {
  return AgentRunRequestSchema.parse(input);
}

export function codexFailure(error: unknown): AgentRunFailure {
  const mode = requestedMode();
  const configurationFailure = error instanceof LiveCodexConfigurationError;
  const preflightError = error instanceof LiveCodexPreflightError ? error : null;
  const preflightFailure = preflightError !== null;
  const modeFailure = error instanceof CodexModeConfigurationError;
  const replayMismatch = error instanceof CodexReplayNotApplicableError;
  const workerBlocked = error instanceof LiveCodexBlockedError;
  const effectiveMode = mode === "live" || mode === "replay" ? mode : null;

  return AgentRunFailureSchema.parse({
    ok: false,
    runtime: {
      requestedMode: mode,
      effectiveMode:
        modeFailure || configurationFailure || preflightFailure ? null : effectiveMode,
      status:
        workerBlocked
          ? "blocked"
          : modeFailure || configurationFailure || preflightFailure || replayMismatch
          ? "unavailable"
          : "failed",
      provider: "codex",
      replayIdentity: null,
      replayKind: null,
    },
    error: {
      code: modeFailure
        ? "invalid_mode"
        : preflightFailure
          ? preflightError.code
        : replayMismatch
        ? "replay_not_applicable"
        : configurationFailure
          ? "live_not_configured"
          : workerBlocked
            ? "worker_blocked"
          : "worker_failed",
      message: error instanceof Error ? error.message : "The Codex worker failed without a readable error.",
      issues: [],
    },
    briefPreserved: true,
    resumable: workerBlocked,
    resumeSupported: false,
    blockedRun: workerBlocked ? error.blockedRun : null,
  });
}
