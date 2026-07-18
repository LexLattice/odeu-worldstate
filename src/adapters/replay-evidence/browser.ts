"use client";

import {
  ReplayEvidenceRequestSchema,
  ReplayEvidenceResponseSchema,
  type ReplayEvidenceRequest,
  type ReplayEvidenceResponse,
} from "./schema";

export const BROWSER_REPLAY_EVIDENCE_RESPONSE_MAX_LENGTH = 128 * 1_024;

export type BrowserReplayEvidenceGateway = (
  request: ReplayEvidenceRequest,
) => Promise<ReplayEvidenceResponse>;

export interface BrowserReplayEvidenceGatewayOptions {
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

export class BrowserReplayEvidenceGatewayError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "BrowserReplayEvidenceGatewayError";
  }
}

/**
 * Calls the read-only same-origin fixture verifier. Typed non-success results are
 * retained as verifier responses; transport or schema failures throw without
 * projecting an evidence validation.
 */
export function createBrowserReplayEvidenceGateway(
  options: BrowserReplayEvidenceGatewayOptions = {},
): BrowserReplayEvidenceGateway {
  const endpoint = options.endpoint ?? "/api/evidence/replay";
  const fetchRequest = options.fetch ?? fetch;

  return async (input) => {
    const request = ReplayEvidenceRequestSchema.parse(input);
    let response: Response;
    try {
      response = await fetchRequest(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw new BrowserReplayEvidenceGatewayError(
        "The independent replay verifier transport failed before an HTTP response was observed.",
        null,
        { cause },
      );
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (cause) {
      throw new BrowserReplayEvidenceGatewayError(
        "The independent replay verifier response body could not be read.",
        response.status,
        { cause },
      );
    }
    if (rawBody.length > BROWSER_REPLAY_EVIDENCE_RESPONSE_MAX_LENGTH) {
      throw new BrowserReplayEvidenceGatewayError(
        "The independent replay verifier response exceeded the browser evidence limit.",
        response.status,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (cause) {
      throw new BrowserReplayEvidenceGatewayError(
        "The independent replay verifier returned a response that is not valid JSON.",
        response.status,
        { cause },
      );
    }
    const parsed = ReplayEvidenceResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new BrowserReplayEvidenceGatewayError(
        "The independent replay verifier returned JSON outside its evidence schema.",
        response.status,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  };
}
