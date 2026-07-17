import { describe, expect, it } from "vitest";

import { placeSource } from "@/adapters/manager/gateway";
import type { PlacementSuccessResponse } from "@/adapters/manager/schema";
import { WorldstateDeltaSchema } from "@/domain/schema";

import { placementResponseToKernelDelta } from "./placement-to-kernel";

const request = {
  requestId: "request-home-move-001",
  source: {
    sourceId: "source-home-move-001",
    text: "Ask Codex to add a simple moving-cost comparison tool to my relocation project.",
  },
  baseRevisionId: "rev-home-018",
  projection: {
    scopeId: "project-home-move",
    projectId: "project-home-move",
    selectedNodeId: null,
    nodes: [
      {
        id: "project-home-move",
        kind: "Project",
        title: "Plan our home move",
        summary: "A coordinated move",
        scopeId: "project-home-move",
        visibility: "shared",
      },
      {
        id: "area-budget",
        kind: "Idea",
        title: "Budget",
        summary: "Moving cost decisions",
        scopeId: "project-home-move",
        visibility: "shared",
      },
    ],
    relations: [],
  },
};

describe("placementResponseToKernelDelta", () => {
  it("turns a fixture receipt into a still-pending kernel delta", async () => {
    const placement = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    expect(placement.body.ok).toBe(true);

    const delta = placementResponseToKernelDelta(
      placement.body as PlacementSuccessResponse,
    );

    expect(delta).not.toBeNull();
    expect(WorldstateDeltaSchema.parse(delta)).toEqual(delta);
    expect(delta).toMatchObject({
      baseRevisionId: request.baseRevisionId,
      scopeId: request.projection.scopeId,
      purpose: "placement",
    });
    expect(delta?.operations[0]).toMatchObject({
      op: "node.add",
      node: {
        governance: { standing: "suggested", approval: "required" },
        sourceRefs: [request.source.sourceId],
      },
    });
  });

  it("does not invent a delta when the manager asks for clarification", async () => {
    const placement = await placeSource(
      {
        ...request,
        projection: {
          ...request.projection,
          projectId: null,
          nodes: [],
        },
      },
      { environment: { ODEU_MANAGER_MODE: "fixture" } },
    );

    expect(placement.body.ok).toBe(true);
    expect(
      placementResponseToKernelDelta(placement.body as PlacementSuccessResponse),
    ).toBeNull();
  });

  it("rejects a receipt whose visible node differs from the candidate delta", async () => {
    const placement = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    expect(placement.body.ok).toBe(true);
    const tampered = structuredClone(placement.body as PlacementSuccessResponse);
    const nodeOperation = tampered.delta?.operations.find(
      (operation) => operation.op === "node.add",
    );
    if (!nodeOperation) {
      throw new Error("Fixture did not return its proposed node operation.");
    }
    nodeOperation.node.title = "A different hidden operation";

    expect(() => placementResponseToKernelDelta(tampered)).toThrow(
      "visible proposed node",
    );
  });

  it("rejects relation provenance tampering", async () => {
    const placement = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    expect(placement.body.ok).toBe(true);
    const tampered = structuredClone(placement.body as PlacementSuccessResponse);
    const relationOperation = tampered.delta?.operations.find(
      (operation) => operation.op === "relation.add",
    );
    if (!relationOperation) {
      throw new Error("Fixture did not return its proposed relation operation.");
    }
    relationOperation.relation.originSourceId = "source-not-shown-in-receipt";

    expect(() => placementResponseToKernelDelta(tampered)).toThrow(
      "visible proposed relations",
    );
  });

  it("does not let one visible relation satisfy duplicate actual operations", async () => {
    const placement = await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    });
    expect(placement.body.ok).toBe(true);
    const duplicated = structuredClone(placement.body as PlacementSuccessResponse);
    const relationOperation = duplicated.delta?.operations.find(
      (operation) => operation.op === "relation.add",
    );
    const visibleRelation = duplicated.receipt.proposedRelations[0];
    if (!duplicated.delta || !relationOperation || !visibleRelation) {
      throw new Error("Fixture did not return a reviewable relation proposal.");
    }

    duplicated.receipt.proposedRelations.push({
      ...visibleRelation,
      targetNodeId: "project-home-move",
      rationale: "A second visible relation with a different endpoint.",
    });
    duplicated.delta.operations.push({
      ...relationOperation,
      operationId: `${relationOperation.operationId}-duplicate`,
      relation: {
        ...relationOperation.relation,
        id: `${relationOperation.relation.id}-duplicate`,
      },
    });

    expect(() => placementResponseToKernelDelta(duplicated)).toThrow(
      "visible proposed relations",
    );
  });
});
