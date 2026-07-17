import { describe, expect, it, vi } from "vitest";

import { createBrowserPlacementGateway } from "./browser";
import { placeSource } from "./gateway";
import type { PlacementRequest } from "./schema";

const request: PlacementRequest = {
  requestId: "request-browser-1",
  source: {
    sourceId: "source-browser-1",
    text: "Add a moving-cost comparison tool.",
  },
  baseRevisionId: "revision-browser-1",
  projection: {
    scopeId: "project-home-move",
    projectId: "node-project-home-move",
    selectedNodeId: "node-area-budget",
    nodes: [
      {
        id: "node-project-home-move",
        kind: "Project",
        title: "Plan our home move",
        summary: null,
        scopeId: "project-home-move",
        visibility: "shared",
      },
      {
        id: "node-area-budget",
        kind: "Idea",
        title: "Budget",
        summary: null,
        scopeId: "project-home-move",
        visibility: "shared",
      },
    ],
    relations: [
      {
        id: "relation-budget-project",
        kind: "belongs_to",
        fromNodeId: "node-area-budget",
        toNodeId: "node-project-home-move",
      },
    ],
  },
};

describe("browser placement gateway", () => {
  it("posts the validated request and validates the structured response", async () => {
    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    const fetchRequest = vi.fn(async () =>
      new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await createBrowserPlacementGateway({
      endpoint: "/custom-placement",
      fetch: fetchRequest,
    })(request);

    expect(response.ok).toBe(true);
    expect(fetchRequest).toHaveBeenCalledWith(
      "/custom-placement",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });

  it("fails closed when the route does not return a placement artifact", async () => {
    const gateway = createBrowserPlacementGateway({
      fetch: vi.fn(async () => Response.json({ ok: true })),
    });

    await expect(gateway(request)).rejects.toThrow();
  });
});
