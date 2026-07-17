import { describe, expect, it } from "vitest";

import {
  PlacementSuccessResponseSchema,
  placeSource,
} from "@/adapters/manager";
import { HOME_MOVE_ACTORS } from "@/fixtures";

import {
  assertPlacementResponseMatchesRequest,
  parsePlacementAttemptSource,
  parsePlacementExchange,
  parsePlacementExchangeSource,
  placementAttemptSourceEvent,
  placementAttemptSourceId,
  placementExchangeSourceEvent,
  placementExchangeSourceId,
  PlacementResponseCoherenceError,
} from "./placement-evidence";

const request = {
  requestId: "request-placement-evidence-001",
  source: {
    sourceId: "source-placement-evidence-001",
    text: "Compare our moving provider quotes.",
  },
  baseRevisionId: "revision-placement-evidence-001",
  projection: {
    scopeId: "project-home-move",
    projectId: "project-home-move",
    selectedNodeId: "area-budget",
    nodes: [
      {
        id: "project-home-move",
        kind: "Project" as const,
        title: "Plan our home move",
        summary: null,
        scopeId: "project-home-move",
        visibility: "shared" as const,
      },
      {
        id: "area-budget",
        kind: "Idea" as const,
        title: "Budget",
        summary: null,
        scopeId: "project-home-move",
        visibility: "shared" as const,
      },
    ],
    relations: [],
  },
};

describe("placement exchange evidence", () => {
  it("round-trips the exact bounded attempt with system-only posture", () => {
    const event = placementAttemptSourceEvent({
      request,
      eventId: "event-placement-attempt-001",
      commandId: "command-placement-attempt-001",
      occurredAt: "2026-07-17T08:59:00.000Z",
      actor: HOME_MOVE_ACTORS.system,
    });

    expect(event.payload.source.id).toBe(
      placementAttemptSourceId(request.requestId),
    );
    expect(parsePlacementAttemptSource(event.payload.source)?.request).toEqual(
      request,
    );
    expect(
      parsePlacementAttemptSource({
        ...event.payload.source,
        id: "source-placement-attempt:another-request",
      }),
    ).toBeNull();
    expect(
      parsePlacementAttemptSource({
        ...event.payload.source,
        visibility: "private",
      }),
    ).toBeNull();
  });

  it("round-trips the exact validated manager exchange as a source artifact", async () => {
    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    const event = placementExchangeSourceEvent({
      request,
      response: result.body,
      eventId: "event-placement-evidence-001",
      commandId: "command-placement-evidence-001",
      occurredAt: "2026-07-17T09:00:00.000Z",
      actor: HOME_MOVE_ACTORS.manager,
    });

    expect(event.payload.source.id).toBe(
      placementExchangeSourceId(request.requestId),
    );
    expect(event.payload.source.integrity).toMatchObject({
      algorithm: "fnv1a64",
      digest: expect.stringMatching(/^fnv1a64:[0-9a-f]{16}$/),
    });
    expect(parsePlacementExchange(event.payload.source.content)).toEqual({
      kind: "odeu.manager-placement-exchange",
      version: 1,
      request,
      response: result.body,
    });
    expect(parsePlacementExchangeSource(event.payload.source)).not.toBeNull();
    expect(
      parsePlacementExchangeSource({
        ...event.payload.source,
        content: event.payload.source.content.replace(
          request.requestId,
          "request-placement-evidence-tampered",
        ),
      }),
    ).toBeNull();
    expect(
      parsePlacementExchangeSource({
        ...event.payload.source,
        kind: "text",
      }),
    ).toBeNull();
  });

  it("fails closed for arbitrary source content", () => {
    expect(parsePlacementExchange("not placement evidence")).toBeNull();
  });

  it("binds a success response to the exact request and bounded projection", async () => {
    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    expect(result.body.ok).toBe(true);
    expect(() =>
      assertPlacementResponseMatchesRequest(request, result.body),
    ).not.toThrow();

    if (!result.body.ok) throw new Error("Expected fixture placement success.");
    const mismatched = structuredClone(result.body);
    mismatched.receipt.requestId = "request-from-an-earlier-retry";
    mismatched.receipt.sourceId = "source-from-another-request";
    mismatched.receipt.location.targetNodeId = "node-outside-projection";

    expect(() =>
      assertPlacementResponseMatchesRequest(request, mismatched),
    ).toThrow(PlacementResponseCoherenceError);
    try {
      assertPlacementResponseMatchesRequest(request, mismatched);
    } catch (error) {
      expect(error).toBeInstanceOf(PlacementResponseCoherenceError);
      expect((error as PlacementResponseCoherenceError).issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("receipt.sourceId"),
          expect.stringContaining("receipt.requestId"),
          expect.stringContaining("outside the request projection"),
        ]),
      );
    }
  });

  it("rejects contradictory receipt decision states at the trust boundary", async () => {
    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    if (!result.body.ok) throw new Error("Expected fixture placement success.");

    const missingLocation = structuredClone(result.body);
    missingLocation.receipt.location.targetNodeId = null;
    expect(PlacementSuccessResponseSchema.safeParse(missingLocation).success).toBe(
      false,
    );

    const missingQuestion = structuredClone(result.body);
    missingQuestion.receipt.decisionState = "needs_clarification";
    missingQuestion.receipt.location.targetNodeId = null;
    missingQuestion.receipt.clarificationQuestion = null;
    missingQuestion.delta = null;
    expect(PlacementSuccessResponseSchema.safeParse(missingQuestion).success).toBe(
      false,
    );
  });
});
