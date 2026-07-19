import { describe, expect, it, vi } from "vitest";

import { MOVING_COST_DELEGATION_PROFILE_ID } from "@/domain";

import { placeSource } from "./gateway";
import type { PlacementParser } from "./live";
import type {
  ManagerPlacementInterpretation,
  PlacementRequest,
} from "./schema";

const request: PlacementRequest = {
  requestId: "request-home-move-1",
  source: {
    sourceId: "source-home-move-1",
    text: "Ask Codex to add a moving-cost comparison tool.",
  },
  baseRevisionId: "revision-home-move-3",
  projection: {
    scopeId: "scope-home-move",
    projectId: "project-home-move",
    selectedNodeId: null,
    nodes: [
      {
        id: "project-home-move",
        kind: "Project",
        title: "Plan our home move",
        summary: "Coordinate the move.",
        scopeId: "scope-home-move",
        visibility: "shared",
      },
      {
        id: "area-budget",
        kind: "Idea",
        title: "Budget",
        summary: "Keep spending below the adopted limit.",
        scopeId: "scope-home-move",
        visibility: "shared",
      },
    ],
    relations: [
      {
        id: "relation-budget-project",
        kind: "belongs_to",
        fromNodeId: "area-budget",
        toNodeId: "project-home-move",
      },
    ],
  },
};

const liveInterpretation: ManagerPlacementInterpretation = {
  projectId: "project-home-move",
  locationTargetNodeId: "area-budget",
  locationLabel: "Budget",
  breadcrumb: ["Plan our home move", "Budget"],
  proposedKind: "Task",
  delegationProfileId: MOVING_COST_DELEGATION_PROFILE_ID,
  proposedTitle: "Compare provider quotes",
  proposedSummary: "Build a focused comparison for moving-provider costs.",
  rationale: "The source asks for actionable budget comparison work.",
  confidence: "high",
  uncertainty: ["Storage recurrence is not specified."],
  conflicts: [],
  alternatives: [
    {
      targetNodeId: "project-home-move",
      targetTitle: "Plan our home move",
      rationale: "Use project level if the tool expands beyond costs.",
    },
  ],
  affectedNodeIds: ["area-budget"],
  relations: [
    {
      kind: "belongs_to",
      targetNodeId: "area-budget",
      direction: "from_proposed",
      rationale: "The task belongs in the budget area.",
    },
  ],
  clarificationNeeded: false,
  clarificationQuestion: null,
};

describe("manager placement gateway", () => {
  it("returns a deterministic fixture proposal without credentials", async () => {
    const liveParser = vi.fn(() => {
      throw new Error("fixture mode must not call the provider");
    });
    const dependencies = {
      environment: { ODEU_MANAGER_MODE: "fixture" },
      liveParser,
    };

    const first = await placeSource(request, dependencies);
    const second = await placeSource(request, dependencies);

    expect(first).toEqual(second);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(liveParser).not.toHaveBeenCalled();

    if (!first.body.ok) {
      throw new Error("Expected a fixture success response");
    }

    expect(first.body.manager).toEqual({
      requestedMode: "fixture",
      effectiveMode: "fixture",
      status: "available",
      provider: "fixture",
      model: null,
      responseId: null,
    });
    expect(first.body.receipt.location.targetNodeId).toBe("area-budget");
    expect(first.body.receipt.proposed.delegationProfileId).toBe(
      MOVING_COST_DELEGATION_PROFILE_ID,
    );
    expect(first.body.receipt.baseRevisionId).toBe(request.baseRevisionId);
    expect(first.body.delta).toMatchObject({
      baseRevisionId: request.baseRevisionId,
      sourceId: request.source.sourceId,
      disposition: "pending_review",
      mutability: "immutable",
    });
    expect(first.body.delta?.operations[0]).toMatchObject({
      op: "node.add",
      node: {
        delegationProfileId: MOVING_COST_DELEGATION_PROFILE_ID,
        title: "Compare provider quotes",
      },
    });
    expect(Object.isFrozen(first.body.delta)).toBe(true);
    expect(Object.isFrozen(first.body.delta?.operations)).toBe(true);
  });

  it("bounds a long fixture source without rejecting the valid request", async () => {
    const sourceText = "x".repeat(4_000);

    const result = await placeSource(
      {
        ...request,
        source: { ...request.source, text: sourceText },
      },
      { environment: { ODEU_MANAGER_MODE: "fixture" } },
    );

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error("Expected fixture placement success.");

    expect(result.body.receipt.proposed.summary).toHaveLength(2_000);
    expect(result.body.receipt.proposed.summary).toMatch(/…$/);
    expect(result.body.receipt.uncertainty).toContain(
      "Fixture summary is excerpted; review the preserved original source.",
    );
    expect(result.body.delta?.operations[0]).toMatchObject({
      op: "node.add",
      node: { summary: result.body.receipt.proposed.summary },
    });

    const clarification = await placeSource(
      {
        ...request,
        source: { ...request.source, text: sourceText },
        projection: {
          ...request.projection,
          projectId: null,
          nodes: [],
          relations: [],
        },
      },
      { environment: { ODEU_MANAGER_MODE: "fixture" } },
    );

    expect(clarification.status).toBe(200);
    expect(clarification.body.ok).toBe(true);
    if (!clarification.body.ok) {
      throw new Error("Expected fixture clarification success.");
    }
    expect(clarification.body.receipt.proposed.summary).toEqual(
      result.body.receipt.proposed.summary,
    );
    expect(clarification.body.delta).toBeNull();
  });

  it("does not split a Unicode character at the fixture summary boundary", async () => {
    const sourceText = `${"x".repeat(1_998)}😀${"y".repeat(2_000)}`;
    expect(sourceText).toHaveLength(4_000);

    const result = await placeSource(
      { ...request, source: { ...request.source, text: sourceText } },
      { environment: { ODEU_MANAGER_MODE: "fixture" } },
    );

    expect(result.body.ok).toBe(true);
    if (!result.body.ok) throw new Error("Expected fixture placement success.");
    expect(result.body.receipt.proposed.summary).toBe(
      `${"x".repeat(1_998)}…`,
    );
  });

  it("reports live mode unavailable instead of silently using fixtures", async () => {
    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "live" },
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      ok: false,
      manager: {
        requestedMode: "live",
        effectiveMode: null,
        status: "unavailable",
        provider: "openai",
        model: "gpt-5.6",
      },
      sourcePreserved: true,
      error: {
        code: "live_credentials_missing",
        retryable: false,
      },
    });
  });

  it("rejects private context before invoking a live provider", async () => {
    const liveParser = vi.fn(async () => ({
      responseId: "must-not-run",
      model: "gpt-5.6",
      output: liveInterpretation,
    }));
    const result = await placeSource(
      {
        ...request,
        projection: {
          ...request.projection,
          nodes: request.projection.nodes.map((node) =>
            node.id === "area-budget"
              ? { ...node, visibility: "private" as const }
              : node,
          ),
        },
      },
      {
        environment: { ODEU_MANAGER_MODE: "live" },
        liveParser,
      },
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      sourcePreserved: true,
      error: { code: "invalid_request" },
    });
    expect(liveParser).not.toHaveBeenCalled();

    if (result.body.ok) {
      throw new Error("Expected private context to fail closed");
    }

    expect(result.body.error.issues).toContain(
      "projection.nodes.1.visibility: private nodes must be omitted before calling the placement gateway",
    );
  });

  it("returns a clarification receipt without a delta when no project is bounded", async () => {
    const result = await placeSource(
      {
        ...request,
        projection: {
          ...request.projection,
          projectId: null,
          nodes: [],
          relations: [],
        },
      },
      { environment: { ODEU_MANAGER_MODE: "fixture" } },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      receipt: {
        decisionState: "needs_clarification",
        clarificationQuestion: "Which project should this idea belong to?",
      },
      delta: null,
    });
  });

  it("uses gpt-5.6 and records live response provenance", async () => {
    const liveParser = vi.fn(async () => ({
      responseId: "resp-placement-1",
      model: "gpt-5.6-sol",
      output: liveInterpretation,
    }));

    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "live" },
      liveParser,
    });

    expect(liveParser).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        model: "gpt-5.6",
        signal: expect.any(AbortSignal),
        timeoutMs: 120_000,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      manager: {
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        provider: "openai",
        model: "gpt-5.6-sol",
        responseId: "resp-placement-1",
      },
    });
  });

  it("preserves a visible failure when structured output is absent", async () => {
    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "live" },
      liveParser: async () => ({
        responseId: "resp-empty",
        model: "gpt-5.6",
        output: null,
      }),
    });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      ok: false,
      manager: {
        requestedMode: "live",
        effectiveMode: "live",
        status: "failed",
        provider: "openai",
        model: "gpt-5.6",
        responseId: "resp-empty",
      },
      sourcePreserved: true,
      error: {
        code: "structured_output_missing",
        retryable: true,
      },
    });
  });

  it("aborts an over-deadline provider call and preserves a typed retryable failure", async () => {
    const liveParser = vi.fn(
      ({ signal }: Parameters<PlacementParser>[0]) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "live" },
      liveParser,
      liveTimeoutMs: 5,
    });

    expect(liveParser).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: 5,
      }),
    );
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({
      ok: false,
      manager: {
        effectiveMode: "live",
        status: "failed",
        provider: "openai",
      },
      sourcePreserved: true,
      error: {
        code: "provider_timed_out",
        retryable: true,
      },
    });
  });

  it("returns at the host deadline even when a parser ignores cancellation", async () => {
    const liveParser = vi.fn(() => new Promise<never>(() => undefined));

    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "live" },
      liveParser,
      liveTimeoutMs: 5,
    });

    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({
      ok: false,
      sourcePreserved: true,
      error: { code: "provider_timed_out", retryable: true },
    });
  });

  it.each([0, 2_147_483_648])(
    "rejects invalid provider deadline %s before dispatch",
    async (liveTimeoutMs) => {
      const liveParser = vi.fn();

      const result = await placeSource(request, {
        environment: { ODEU_MANAGER_MODE: "live" },
        liveParser,
        liveTimeoutMs,
      });

      expect(liveParser).not.toHaveBeenCalled();
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({
        ok: false,
        manager: { effectiveMode: null, status: "unavailable" },
        sourcePreserved: true,
        error: {
          code: "live_configuration_invalid",
          retryable: false,
        },
      });
    },
  );

  it("fails closed when the model references a node outside the projection", async () => {
    const result = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "live" },
      liveParser: async () => ({
        responseId: "resp-out-of-scope",
        model: "gpt-5.6",
        output: {
          ...liveInterpretation,
          affectedNodeIds: ["private-node-not-projected"],
        },
      }),
    });

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: "interpretation_out_of_scope" },
      sourcePreserved: true,
    });
  });

  it("returns field-level issues for invalid requests", async () => {
    const result = await placeSource(
      { ...request, source: { ...request.source, text: "" } },
      { environment: { ODEU_MANAGER_MODE: "fixture" } },
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: "invalid_request", retryable: false },
      sourcePreserved: true,
    });

    if (result.body.ok) {
      throw new Error("Expected an invalid request response");
    }

    expect(result.body.error.issues[0]).toContain("source.text");
  });
});
