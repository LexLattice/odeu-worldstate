"use client";

import {
  parseWorldstateLedgerDocument,
  worldstateStateFromLedgerDocument,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";
import {
  operatorAuthorizationHeaders,
  type OperatorCredentialProvider,
} from "@/adapters/operator-authorization/browser";
import {
  ArtifactPromotionCommandResponseSchema,
  ArtifactPromotionStatusResponseSchema,
  resolveAuthorizedArtifactPromotion,
  type ArtifactPromotionCommandResponse,
  type ArtifactPromotionStatusResponse,
} from "@/integration/artifact-promotion";

import { ArtifactCandidateReceiptSchema } from "./schema";
import { resolveArtifactPromotionLedgerAuthority } from "./ledger-authority";

export const BROWSER_ARTIFACT_PROMOTION_RESPONSE_MAX_LENGTH = 768 * 1_024;
export const BROWSER_ARTIFACT_PROMOTION_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

export interface BrowserArtifactPromotionCommandInput {
  readonly document: WorldstateLedgerDocument;
  readonly promotionId: string;
}

export interface BrowserArtifactPromotionStatusInput {
  readonly document: WorldstateLedgerDocument;
  readonly promotionId: string;
}

export type BrowserArtifactPromotionGateway = (
  input: BrowserArtifactPromotionCommandInput,
) => Promise<ArtifactPromotionCommandResponse>;

export type BrowserArtifactPromotionStatusGetter = (
  input: BrowserArtifactPromotionStatusInput,
) => Promise<ArtifactPromotionStatusResponse>;

export interface BrowserArtifactPromotionOptions {
  readonly endpoint?: string;
  readonly statusEndpoint?: string;
  readonly credentialProvider?: OperatorCredentialProvider;
  readonly fetch?: typeof fetch;
}

export class BrowserArtifactPromotionGatewayError extends Error {
  constructor(
    readonly operation: "promote" | "status",
    readonly httpStatus: number | null,
    readonly outcome: "transport_failed" | "response_invalid",
    options: ErrorOptions = {},
  ) {
    super(
      operation === "promote"
        ? "The artifact promotion service did not return a valid bounded result."
        : "The artifact promotion status service did not return a valid bounded observation.",
      options,
    );
    this.name = "BrowserArtifactPromotionGatewayError";
  }
}

async function boundedResponse(input: {
  readonly response: Response;
  readonly operation: BrowserArtifactPromotionGatewayError["operation"];
}): Promise<unknown> {
  let raw: string;
  try {
    raw = await input.response.text();
  } catch (cause) {
    throw new BrowserArtifactPromotionGatewayError(
      input.operation,
      input.response.status,
      "response_invalid",
      { cause },
    );
  }
  if (new TextEncoder().encode(raw).byteLength > BROWSER_ARTIFACT_PROMOTION_RESPONSE_MAX_LENGTH) {
    throw new BrowserArtifactPromotionGatewayError(
      input.operation,
      input.response.status,
      "response_invalid",
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new BrowserArtifactPromotionGatewayError(
      input.operation,
      input.response.status,
      "response_invalid",
      { cause },
    );
  }
}

async function request(
  fetchRequest: typeof fetch,
  endpoint: string,
  operation: BrowserArtifactPromotionGatewayError["operation"],
  init: RequestInit,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  let response: Response;
  try {
    response = await fetchRequest(endpoint, init);
  } catch (cause) {
    throw new BrowserArtifactPromotionGatewayError(
      operation,
      null,
      "transport_failed",
      { cause },
    );
  }
  return { response, body: await boundedResponse({ response, operation }) };
}

/**
 * Sends only the exact durable ledger handoff and deterministic promotion ID.
 * The route derives all Git paths, refs, and signing material server-side.
 */
export function createBrowserArtifactPromotionGateway(
  options: BrowserArtifactPromotionOptions = {},
): BrowserArtifactPromotionGateway {
  const fetchRequest = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? "/api/artifacts/promote";
  return async (input) => {
    const document = parseWorldstateLedgerDocument(input.document);
    const authorized = resolveAuthorizedArtifactPromotion(
      worldstateStateFromLedgerDocument(document),
      input.promotionId,
    );
    const body = JSON.stringify({ document, promotionId: input.promotionId });
    if (new TextEncoder().encode(body).byteLength > BROWSER_ARTIFACT_PROMOTION_REQUEST_MAX_BYTES) {
      throw new BrowserArtifactPromotionGatewayError(
        "promote",
        null,
        "transport_failed",
      );
    }
    const observed = await request(fetchRequest, endpoint, "promote", {
      method: "POST",
      headers: operatorAuthorizationHeaders(options.credentialProvider, {
        "content-type": "application/json",
      }),
      body,
    });
    const parsed = ArtifactPromotionCommandResponseSchema.safeParse(observed.body);
    if (!parsed.success) {
      throw new BrowserArtifactPromotionGatewayError(
        "promote",
        observed.response.status,
        "response_invalid",
        { cause: parsed.error },
      );
    }
    if (parsed.data.ok) {
      if (
        parsed.data.promotionId !== input.promotionId ||
        (parsed.data.status === "completed" &&
          (parsed.data.receipt.promotionId !== input.promotionId ||
            parsed.data.receipt.candidateId !==
              authorized.proposal.candidateId ||
            parsed.data.receipt.repositoryId !==
              authorized.proposal.repositoryId ||
            parsed.data.receipt.targetRef !== authorized.proposal.targetRef ||
            parsed.data.receipt.expectedBaseCommit !==
              authorized.proposal.expectedBaseCommit ||
            parsed.data.receipt.candidateCommit !==
              authorized.proposal.candidateCommit))
      ) {
        throw new BrowserArtifactPromotionGatewayError(
          "promote",
          observed.response.status,
          "response_invalid",
        );
      }
    }
    return parsed.data;
  };
}

/** Reads the signed durable promotion journal without initiating a Git CAS. */
export function createBrowserArtifactPromotionStatusGetter(
  options: BrowserArtifactPromotionOptions = {},
): BrowserArtifactPromotionStatusGetter {
  const fetchRequest = options.fetch ?? fetch;
  const endpoint = options.statusEndpoint ?? "/api/artifacts/promote/status";
  return async (input) => {
    const document = parseWorldstateLedgerDocument(input.document);
    const { authorized } = resolveArtifactPromotionLedgerAuthority(
      document,
      input.promotionId,
    );
    const candidate = ArtifactCandidateReceiptSchema.parse(authorized.candidate);
    const body = JSON.stringify({ document, promotionId: input.promotionId });
    if (new TextEncoder().encode(body).byteLength > BROWSER_ARTIFACT_PROMOTION_REQUEST_MAX_BYTES) {
      throw new BrowserArtifactPromotionGatewayError(
        "status",
        null,
        "transport_failed",
      );
    }
    const observed = await request(
      fetchRequest,
      endpoint,
      "status",
      {
        method: "POST",
        headers: operatorAuthorizationHeaders(options.credentialProvider, {
          accept: "application/json",
          "content-type": "application/json",
        }),
        body,
      },
    );
    const parsed = ArtifactPromotionStatusResponseSchema.safeParse(observed.body);
    if (!parsed.success) {
      throw new BrowserArtifactPromotionGatewayError(
        "status",
        observed.response.status,
        "response_invalid",
        { cause: parsed.error },
      );
    }
    if (
      parsed.data.ok &&
      (parsed.data.promotionId !== input.promotionId ||
        (parsed.data.receipt !== null &&
          (parsed.data.receipt.promotionId !== input.promotionId ||
            parsed.data.receipt.candidateId !== candidate.metadata.candidateId)))
    ) {
      throw new BrowserArtifactPromotionGatewayError(
        "status",
        observed.response.status,
        "response_invalid",
      );
    }
    return parsed.data;
  };
}
