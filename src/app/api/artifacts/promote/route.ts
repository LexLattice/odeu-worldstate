import { NextResponse } from "next/server";
import { z, ZodError } from "zod";

import {
  ArtifactPromotionBoundaryError,
  ArtifactPromotionOutcomeUnknownError,
  promoteArtifactCandidate,
} from "@/adapters/artifact-promotion/server";
import { resolveArtifactPromotionLedgerAuthority } from "@/adapters/artifact-promotion/ledger-authority";
import { artifactPromotionAuthorityBinding } from "@/adapters/artifact-promotion/authority-binding-server";
import {
  LiveAuthorityServerError,
  verifyPrivateCompletedLiveCandidate,
} from "@/adapters/codex/live-authority-server";
import {
  LiveEvidenceUnavailableError,
  LiveEvidenceVerificationFailedError,
  verifyLiveEvidence,
} from "@/adapters/live-evidence/server";
import {
  OperatorAuthorizationError,
  operatorAuthorizationFailureResponse,
  requireOperatorAuthorization,
} from "@/adapters/operator-authorization/server";
import {
  LedgerDocumentSchema,
  parseWorldstateLedgerDocument,
  worldstateStateFromLedgerDocument,
} from "@/adapters/storage";
import { stableStringify } from "@/domain";
import {
  ArtifactPromotionCommandResponseSchema,
  ArtifactPromotionCompilationError,
  resolveAuthorizedArtifactPromotion,
} from "@/integration/artifact-promotion";

import {
  ArtifactPromotionConfigurationError,
  artifactPromotionConfigurationFromEnvironment,
  artifactPromotionLiveEvidenceConfigurationFromEnvironment,
} from "./server-configuration";

export const runtime = "nodejs";

const PROMOTION_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
const PROMOTION_REQUEST_MAX_EVENTS = 5_000;
const PromotionTransportDocumentSchema = LedgerDocumentSchema.extend({
  events: z.array(z.unknown()).max(PROMOTION_REQUEST_MAX_EVENTS),
}).strict();
const PromotionCommandSchema = z
  .object({
    document: PromotionTransportDocumentSchema,
    promotionId: z.string().regex(/^artifact-promotion:sha256:[0-9a-f]{64}$/),
  })
  .strict();

class PromotionRequestTooLargeError extends Error {}

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
    ArtifactPromotionCommandResponseSchema.parse({
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
    declaredLength > PROMOTION_REQUEST_MAX_BYTES
  ) {
    throw new PromotionRequestTooLargeError();
  }
  if (!request.body) throw new SyntaxError("empty body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > PROMOTION_REQUEST_MAX_BYTES) {
      await reader.cancel();
      throw new PromotionRequestTooLargeError();
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
      error instanceof PromotionRequestTooLargeError
        ? "The artifact promotion handoff exceeds its bounded request size."
        : "The artifact promotion handoff must be valid bounded JSON.",
      error instanceof PromotionRequestTooLargeError ? 413 : 400,
    );
  }

  try {
    const input = PromotionCommandSchema.parse(raw);
    const document = parseWorldstateLedgerDocument(input.document);
    const authorized = resolveAuthorizedArtifactPromotion(
      worldstateStateFromLedgerDocument(document),
      input.promotionId,
    );
    const ledgerAuthority = resolveArtifactPromotionLedgerAuthority(
      document,
      input.promotionId,
    );
    if (
      stableStringify(ledgerAuthority.authorized.proposal) !==
        stableStringify(authorized.proposal) ||
      stableStringify(ledgerAuthority.authorized.candidate) !==
        stableStringify(authorized.candidate)
    ) {
      return failure(
        "promotion_not_authorized",
        "The current promotion does not match its exact human-authorized ledger prefix.",
        409,
      );
    }
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

    const liveEvidenceConfiguration =
      artifactPromotionLiveEvidenceConfigurationFromEnvironment();
    const privateProvenance = await verifyPrivateCompletedLiveCandidate(
      authorized.candidate,
    );
    const privateBrief = privateProvenance.request.brief;
    const expectedRequirements =
      privateBrief.evidenceContract.requiredChecks.map((check) => ({
        requirementId: check.checkId,
        label: check.label,
        kind: check.kind,
        command: check.command,
        required: check.blocking,
      }));
    if (
      authorized.validationRequest.runId !== privateProvenance.request.runId ||
      authorized.validationRequest.briefId !== privateBrief.briefId ||
      authorized.validationRequest.baseRevisionId !==
        privateBrief.sourceRevisionId ||
      authorized.validationRequest.artifactBaseRef !==
        privateBrief.artifactBaseRef ||
      stableStringify(authorized.validationRequest.evidenceRequirements) !==
        stableStringify(expectedRequirements) ||
      stableStringify(authorized.validationRequest.expectedArtifacts) !==
        stableStringify(privateBrief.evidenceContract.expectedArtifacts)
    ) {
      throw new LiveEvidenceVerificationFailedError(
        "The durable validation request does not match the private authorized live brief.",
      );
    }
    const revalidation = await verifyLiveEvidence(
      authorized.validationRequest,
      liveEvidenceConfiguration,
    );
    if (revalidation.status !== "passed") {
      throw new LiveEvidenceVerificationFailedError(
        "Independent live-candidate revalidation did not pass immediately before promotion.",
      );
    }

    try {
      const receipt = (
        await promoteArtifactCandidate({
          repository: configuration.repository,
          repositoryId: configuration.repositoryId,
          targetRef: configuration.targetRef,
          expectedBaseCommit: authorized.proposal.expectedBaseCommit,
          candidate: authorized.candidate,
          signingSecrets: {
            [configuration.signingKeyId]: configuration.signingSecret,
          },
          statusStoreDirectory: configuration.statusStoreDirectory,
          attemptedAt: new Date().toISOString(),
          authority: artifactPromotionAuthorityBinding(ledgerAuthority),
        })
      ).receipt;
      return NextResponse.json(
        ArtifactPromotionCommandResponseSchema.parse({
          ok: true,
          status: "completed",
          promotionId: input.promotionId,
          receipt,
        }),
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof ArtifactPromotionOutcomeUnknownError) {
        return NextResponse.json(
          ArtifactPromotionCommandResponseSchema.parse({
            ok: true,
            status: "outcome_unknown",
            promotionId: input.promotionId,
            receipt: null,
          }),
          {
            status: 202,
            headers: { "cache-control": "no-store" },
          },
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return failure(
        "invalid_request",
        "The artifact promotion handoff does not satisfy its bounded schema.",
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
        "The artifact promotion service is unavailable.",
        503,
      );
    }
    if (error instanceof LiveAuthorityServerError) {
      return failure(
        error.code === "live_not_configured"
          ? "promotion_unavailable"
          : "promotion_not_authorized",
        error.code === "live_not_configured"
          ? "Private live-run provenance is unavailable."
          : "The candidate is not present in an exact private returned live response.",
        error.code === "live_not_configured" ? 503 : 409,
      );
    }
    if (error instanceof LiveEvidenceUnavailableError) {
      return failure(
        "promotion_unavailable",
        "Independent live-candidate revalidation is unavailable.",
        503,
      );
    }
    if (error instanceof LiveEvidenceVerificationFailedError) {
      return failure(
        "promotion_failed",
        "Independent live-candidate revalidation did not pass.",
        422,
      );
    }
    if (error instanceof ArtifactPromotionBoundaryError) {
      return failure(
        error.code === "invalid_configuration"
          ? "promotion_unavailable"
          : "promotion_failed",
        error.code === "invalid_configuration"
          ? "The artifact promotion service is unavailable."
          : "The signed candidate could not be promoted at this boundary.",
        error.code === "invalid_configuration" ? 503 : 422,
      );
    }
    return failure(
      "promotion_failed",
      "The artifact promotion boundary failed closed.",
      500,
    );
  }
}
