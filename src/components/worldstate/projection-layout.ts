/**
 * Deterministic graph geometry for worldstate projections.
 *
 * Positions are projection-only presentation metadata. They must never be
 * persisted as canonical hierarchy, evidence, or authority-bearing state.
 */

export interface ProjectionLayoutNode {
  readonly id: string;
  readonly kind: string;
  readonly parentId?: string | null;
}

export interface ProjectionLayoutRelation {
  readonly id?: string;
  readonly kind?: string;
  readonly source: string;
  readonly target: string;
}

export interface ProjectionLayoutOptions {
  readonly originX?: number;
  readonly originY?: number;
  readonly nodeWidth?: number;
  readonly nodeHeight?: number;
  readonly columnGap?: number;
  readonly rowGap?: number;
  /** Final horizontal layer. Deeper, orphaned, or cyclic nodes land here. */
  readonly maxDepth?: number;
}

export interface ProjectionLayoutPosition {
  readonly x: number;
  readonly y: number;
  readonly layer: number;
  readonly order: number;
}

export interface ProjectionLayoutBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ProjectionLayoutMetrics {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
  readonly maxDepth: number;
}

export interface ProjectionLayoutResult {
  readonly positions: Readonly<Record<string, ProjectionLayoutPosition>>;
  readonly bounds: ProjectionLayoutBounds;
  readonly metrics: ProjectionLayoutMetrics;
}

export const DEFAULT_PROJECTION_LAYOUT = Object.freeze({
  originX: 40,
  originY: 24,
  nodeWidth: 220,
  nodeHeight: 88,
  columnGap: 60,
  rowGap: 28,
  maxDepth: 8,
});

const SEMANTIC_KIND_ORDER = [
  "world",
  "project",
  "goal",
  "area",
  "constraint",
  "decision",
  "task",
  "idea",
  "openquestion",
  "question",
  "artifact",
  "agentrun",
  "evidence",
] as const;

const semanticKindRanks = new Map<string, number>(
  SEMANTIC_KIND_ORDER.map((kind, index) => [kind, index]),
);

function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function normalizeKind(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function compareNodes(
  left: ProjectionLayoutNode,
  right: ProjectionLayoutNode,
): number {
  const leftKind = normalizeKind(left.kind);
  const rightKind = normalizeKind(right.kind);
  const unknownRank = SEMANTIC_KIND_ORDER.length;
  const rankDifference =
    (semanticKindRanks.get(leftKind) ?? unknownRank) -
    (semanticKindRanks.get(rightKind) ?? unknownRank);

  if (rankDifference !== 0) {
    return rankDifference;
  }

  const kindDifference = compareCodeUnits(leftKind, rightKind);
  return kindDifference || compareCodeUnits(left.id, right.id);
}

function finiteMetric(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;

  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number.`);
  }

  return resolved;
}

function resolveOptions(options: ProjectionLayoutOptions) {
  const maxDepth = finiteMetric(
    options.maxDepth,
    DEFAULT_PROJECTION_LAYOUT.maxDepth,
    "maxDepth",
  );

  if (!Number.isInteger(maxDepth)) {
    throw new RangeError("maxDepth must be an integer.");
  }

  return {
    originX: finiteMetric(
      options.originX,
      DEFAULT_PROJECTION_LAYOUT.originX,
      "originX",
    ),
    originY: finiteMetric(
      options.originY,
      DEFAULT_PROJECTION_LAYOUT.originY,
      "originY",
    ),
    nodeWidth: finiteMetric(
      options.nodeWidth,
      DEFAULT_PROJECTION_LAYOUT.nodeWidth,
      "nodeWidth",
    ),
    nodeHeight: finiteMetric(
      options.nodeHeight,
      DEFAULT_PROJECTION_LAYOUT.nodeHeight,
      "nodeHeight",
    ),
    columnGap: finiteMetric(
      options.columnGap,
      DEFAULT_PROJECTION_LAYOUT.columnGap,
      "columnGap",
    ),
    rowGap: finiteMetric(
      options.rowGap,
      DEFAULT_PROJECTION_LAYOUT.rowGap,
      "rowGap",
    ),
    maxDepth,
  } as const;
}

function assertUniqueNodeIds(nodes: readonly ProjectionLayoutNode[]): void {
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!node.id.trim()) {
      throw new TypeError("Projection layout nodes require a non-empty id.");
    }

    if (seen.has(node.id)) {
      throw new TypeError(`Projection layout node id ${node.id} is duplicated.`);
    }

    seen.add(node.id);
  }
}

function hierarchyLayers(
  nodesById: ReadonlyMap<string, ProjectionLayoutNode>,
  maxDepth: number,
): Map<string, number> {
  const layers = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (nodeId: string): number => {
    const known = layers.get(nodeId);
    if (known !== undefined) {
      return known;
    }

    if (visiting.has(nodeId)) {
      layers.set(nodeId, maxDepth);
      return maxDepth;
    }

    const node = nodesById.get(nodeId);
    if (!node) {
      return maxDepth;
    }

    visiting.add(nodeId);

    const parentId = node.parentId;
    const layer =
      parentId === undefined || parentId === null
        ? 0
        : !nodesById.has(parentId) || parentId === nodeId
          ? maxDepth
          : Math.min(maxDepth, visit(parentId) + 1);

    visiting.delete(nodeId);
    layers.set(nodeId, layer);
    return layer;
  };

  for (const nodeId of nodesById.keys()) {
    visit(nodeId);
  }

  return layers;
}

function applyRelationLayers(
  nodesById: ReadonlyMap<string, ProjectionLayoutNode>,
  relations: readonly ProjectionLayoutRelation[],
  hierarchy: ReadonlyMap<string, number>,
  maxDepth: number,
): Map<string, number> {
  let layers = new Map(hierarchy);
  const eligibleTargets = new Set(
    [...nodesById.values()]
      .filter((node) => node.parentId === undefined || node.parentId === null)
      .map((node) => node.id),
  );
  const boundedRelations = relations
    .filter(
      (relation) =>
        relation.source !== relation.target &&
        nodesById.has(relation.source) &&
        nodesById.has(relation.target) &&
        eligibleTargets.has(relation.target),
    )
    .toSorted((left, right) =>
      compareCodeUnits(left.source, right.source) ||
      compareCodeUnits(left.target, right.target) ||
      compareCodeUnits(left.kind ?? "", right.kind ?? "") ||
      compareCodeUnits(left.id ?? "", right.id ?? ""),
    );

  // Snapshot-based relaxation is independent of caller order. The depth cap
  // also gives relation cycles a deterministic, finite fallback.
  for (let pass = 0; pass < maxDepth; pass += 1) {
    const next = new Map(layers);
    let changed = false;

    for (const relation of boundedRelations) {
      const sourceLayer = layers.get(relation.source) ?? 0;
      const targetLayer = next.get(relation.target) ?? 0;
      const proposedLayer = Math.min(maxDepth, sourceLayer + 1);

      if (proposedLayer > targetLayer) {
        next.set(relation.target, proposedLayer);
        changed = true;
      }
    }

    layers = next;
    if (!changed) {
      break;
    }
  }

  return layers;
}

/**
 * Arranges a graph into non-overlapping columns using hierarchy first and
 * directed relations only for nodes that do not declare a parent.
 */
export function layoutProjectionGraph(
  nodes: readonly ProjectionLayoutNode[],
  relations: readonly ProjectionLayoutRelation[] = [],
  options: ProjectionLayoutOptions = {},
): ProjectionLayoutResult {
  assertUniqueNodeIds(nodes);

  const resolved = resolveOptions(options);
  const sortedNodes = nodes.toSorted(compareNodes);
  const nodesById = new Map(sortedNodes.map((node) => [node.id, node]));
  const hierarchy = hierarchyLayers(nodesById, resolved.maxDepth);
  const layers = applyRelationLayers(
    nodesById,
    relations,
    hierarchy,
    resolved.maxDepth,
  );
  const nodesByLayer = new Map<number, ProjectionLayoutNode[]>();

  for (const node of sortedNodes) {
    const layer = layers.get(node.id) ?? resolved.maxDepth;
    const peers = nodesByLayer.get(layer) ?? [];
    peers.push(node);
    nodesByLayer.set(layer, peers);
  }

  const entries: Array<readonly [string, ProjectionLayoutPosition]> = [];
  let occupiedLayers = 0;
  let longestLayer = 0;

  for (const [layer, layerNodes] of [...nodesByLayer.entries()].toSorted(
    ([left], [right]) => left - right,
  )) {
    occupiedLayers = Math.max(occupiedLayers, layer + 1);
    longestLayer = Math.max(longestLayer, layerNodes.length);

    layerNodes.forEach((node, order) => {
      entries.push([
        node.id,
        {
          x:
            resolved.originX +
            layer * (resolved.nodeWidth + resolved.columnGap),
          y:
            resolved.originY +
            order * (resolved.nodeHeight + resolved.rowGap),
          layer,
          order,
        },
      ]);
    });
  }

  const positions = Object.fromEntries(entries) as Readonly<
    Record<string, ProjectionLayoutPosition>
  >;

  return {
    positions,
    bounds: {
      x: resolved.originX,
      y: resolved.originY,
      width:
        occupiedLayers === 0
          ? 0
          : (occupiedLayers - 1) *
              (resolved.nodeWidth + resolved.columnGap) +
            resolved.nodeWidth,
      height:
        longestLayer === 0
          ? 0
          : (longestLayer - 1) *
              (resolved.nodeHeight + resolved.rowGap) +
            resolved.nodeHeight,
    },
    metrics: {
      nodeWidth: resolved.nodeWidth,
      nodeHeight: resolved.nodeHeight,
      columnGap: resolved.columnGap,
      rowGap: resolved.rowGap,
      maxDepth: resolved.maxDepth,
    },
  };
}
