import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  getLiveRunStatus,
  LiveAuthorityServerError,
} from "@/adapters/codex/live-authority-server";
import {
  OperatorAuthorizationError,
  operatorAuthorizationFailureResponse,
  requireOperatorAuthorization,
} from "@/adapters/operator-authorization/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireOperatorAuthorization(request);
  } catch (error) {
    if (error instanceof OperatorAuthorizationError) {
      return operatorAuthorizationFailureResponse(error);
    }
    throw error;
  }

  const url = new URL(request.url);
  try {
    const result = await getLiveRunStatus({
      runId: url.searchParams.get("runId"),
      requestId: url.searchParams.get("requestId"),
    });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_request",
            message: "The live status request requires bounded runId and requestId values.",
          },
        },
        { status: 400 },
      );
    }
    if (error instanceof LiveAuthorityServerError) {
      return NextResponse.json(
        {
          error: {
            code: "live_not_configured",
            message: "The private live-run status store is not configured.",
          },
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: "status_failed",
          message: "The live-run status service failed closed.",
        },
      },
      { status: 500 },
    );
  }
}
