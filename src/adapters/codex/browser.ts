"use client";

import { fingerprint } from "@/domain/determinism";

import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  type AgentRunRequest,
  type AgentRunResponse,
} from "./schema";

export type BrowserAgentGateway = (
  request: AgentRunRequest,
) => Promise<AgentRunResponse>;

export interface BrowserAgentGatewayOptions {
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

export const BROWSER_AGENT_BODY_EXCERPT_MAX_LENGTH = 2_000;
export const BROWSER_AGENT_CONTENT_TYPE_MAX_LENGTH = 1_000;

export type BrowserAgentGatewayFailureOutcome =
  | "transport_failed"
  | "response_invalid";

export interface BrowserAgentGatewayFailureObservation {
  readonly requestId: string;
  readonly runId: string;
  readonly outcome: BrowserAgentGatewayFailureOutcome;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly bodyExcerpt: string | null;
  readonly bodyTruncated: boolean;
  readonly bodyDigest: string | null;
}

export class BrowserAgentGatewayError
  extends Error
  implements BrowserAgentGatewayFailureObservation
{
  readonly requestId: string;
  readonly runId: string;
  readonly outcome: BrowserAgentGatewayFailureOutcome;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly bodyExcerpt: string | null;
  readonly bodyTruncated: boolean;
  readonly bodyDigest: string | null;

  constructor(
    message: string,
    observation: BrowserAgentGatewayFailureObservation,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "BrowserAgentGatewayError";
    this.requestId = observation.requestId;
    this.runId = observation.runId;
    this.outcome = observation.outcome;
    this.httpStatus = observation.httpStatus;
    this.contentType = observation.contentType;
    this.bodyExcerpt = observation.bodyExcerpt;
    this.bodyTruncated = observation.bodyTruncated;
    this.bodyDigest = observation.bodyDigest;
  }
}

function unknownBodyObservation(input: {
  readonly requestId: string;
  readonly runId: string;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
}): BrowserAgentGatewayFailureObservation {
  return {
    ...input,
    outcome: "transport_failed",
    bodyExcerpt: null,
    bodyTruncated: false,
    bodyDigest: null,
  };
}

function invalidBodyObservation(input: {
  readonly requestId: string;
  readonly runId: string;
  readonly httpStatus: number;
  readonly contentType: string | null;
  readonly rawBody: string;
}): BrowserAgentGatewayFailureObservation {
  return {
    requestId: input.requestId,
    runId: input.runId,
    outcome: "response_invalid",
    httpStatus: input.httpStatus,
    contentType: input.contentType,
    bodyExcerpt: input.rawBody.slice(0, BROWSER_AGENT_BODY_EXCERPT_MAX_LENGTH),
    bodyTruncated:
      input.rawBody.length > BROWSER_AGENT_BODY_EXCERPT_MAX_LENGTH,
    bodyDigest: fingerprint(input.rawBody),
  };
}

function boundedContentType(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized
    ? normalized.slice(0, BROWSER_AGENT_CONTENT_TYPE_MAX_LENGTH)
    : null;
}

/**
 * Calls the same-origin agent route and validates its JSON schema. Immutable
 * run binding is deliberately checked by the ledger normalizer: a schema-valid
 * incoherent response must remain exact evidence even though it cannot produce
 * lifecycle or closure truth. Non-success HTTP bodies are evidence too.
 */
export function createBrowserAgentGateway(
  options: BrowserAgentGatewayOptions = {},
): BrowserAgentGateway {
  const endpoint = options.endpoint ?? "/api/agent";
  const fetchRequest = options.fetch ?? fetch;

  return async (input) => {
    const request = AgentRunRequestSchema.parse(input);
    let httpResponse: Response;
    try {
      httpResponse = await fetchRequest(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw new BrowserAgentGatewayError(
        "The Codex gateway transport failed before an HTTP response was observed.",
        unknownBodyObservation({
          requestId: request.requestId,
          runId: request.runId,
          httpStatus: null,
          contentType: null,
        }),
        { cause },
      );
    }

    const httpStatus = httpResponse.status;
    const contentType = boundedContentType(
      httpResponse.headers.get("content-type"),
    );
    let rawBody: string;
    try {
      rawBody = await httpResponse.text();
    } catch (cause) {
      throw new BrowserAgentGatewayError(
        "The Codex gateway response body could not be read.",
        unknownBodyObservation({
          requestId: request.requestId,
          runId: request.runId,
          httpStatus,
          contentType,
        }),
        { cause },
      );
    }

    const invalidObservation = invalidBodyObservation({
      requestId: request.requestId,
      runId: request.runId,
      httpStatus,
      contentType,
      rawBody,
    });
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (cause) {
      throw new BrowserAgentGatewayError(
        "The Codex gateway returned a response body that is not valid JSON.",
        invalidObservation,
        { cause },
      );
    }

    const parsed = AgentRunResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new BrowserAgentGatewayError(
        "The Codex gateway returned JSON that does not match the agent response schema.",
        invalidObservation,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  };
}
