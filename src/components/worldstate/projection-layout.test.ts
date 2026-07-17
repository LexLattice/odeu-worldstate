import { describe, expect, it } from "vitest";

import {
  layoutProjectionGraph,
  type ProjectionLayoutNode,
  type ProjectionLayoutPosition,
  type ProjectionLayoutRelation,
} from "./projection-layout";

const nodes: readonly ProjectionLayoutNode[] = [
  { id: "project", kind: "Project" },
  { id: "goal", kind: "Goal", parentId: "project" },
  { id: "area-b", kind: "Area", parentId: "project" },
  { id: "area-a", kind: "Area", parentId: "project" },
  { id: "task", kind: "Task", parentId: "area-a" },
];

const relations: readonly ProjectionLayoutRelation[] = [
  { id: "relation-2", source: "task", target: "goal", kind: "supports" },
  { id: "relation-1", source: "project", target: "goal", kind: "pursues" },
];

function overlaps(
  left: ProjectionLayoutPosition,
  right: ProjectionLayoutPosition,
  width: number,
  height: number,
): boolean {
  return !(
    left.x + width <= right.x ||
    right.x + width <= left.x ||
    left.y + height <= right.y ||
    right.y + height <= left.y
  );
}

describe("layoutProjectionGraph", () => {
  it("is deterministic across node and relation input order", () => {
    const forward = layoutProjectionGraph(nodes, relations);
    const reversed = layoutProjectionGraph(
      [...nodes].reverse(),
      [...relations].reverse(),
    );

    expect(reversed).toEqual(forward);
    expect(forward.positions["area-a"].order).toBeLessThan(
      forward.positions["area-b"].order,
    );
  });

  it("positions dynamic candidate identities without a demo-id allowlist", () => {
    const candidateId = "candidate-generated-at-runtime-7f92";
    const result = layoutProjectionGraph([
      ...nodes,
      {
        id: candidateId,
        kind: "Idea",
        parentId: "area-a",
      },
    ]);

    expect(result.positions[candidateId]).toEqual(
      expect.objectContaining({ layer: 2, x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it("emits non-overlapping rectangles for every positioned node", () => {
    const result = layoutProjectionGraph(nodes, relations, {
      nodeWidth: 180,
      nodeHeight: 72,
      columnGap: 44,
      rowGap: 20,
    });
    const positions = Object.values(result.positions);

    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        expect(
          overlaps(
            positions[left],
            positions[right],
            result.metrics.nodeWidth,
            result.metrics.nodeHeight,
          ),
        ).toBe(false);
      }
    }
  });

  it("bounds cyclic, orphaned, and over-deep hierarchy in a fallback layer", () => {
    const maxDepth = 3;
    const result = layoutProjectionGraph(
      [
        { id: "cycle-a", kind: "Task", parentId: "cycle-b" },
        { id: "cycle-b", kind: "Task", parentId: "cycle-a" },
        { id: "orphan", kind: "Idea", parentId: "missing-parent" },
        { id: "root", kind: "Project" },
        { id: "one", kind: "Area", parentId: "root" },
        { id: "two", kind: "Task", parentId: "one" },
        { id: "three", kind: "Artifact", parentId: "two" },
        { id: "four", kind: "Evidence", parentId: "three" },
      ],
      [],
      { maxDepth },
    );
    const lastLayerX =
      result.bounds.x +
      maxDepth * (result.metrics.nodeWidth + result.metrics.columnGap);

    expect(result.positions["cycle-a"].layer).toBe(maxDepth);
    expect(result.positions["cycle-b"].layer).toBe(maxDepth);
    expect(result.positions.orphan.layer).toBe(maxDepth);
    expect(result.positions.four.layer).toBe(maxDepth);
    expect(
      Math.max(...Object.values(result.positions).map((position) => position.x)),
    ).toBe(lastLayerX);
  });

  it("uses bounded relation layering when no hierarchy is supplied", () => {
    const result = layoutProjectionGraph(
      [
        { id: "source", kind: "Project" },
        { id: "middle", kind: "Idea" },
        { id: "target", kind: "Artifact" },
      ],
      [
        { source: "source", target: "middle" },
        { source: "middle", target: "target" },
      ],
    );

    expect(result.positions.source.layer).toBe(0);
    expect(result.positions.middle.layer).toBe(1);
    expect(result.positions.target.layer).toBe(2);
  });
});
