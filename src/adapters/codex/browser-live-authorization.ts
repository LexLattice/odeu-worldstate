"use client";

import { parseWorldstateLedgerDocument } from "@/adapters/storage";
import {
  operatorAuthorizationHeaders,
  type OperatorCredentialProvider,
} from "@/adapters/operator-authorization/browser";

import {
  AgentRuntimeCapabilitySchema,
  LIVE_AUTHORIZATION_MAX_BODY_BYTES,
  LiveAuthorizationRequestSchema,
  LiveAuthorizedAgentRunRequestSchema,
  LiveRunStatusResponseSchema,
  type AgentRuntimeCapability,
  type BrowserLiveAuthorizationGateway,
  type LiveRunStatusRequest,
  type LiveRunStatusResponse,
} from "./live-authorization";

export type {
  AgentRuntimeCapability,
  BrowserLiveAuthorizationGateway,
} from "./live-authorization";

export type BrowserAgentRuntimeCapabilityGetter =
  () => Promise<AgentRuntimeCapability>;
export type BrowserLiveRunStatusGetter = (
  input: LiveRunStatusRequest,
) => Promise<LiveRunStatusResponse>;

export interface BrowserLiveAuthorityGatewayOptions {
  readonly authorizationEndpoint?: string;
  readonly capabilityEndpoint?: string;
  readonly statusEndpoint?: string;
  readonly credentialProvider?: OperatorCredentialProvider;
  readonly fetch?: typeof fetch;
}

export class BrowserLiveAuthorityGatewayError extends Error {
  constructor(
    readonly operation: "authorize" | "capability" | "status",
    readonly httpStatus: number | null,
    readonly outcome: "transport_failed" | "response_invalid",
    options: ErrorOptions = {},
  ) {
    super(
      operation === "authorize"
        ? "The live authority service did not return a valid authorized request."
        : operation === "capability"
          ? "The live authority service did not return a valid runtime capability."
          : "The live authority service did not return a valid durable run status.",
      options,
    );
    this.name = "BrowserLiveAuthorityGatewayError";
  }
}

async function readJson(
  fetchRequest: typeof fetch,
  endpoint: string,
  operation: BrowserLiveAuthorityGatewayError["operation"],
  init?: RequestInit,
): Promise<{
  readonly body: unknown;
  readonly ok: boolean;
  readonly status: number;
}> {
  let response: Response;
  try {
    response = await fetchRequest(endpoint, init);
  } catch (cause) {
    throw new BrowserLiveAuthorityGatewayError(
      operation,
      null,
      "transport_failed",
      { cause },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch (cause) {
    throw new BrowserLiveAuthorityGatewayError(
      operation,
      response.status,
      "response_invalid",
      { cause },
    );
  }
  return { body, ok: response.ok, status: response.status };
}

export function createBrowserLiveAuthorizationGateway(
  options: BrowserLiveAuthorityGatewayOptions = {},
): BrowserLiveAuthorizationGateway {
  const fetchRequest = options.fetch ?? fetch;
  const endpoint = options.authorizationEndpoint ?? "/api/agent/authorize";

  return async (input) => {
    const document = parseWorldstateLedgerDocument(input.document);
    const request = LiveAuthorizationRequestSchema.parse({
      ...input,
      document,
    });
    const serialized = JSON.stringify(request);
    if (
      new TextEncoder().encode(serialized).byteLength >
      LIVE_AUTHORIZATION_MAX_BODY_BYTES
    ) {
      throw new BrowserLiveAuthorityGatewayError(
        "authorize",
        null,
        "transport_failed",
      );
    }
    const response = await readJson(fetchRequest, endpoint, "authorize", {
      method: "POST",
      headers: operatorAuthorizationHeaders(options.credentialProvider, {
        "content-type": "application/json",
      }),
      body: serialized,
    });
    const parsed = LiveAuthorizedAgentRunRequestSchema.safeParse(response.body);
    if (
      !response.ok ||
      !parsed.success ||
      parsed.data.runId !== request.runId ||
      parsed.data.requestId !== request.requestId
    ) {
      throw new BrowserLiveAuthorityGatewayError(
        "authorize",
        response.status,
        "response_invalid",
        { cause: parsed.success ? undefined : parsed.error },
      );
    }
    return parsed.data;
  };
}

export function createBrowserAgentRuntimeCapabilityGetter(
  options: BrowserLiveAuthorityGatewayOptions = {},
): BrowserAgentRuntimeCapabilityGetter {
  const fetchRequest = options.fetch ?? fetch;
  const endpoint = options.capabilityEndpoint ?? "/api/agent/capability";

  return async () => {
    const response = await readJson(fetchRequest, endpoint, "capability", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const parsed = AgentRuntimeCapabilitySchema.safeParse(response.body);
    if (!response.ok || !parsed.success) {
      throw new BrowserLiveAuthorityGatewayError(
        "capability",
        response.status,
        "response_invalid",
        { cause: parsed.error },
      );
    }
    return parsed.data;
  };
}

export function createBrowserLiveRunStatusGetter(
  options: BrowserLiveAuthorityGatewayOptions = {},
): BrowserLiveRunStatusGetter {
  const fetchRequest = options.fetch ?? fetch;
  const endpoint = options.statusEndpoint ?? "/api/agent/status";

  return async (input) => {
    const query = new URLSearchParams({
      runId: input.runId,
      requestId: input.requestId,
    });
    const response = await readJson(
      fetchRequest,
      `${endpoint}?${query.toString()}`,
      "status",
      {
        method: "GET",
        headers: operatorAuthorizationHeaders(options.credentialProvider, {
          accept: "application/json",
        }),
      },
    );
    const parsed = LiveRunStatusResponseSchema.safeParse(response.body);
    if (!response.ok || !parsed.success) {
      throw new BrowserLiveAuthorityGatewayError(
        "status",
        response.status,
        "response_invalid",
        { cause: parsed.error },
      );
    }
    return parsed.data;
  };
}
