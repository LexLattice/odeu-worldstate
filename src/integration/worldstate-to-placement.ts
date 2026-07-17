import {
  PlacementRequestSchema,
  type PlacementRequest,
} from "@/adapters/manager/schema";
import type { WorldstateState } from "@/domain";

export type PlacementRequestCompilationErrorCode =
  | "source_missing"
  | "source_private";

export class PlacementRequestCompilationError extends Error {
  constructor(
    readonly code: PlacementRequestCompilationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlacementRequestCompilationError";
  }
}

export interface CompilePlacementRequestInput {
  readonly state: WorldstateState;
  readonly sourceId: string;
  readonly requestId: string;
  readonly scopeId: string;
  /** The manager schema uses projectId for the Project node, not the ledger aggregate. */
  readonly projectId?: string | null;
  readonly selectedNodeId?: string | null;
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * Compile the sole context shape that may cross from canonical worldstate into
 * the placement manager. The result is a fresh, schema-validated value: private,
 * retired, and out-of-scope records are denied by omission.
 */
export function compilePlacementRequest({
  state,
  sourceId,
  requestId,
  scopeId,
  projectId = null,
  selectedNodeId = null,
}: CompilePlacementRequestInput): PlacementRequest {
  const source = state.operational.sources[sourceId];

  if (!source) {
    throw new PlacementRequestCompilationError(
      "source_missing",
      `Placement source ${sourceId} is not present in worldstate.`,
    );
  }

  if (source.visibility !== "shared") {
    throw new PlacementRequestCompilationError(
      "source_private",
      `Private source ${sourceId} cannot enter a placement projection.`,
    );
  }

  const nodes = Object.values(state.canonical.nodes)
    .filter(
      (node) =>
        !node.retiredRevisionId &&
        node.visibility === "shared" &&
        node.scopeId === scopeId,
    )
    .sort(compareIds)
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      title: node.title,
      summary: node.description ?? null,
      scopeId: node.scopeId,
      visibility: node.visibility,
    }));

  const includedNodeIds = new Set(nodes.map((node) => node.id));
  const relations = Object.values(state.canonical.relations)
    .filter(
      (relation) =>
        !relation.retiredRevisionId &&
        relation.scopeId === scopeId &&
        includedNodeIds.has(relation.fromNodeId) &&
        includedNodeIds.has(relation.toNodeId),
    )
    .sort(compareIds)
    .map((relation) => ({
      id: relation.id,
      kind: relation.kind,
      fromNodeId: relation.fromNodeId,
      toNodeId: relation.toNodeId,
    }));

  return PlacementRequestSchema.parse({
    requestId,
    source: {
      sourceId: source.id,
      text: source.content,
    },
    baseRevisionId: state.canonical.head.id,
    projection: {
      scopeId,
      projectId,
      selectedNodeId,
      nodes,
      relations,
    },
  });
}
