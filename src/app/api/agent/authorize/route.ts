import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  authorizeAndPublishLiveRun,
  LiveAuthorityServerError,
} from "@/adapters/codex/live-authority-server";
import { LIVE_AUTHORIZATION_MAX_BODY_BYTES } from "@/adapters/codex/live-authorization";
import {
  OperatorAuthorizationError,
  operatorAuthorizationFailureResponse,
  requireOperatorAuthorization,
} from "@/adapters/operator-authorization/server";

export const runtime = "nodejs";

function publicFailure(error: unknown): {
  readonly status: number;
  readonly body: {
    readonly error: {
      readonly code: string;
      readonly message: string;
    };
  };
} {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid_request",
          message: "The live authorization request is not a valid bounded worldstate ledger handoff.",
        },
      },
    };
  }
  if (error instanceof LiveAuthorityServerError) {
    const status =
      error.code === "live_not_configured" ||
      error.code === "workspace_not_ready"
        ? 503
        : 409;
    const message =
      error.code === "artifact_base_mismatch"
        ? "The queued run does not target the prepared workspace revision."
        : error.code === "run_not_dispatchable"
          ? "The supplied ledger does not contain the requested queued live run."
          : error.code === "authorization_conflict"
            ? "This live run already has a different authorization intent."
            : error.code === "outcome_unknown"
              ? "This live run has an unreconciled prior dispatch."
              : error.code === "workspace_not_ready"
                ? "The live execution workspace is not prepared."
                : "Live execution is not fully configured.";
    return { status, body: { error: { code: error.code, message } } };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "authority_failed",
        message: "The live authority service failed closed.",
      },
    },
  };
}

export async function POST(request: Request) {
  try {
    requireOperatorAuthorization(request);
  } catch (error) {
    if (error instanceof OperatorAuthorizationError) {
      return operatorAuthorizationFailureResponse(error);
    }
    throw error;
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > LIVE_AUTHORIZATION_MAX_BODY_BYTES
  ) {
    return NextResponse.json(
      {
        error: {
          code: "request_too_large",
          message: "The live authorization request exceeds the bounded handoff size.",
        },
      },
      { status: 413 },
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_request",
          message: "The live authorization request body could not be read.",
        },
      },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(raw, "utf8") > LIVE_AUTHORIZATION_MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        error: {
          code: "request_too_large",
          message: "The live authorization request exceeds the bounded handoff size.",
        },
      },
      { status: 413 },
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_request",
          message: "The live authorization request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await authorizeAndPublishLiveRun(input));
  } catch (error) {
    const failure = publicFailure(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
