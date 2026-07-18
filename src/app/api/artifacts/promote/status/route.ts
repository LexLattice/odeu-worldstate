import { NextResponse } from "next/server";
import { z, ZodError } from "zod";

import {
  ArtifactPromotionBoundaryError,
  getArtifactPromotionStatus,
} from "@/adapters/artifact-promotion/server";
import { resolveArtifactPromotionLedgerAuthority } from "@/adapters/artifact-promotion/ledger-authority";
import { artifactPromotionAuthorityBinding } from "@/adapters/artifact-promotion/authority-binding-server";
import {
  OperatorAuthorizationError,
  operatorAuthorizationFailureResponse,
  requireOperatorAuthorization,
} from "@/adapters/operator-authorization/server";
import {
  LedgerDocumentSchema,
  parseWorldstateLedgerDocument,
} from "@/adapters/storage";
import {
  ArtifactPromotionCompilationError,
  ArtifactPromotionStatusResponseSchema,
} from "@/integration/artifact-promotion";

import {
  ArtifactPromotionConfigurationError,
  artifactPromotionConfigurationFromEnvironment,
} from "../server-configuration";

export const runtime = "nodejs";

const STATUS_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
const STATUS_REQUEST_MAX_EVENTS = 5_000;
const StatusTransportDocumentSchema = LedgerDocumentSchema.extend({
  events: z.array(z.unknown()).max(STATUS_REQUEST_MAX_EVENTS),
}).strict();
const StatusCommandSchema = z
  .object({
    document: StatusTransportDocumentSchema,
    promotionId: z.string().regex(/^artifact-promotion:sha256:[0-9a-f]{64}$/),
  })
  .strict();

class StatusRequestTooLargeError extends Error {}

function failure(
  code:
    | "invalid_request"
    | "promotion_not_authorized"
    | "promotion_unavailable"
    | "promotion_failed",
  message: string,
  status: number,
) {
  return NextResponse.json(
    ArtifactPromotionStatusResponseSchema.parse({
      ok: false,
      error: { code, message },
    }),
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function boundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > STATUS_REQUEST_MAX_BYTES
  ) {
    throw new StatusRequestTooLargeError();
  }
  if (!request.body) throw new SyntaxError("empty body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > STATUS_REQUEST_MAX_BYTES) {
      await reader.cancel();
      throw new StatusRequestTooLargeError();
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

/** Body-based read: this endpoint never invokes the Git CAS command. */
export async function POST(request: Request) {
  try {
    requireOperatorAuthorization(request);
  } catch (error) {
    if (error instanceof OperatorAuthorizationError) {
      return operatorAuthorizationFailureResponse(error);
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = await boundedJson(request);
  } catch (error) {
    return failure(
      "invalid_request",
      error instanceof StatusRequestTooLargeError
        ? "The artifact promotion status handoff exceeds its bounded request size."
        : "The artifact promotion status handoff must be valid bounded JSON.",
      error instanceof StatusRequestTooLargeError ? 413 : 400,
    );
  }
  try {
    const input = StatusCommandSchema.parse(raw);
    const document = parseWorldstateLedgerDocument(input.document);
    const ledgerAuthority = resolveArtifactPromotionLedgerAuthority(
      document,
      input.promotionId,
    );
    const { authorized } = ledgerAuthority;
    const configuration = artifactPromotionConfigurationFromEnvironment();
    if (
      authorized.proposal.repositoryId !== configuration.repositoryId ||
      authorized.proposal.targetRef !== configuration.targetRef
    ) {
      return failure(
        "promotion_not_authorized",
        "The authorized candidate does not target this configured artifact boundary.",
        409,
      );
    }
    const observation = await getArtifactPromotionStatus({
      candidate: authorized.candidate,
      signingSecrets: {
        [configuration.signingKeyId]: configuration.signingSecret,
      },
      statusStoreDirectory: configuration.statusStoreDirectory,
      authority: artifactPromotionAuthorityBinding(ledgerAuthority),
    });
    return NextResponse.json(
      ArtifactPromotionStatusResponseSchema.parse({
        ok: true,
        status: observation.state,
        promotionId: observation.promotionId,
        receipt:
          observation.state === "completed" ? observation.receipt : null,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return failure(
        "invalid_request",
        "The artifact promotion status handoff does not satisfy its bounded schema.",
        400,
      );
    }
    if (error instanceof ArtifactPromotionCompilationError) {
      return failure(
        "promotion_not_authorized",
        "The ledger does not contain an exact current human-authorized promotion.",
        409,
      );
    }
    if (error instanceof ArtifactPromotionConfigurationError) {
      return failure(
        "promotion_unavailable",
        "The artifact promotion status service is unavailable.",
        503,
      );
    }
    if (error instanceof ArtifactPromotionBoundaryError) {
      return failure(
        error.code === "invalid_configuration"
          ? "promotion_unavailable"
          : "promotion_failed",
        error.code === "invalid_configuration"
          ? "The artifact promotion status service is unavailable."
          : "The durable promotion status could not be verified.",
        error.code === "invalid_configuration" ? 503 : 409,
      );
    }
    return failure(
      "promotion_failed",
      "The artifact promotion status boundary failed closed.",
      500,
    );
  }
}
