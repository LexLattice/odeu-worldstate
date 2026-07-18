"use client";

import {
  operatorAuthorizationHeaders,
  type OperatorCredentialProvider,
} from "@/adapters/operator-authorization/browser";

import {
  LiveEvidenceRequestSchema,
  LiveEvidenceResponseSchema,
  type LiveEvidenceRequest,
  type LiveEvidenceResponse,
} from "./schema";

export const BROWSER_LIVE_EVIDENCE_RESPONSE_MAX_LENGTH = 128 * 1_024;

export type BrowserLiveEvidenceGateway = (
  request: LiveEvidenceRequest,
) => Promise<LiveEvidenceResponse>;

export interface BrowserLiveEvidenceGatewayOptions {
  readonly endpoint?: string;
  readonly credentialProvider?: OperatorCredentialProvider;
  readonly fetch?: typeof fetch;
}

export class BrowserLiveEvidenceGatewayError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "BrowserLiveEvidenceGatewayError";
  }
}

/**
 * Calls the same-origin independent live-candidate verifier. Typed verifier
 * failures remain data; transport, body-bound, and schema failures throw.
 */
export function createBrowserLiveEvidenceGateway(
  options: BrowserLiveEvidenceGatewayOptions = {},
): BrowserLiveEvidenceGateway {
  const endpoint = options.endpoint ?? "/api/evidence/live";
  const fetchRequest = options.fetch ?? fetch;

  return async (input) => {
    const request = LiveEvidenceRequestSchema.parse(input);
    let response: Response;
    try {
      response = await fetchRequest(endpoint, {
        method: "POST",
        headers: operatorAuthorizationHeaders(options.credentialProvider, {
          "content-type": "application/json",
        }),
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw new BrowserLiveEvidenceGatewayError(
        "The independent live-candidate verifier transport failed before an HTTP response was observed.",
        null,
        { cause },
      );
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (cause) {
      throw new BrowserLiveEvidenceGatewayError(
        "The independent live-candidate verifier response body could not be read.",
        response.status,
        { cause },
      );
    }
    if (rawBody.length > BROWSER_LIVE_EVIDENCE_RESPONSE_MAX_LENGTH) {
      throw new BrowserLiveEvidenceGatewayError(
        "The independent live-candidate verifier response exceeded the browser evidence limit.",
        response.status,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (cause) {
      throw new BrowserLiveEvidenceGatewayError(
        "The independent live-candidate verifier returned a response that is not valid JSON.",
        response.status,
        { cause },
      );
    }
    const parsed = LiveEvidenceResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new BrowserLiveEvidenceGatewayError(
        "The independent live-candidate verifier returned JSON outside its bounded evidence schema.",
        response.status,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  };
}
