import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { codexFailure, parseAgentRunRequest, runCodexAdapter } from "@/adapters/codex";
import {
  dispatchAuthorizedLiveRequest,
  LiveAuthorityServerError,
} from "@/adapters/codex/live-authority-server";
import {
  AgentRunFailureSchema,
  type AgentRunFailure,
  type AgentRunResponse,
} from "@/adapters/codex/schema";

export const runtime = "nodejs";
export const MAX_AGENT_REQUEST_BYTES = 2 * 1_024 * 1_024;

class AgentRequestTooLargeError extends Error {
  constructor() {
    super("The agent request body exceeds its configured byte limit.");
    this.name = "AgentRequestTooLargeError";
  }
}

function requestedMode() {
  return process.env.ODEU_CODEX_MODE?.trim().toLowerCase() || "replay";
}

function effectiveMode() {
  const mode = requestedMode();
  return mode === "replay" || mode === "live" ? mode : null;
}

function issueMessages(error: ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
  );
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      Number.isSafeInteger(parsedLength) &&
      parsedLength > MAX_AGENT_REQUEST_BYTES
    ) {
      throw new AgentRequestTooLargeError();
    }
  }
  if (request.body === null) throw new SyntaxError("Missing JSON body.");

  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_AGENT_REQUEST_BYTES);
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextByteLength = byteLength + value.byteLength;
      if (nextByteLength > MAX_AGENT_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AgentRequestTooLargeError();
      }
      bytes.set(value, byteLength);
      byteLength = nextByteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, byteLength),
    ),
  );
}

function invalidRequestFailure(
  message: string,
  issues: readonly string[] = [],
): AgentRunFailure {
  return AgentRunFailureSchema.parse({
    ok: false,
    runtime: {
      requestedMode: requestedMode(),
      effectiveMode: effectiveMode(),
      status: "unavailable",
      provider: "codex",
      replayIdentity: null,
      replayKind: null,
    },
    error: {
      code: "invalid_request",
      message,
      issues,
    },
    briefPreserved: true,
    resumable: false,
    resumeSupported: false,
    blockedRun: null,
  });
}

const PUBLIC_CODEX_FAILURE_MESSAGES: Record<
  AgentRunFailure["error"]["code"],
  string
> = {
  invalid_request: "The agent request did not satisfy the execution contract.",
  invalid_mode: "The configured agent execution mode is unavailable.",
  mode_mismatch: "The request cannot run in the configured execution mode.",
  replay_not_applicable: "No exact replay is available for this request.",
  live_not_configured: "The live agent runtime is unavailable.",
  authorization_invalid: "The live request authorization is invalid.",
  authorization_consumed: "The live request authorization is no longer usable.",
  run_claim_busy: "The requested run is already being processed.",
  revision_stale: "The authorized source revision is no longer current.",
  artifact_base_mismatch: "The authorized artifact base is no longer current.",
  run_not_dispatchable: "The requested run is not dispatchable.",
  workspace_busy: "The live workspace is currently in use.",
  workspace_dirty: "The live workspace is not clean enough to execute safely.",
  workspace_private_data: "The live workspace contains unsupported private data.",
  worker_blocked: "The live worker returned a blocked result.",
  worker_timed_out:
    "The live worker exceeded its configured deadline. Its workspace is quarantined for operator inspection.",
  worker_failed: "The agent worker failed.",
};

function publicCodexFailure(error: unknown): AgentRunFailure {
  const failure = codexFailure(error);
  return AgentRunFailureSchema.parse({
    ...failure,
    error: {
      ...failure.error,
      message: PUBLIC_CODEX_FAILURE_MESSAGES[failure.error.code],
      issues: [],
    },
  });
}

function responseStatus(response: AgentRunResponse): number {
  if (response.ok) return 200;
  const code = response.error.code;
  return code === "live_not_configured" || code === "invalid_mode"
    ? 503
    : code === "authorization_invalid"
      ? 403
      : code === "worker_failed"
        ? 500
        : code === "worker_timed_out"
          ? 504
        : 409;
}

function liveAuthorityFailure(error: LiveAuthorityServerError): AgentRunFailure {
  const code =
    error.code === "authorization_missing"
      ? "authorization_invalid"
      : error.code === "dispatch_in_progress"
        ? "run_claim_busy"
        : "authorization_consumed";
  return AgentRunFailureSchema.parse({
    ok: false,
    runtime: {
      requestedMode: requestedMode(),
      effectiveMode: null,
      status: "unavailable",
      provider: "codex",
      replayIdentity: null,
      replayKind: null,
    },
    error: {
      code,
      message:
        error.code === "authorization_missing"
          ? "The live request does not match a server-issued authorization intent."
          : error.code === "dispatch_in_progress"
            ? "The live run dispatch is already in progress."
            : "The live run has an unreconciled prior dispatch and will not be repeated.",
      issues: [],
    },
    briefPreserved: true,
    resumable: false,
    resumeSupported: false,
    blockedRun: null,
  });
}

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await readBoundedJson(request);
  } catch (error) {
    const oversized = error instanceof AgentRequestTooLargeError;
    return NextResponse.json(
      invalidRequestFailure(
        oversized
          ? "The agent request body exceeds the 2 MiB transport limit."
          : "The agent request body must be valid UTF-8 JSON.",
      ),
      { status: oversized ? 413 : 400 },
    );
  }

  try {
    const parsed = parseAgentRunRequest(input);
    const result =
      parsed.mode === "live"
        ? await dispatchAuthorizedLiveRequest(parsed, async () => {
            try {
              return await runCodexAdapter(parsed);
            } catch (error) {
              return publicCodexFailure(error);
            }
          })
        : await runCodexAdapter(parsed);
    return NextResponse.json(result, { status: responseStatus(result) });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        invalidRequestFailure(
          "The agent brief did not satisfy the execution contract.",
          issueMessages(error),
        ),
        { status: 400 },
      );
    }

    const failure =
      error instanceof LiveAuthorityServerError
        ? liveAuthorityFailure(error)
        : publicCodexFailure(error);
    return NextResponse.json(failure, {
      status: responseStatus(failure),
    });
  }
}
