import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  parseReplayEvidenceRequest,
  replayEvidenceFailure,
  verifyReplayEvidence,
} from "@/adapters/replay-evidence/server";
import { ReplayEvidenceFailureSchema } from "@/adapters/replay-evidence/schema";

export const runtime = "nodejs";

const REPLAY_EVIDENCE_REQUEST_MAX_BYTES = 256 * 1_024;
const REPLAY_EVIDENCE_ERROR_MAX_ISSUES = 40;
const REPLAY_EVIDENCE_ERROR_MAX_ISSUE_LENGTH = 2_000;

class ReplayEvidenceRequestTooLargeError extends Error {
  constructor() {
    super("The replay evidence request exceeds the verifier byte limit.");
    this.name = "ReplayEvidenceRequestTooLargeError";
  }
}

function issues(error: ZodError): string[] {
  return error.issues
    .slice(0, REPLAY_EVIDENCE_ERROR_MAX_ISSUES)
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .map((issue) => issue.slice(0, REPLAY_EVIDENCE_ERROR_MAX_ISSUE_LENGTH));
}

function invalidRequest(
  message: string,
  options: { readonly issues?: readonly string[]; readonly status?: number } = {},
) {
  return NextResponse.json(
    ReplayEvidenceFailureSchema.parse({
      ok: false,
      verifier: {
        identity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
        version: 1,
        kind: "independent_fixture",
      },
      error: {
        code: "invalid_request",
        message,
        issues: options.issues ?? [],
      },
    }),
    { status: options.status ?? 400 },
  );
}

async function boundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > REPLAY_EVIDENCE_REQUEST_MAX_BYTES
  ) {
    throw new ReplayEvidenceRequestTooLargeError();
  }
  if (!request.body) throw new SyntaxError("The request body is empty.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > REPLAY_EVIDENCE_REQUEST_MAX_BYTES) {
      await reader.cancel();
      throw new ReplayEvidenceRequestTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await boundedJson(request);
  } catch (error) {
    if (error instanceof ReplayEvidenceRequestTooLargeError) {
      return invalidRequest(error.message, { status: 413 });
    }
    return invalidRequest(
      "The replay evidence request body must be valid bounded JSON.",
    );
  }

  try {
    const parsed = parseReplayEvidenceRequest(input);
    return NextResponse.json(await verifyReplayEvidence(parsed));
  } catch (error) {
    if (error instanceof ZodError) {
      return invalidRequest(
        "The replay evidence request did not satisfy the verifier contract.",
        { issues: issues(error) },
      );
    }
    const failure = replayEvidenceFailure(error);
    return NextResponse.json(failure, {
      status: failure.error.code === "replay_not_applicable" ? 409 : 503,
    });
  }
}
