"use client";

import {
  PlacementRequestSchema,
  PlacementResponseSchema,
  type PlacementRequest,
  type PlacementResponse,
} from "./schema";

export type BrowserPlacementGateway = (
  request: PlacementRequest,
) => Promise<PlacementResponse>;

export interface BrowserPlacementGatewayOptions {
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

/**
 * Calls the same-origin placement boundary and validates the returned artifact
 * before it can enter the browser session. Error status bodies are intentional
 * placement artifacts too, so HTTP status alone does not discard their evidence.
 */
export function createBrowserPlacementGateway(
  options: BrowserPlacementGatewayOptions = {},
): BrowserPlacementGateway {
  const endpoint = options.endpoint ?? "/api/placement";
  const fetchRequest = options.fetch ?? fetch;

  return async (input) => {
    const request = PlacementRequestSchema.parse(input);
    const response = await fetchRequest(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json();
    return PlacementResponseSchema.parse(body);
  };
}
