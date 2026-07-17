import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { codexFailure, parseAgentRunRequest, runCodexAdapter } from "@/adapters/codex";

export const runtime = "nodejs";

function requestedMode() {
  return process.env.ODEU_CODEX_MODE?.trim().toLowerCase() || "replay";
}

function effectiveMode() {
  const mode = requestedMode();
  return mode === "replay" || mode === "live" ? mode : null;
}

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json(
      {
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
          message: "The agent request body must be valid JSON.",
          issues: [],
        },
        briefPreserved: true,
        resumable: false,
        resumeSupported: false,
        blockedRun: null,
      },
      { status: 400 },
    );
  }

  try {
    const parsed = parseAgentRunRequest(input);
    const result = await runCodexAdapter(parsed);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
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
            message: "The agent brief did not satisfy the execution contract.",
            issues: error.issues,
          },
          briefPreserved: true,
          resumable: false,
          resumeSupported: false,
          blockedRun: null,
        },
        { status: 400 },
      );
    }

    const failure = codexFailure(error);
    return NextResponse.json(failure, {
      status:
        failure.error.code === "live_not_configured"
          ? 503
          : failure.error.code === "invalid_mode"
            ? 503
          : failure.error.code === "replay_not_applicable"
            ? 409
            : failure.error.code === "authorization_invalid"
              ? 403
              : failure.error.code === "authorization_consumed"
                ? 409
              : failure.error.code === "run_claim_busy"
                ? 409
              : failure.error.code === "worker_blocked"
                ? 409
              : failure.error.code === "revision_stale" ||
                  failure.error.code === "artifact_base_mismatch" ||
                  failure.error.code === "run_not_dispatchable" ||
                  failure.error.code === "workspace_busy" ||
                  failure.error.code === "workspace_dirty" ||
                  failure.error.code === "workspace_private_data"
                ? 409
            : 500,
    });
  }
}
