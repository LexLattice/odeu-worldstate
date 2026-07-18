import { NextResponse } from "next/server";
import { z, ZodError } from "zod";

import {
  LIVE_EVIDENCE_VERIFIER_IDENTITY,
  LiveEvidenceFailureSchema,
} from "@/adapters/live-evidence/schema";
import {
  LiveEvidenceUnavailableError,
  liveEvidenceFailure,
  parseLiveEvidenceRequest,
  verifyLiveEvidence,
  type LiveEvidenceRepositoryConfiguration,
  type LiveEvidenceVerifierOptions,
} from "@/adapters/live-evidence/server";
import {
  OperatorAuthorizationError,
  operatorAuthorizationFailureResponse,
  requireOperatorAuthorization,
} from "@/adapters/operator-authorization/server";

export const runtime = "nodejs";

const LIVE_EVIDENCE_REQUEST_MAX_BYTES = 512 * 1_024;
const LIVE_EVIDENCE_CONFIGURATION_MAX_BYTES = 64 * 1_024;
const LIVE_EVIDENCE_ERROR_MAX_ISSUES = 40;
const LIVE_EVIDENCE_ERROR_MAX_ISSUE_LENGTH = 2_000;

const SigningSecretsSchema = z.record(
  z.string().trim().min(1).max(240),
  z.string().min(16).max(16 * 1_024),
);
const RepositoryRegistrySchema = z.record(
  z.string().trim().min(1).max(240),
  z
    .object({
      repositoryPath: z.string().trim().min(1).max(4_096),
      toolchainPath: z.string().trim().min(1).max(4_096).optional(),
    })
    .strict(),
);

class LiveEvidenceRequestTooLargeError extends Error {
  constructor() {
    super("The live evidence request exceeds the verifier byte limit.");
    this.name = "LiveEvidenceRequestTooLargeError";
  }
}

function issues(error: ZodError): string[] {
  return error.issues
    .slice(0, LIVE_EVIDENCE_ERROR_MAX_ISSUES)
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .map((issue) => issue.slice(0, LIVE_EVIDENCE_ERROR_MAX_ISSUE_LENGTH));
}

function invalidRequest(
  message: string,
  options: { readonly issues?: readonly string[]; readonly status?: number } = {},
) {
  return NextResponse.json(
    LiveEvidenceFailureSchema.parse({
      ok: false,
      verifier: {
        identity: LIVE_EVIDENCE_VERIFIER_IDENTITY,
        version: 1,
        kind: "independent_live_candidate",
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
    declaredLength > LIVE_EVIDENCE_REQUEST_MAX_BYTES
  ) {
    throw new LiveEvidenceRequestTooLargeError();
  }
  if (!request.body) throw new SyntaxError("The request body is empty.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > LIVE_EVIDENCE_REQUEST_MAX_BYTES) {
      await reader.cancel();
      throw new LiveEvidenceRequestTooLargeError();
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

function configuredJson(name: string): unknown {
  const value = process.env[name];
  if (!value || Buffer.byteLength(value, "utf8") > LIVE_EVIDENCE_CONFIGURATION_MAX_BYTES) {
    throw new LiveEvidenceUnavailableError(
      "The live-evidence server configuration is unavailable.",
    );
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new LiveEvidenceUnavailableError(
      "The live-evidence server configuration is invalid.",
      { cause },
    );
  }
}

export function liveEvidenceConfigurationFromEnvironment(): Pick<
  LiveEvidenceVerifierOptions,
  "signingSecrets" | "repositories"
> {
  try {
    const signingSecrets = SigningSecretsSchema.parse(
      configuredJson("ODEU_LIVE_EVIDENCE_SIGNING_SECRETS"),
    );
    const repositories = RepositoryRegistrySchema.parse(
      configuredJson("ODEU_LIVE_EVIDENCE_REPOSITORIES"),
    ) as Readonly<Record<string, LiveEvidenceRepositoryConfiguration>>;
    if (
      Object.keys(signingSecrets).length === 0 ||
      Object.keys(repositories).length === 0
    ) {
      throw new LiveEvidenceUnavailableError(
        "The live-evidence server configuration is empty.",
      );
    }
    return { signingSecrets, repositories };
  } catch (error) {
    if (error instanceof LiveEvidenceUnavailableError) throw error;
    throw new LiveEvidenceUnavailableError(
      "The live-evidence server configuration did not satisfy its bounded contract.",
      { cause: error },
    );
  }
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

  let input: unknown;
  try {
    input = await boundedJson(request);
  } catch (error) {
    if (error instanceof LiveEvidenceRequestTooLargeError) {
      return invalidRequest(error.message, { status: 413 });
    }
    return invalidRequest(
      "The live evidence request body must be valid bounded JSON.",
    );
  }

  try {
    const parsed = parseLiveEvidenceRequest(input);
    const configuration = liveEvidenceConfigurationFromEnvironment();
    return NextResponse.json(
      await verifyLiveEvidence(parsed, configuration),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return invalidRequest(
        "The live evidence request did not satisfy the verifier contract.",
        { issues: issues(error) },
      );
    }
    const failure = liveEvidenceFailure(error);
    const status =
      failure.error.code === "replay_not_applicable"
        ? 409
        : failure.error.code === "verification_failed"
          ? 422
          : 503;
    return NextResponse.json(failure, { status });
  }
}
