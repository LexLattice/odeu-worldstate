import { z } from "zod";

import {
  PlacementRequestSchema,
  PlacementResponseSchema,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  fingerprint,
  sourceCapturedEvent,
  stableStringify,
  type Actor,
  type LedgerEventOf,
  type SourceRecord,
} from "@/domain";

export const PlacementExchangeSchema = z
  .object({
    kind: z.literal("odeu.manager-placement-exchange"),
    version: z.literal(1),
    request: PlacementRequestSchema,
    response: PlacementResponseSchema,
  })
  .strict();

export type PlacementExchange = z.infer<typeof PlacementExchangeSchema>;

export const PlacementAttemptSchema = z
  .object({
    kind: z.literal("odeu.manager-placement-attempt"),
    version: z.literal(1),
    request: PlacementRequestSchema,
  })
  .strict();

export type PlacementAttempt = z.infer<typeof PlacementAttemptSchema>;

export class PlacementResponseCoherenceError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Placement response does not match its request: ${issues.join("; ")}`);
    this.name = "PlacementResponseCoherenceError";
  }
}

export function placementExchangeSourceId(requestId: string): string {
  return `source-placement-exchange:${requestId}`;
}

export function placementAttemptSourceId(requestId: string): string {
  return `source-placement-attempt:${requestId}`;
}

function systemEvidenceSourceEvent(input: {
  artifact: PlacementExchange | PlacementAttempt;
  sourceId: string;
  eventId: string;
  commandId: string;
  occurredAt: string;
  actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const digest = fingerprint(input.artifact);
  return sourceCapturedEvent({
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
    payload: {
      source: {
        id: input.sourceId,
        kind: "system",
        content: stableStringify(input.artifact),
        visibility: "shared",
        integrity: { algorithm: "fnv1a64", digest },
      },
    },
  });
}

/** Persist the exact bounded request before any manager call is made. */
export function placementAttemptSourceEvent(input: {
  request: PlacementRequest;
  eventId: string;
  commandId: string;
  occurredAt: string;
  actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const artifact = PlacementAttemptSchema.parse({
    kind: "odeu.manager-placement-attempt",
    version: 1,
    request: input.request,
  });
  return systemEvidenceSourceEvent({
    artifact,
    sourceId: placementAttemptSourceId(input.request.requestId),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

/**
 * Retains the exact, schema-validated manager exchange as an evidence source.
 * The exchange remains operational provenance; it does not become canonical
 * project truth merely because it was persisted.
 */
export function placementExchangeSourceEvent(input: {
  request: PlacementRequest;
  response: PlacementResponse;
  eventId: string;
  commandId: string;
  occurredAt: string;
  actor: Actor;
}): LedgerEventOf<"source.captured"> {
  const exchange = PlacementExchangeSchema.parse({
    kind: "odeu.manager-placement-exchange",
    version: 1,
    request: input.request,
    response: input.response,
  });
  return systemEvidenceSourceEvent({
    artifact: exchange,
    sourceId: placementExchangeSourceId(input.request.requestId),
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.actor,
  });
}

export function parsePlacementExchange(content: string): PlacementExchange | null {
  try {
    return PlacementExchangeSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

export function parsePlacementAttempt(content: string): PlacementAttempt | null {
  try {
    return PlacementAttemptSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

function hasValidSystemEvidencePosture(
  source: SourceRecord,
  artifact: PlacementExchange | PlacementAttempt,
  expectedId: string,
): boolean {
  return (
    source.kind === "system" &&
    source.visibility === "shared" &&
    source.id === expectedId &&
    source.integrity?.algorithm === "fnv1a64" &&
    source.integrity.digest === fingerprint(artifact)
  );
}

/**
 * Recognize durable placement evidence only when its source posture and digest
 * match the artifact written at the manager boundary. Human text that happens
 * to resemble the exchange schema must never acquire system-evidence authority.
 */
export function parsePlacementExchangeSource(
  source: SourceRecord,
): PlacementExchange | null {
  const exchange = parsePlacementExchange(source.content);
  if (
    !exchange ||
    !hasValidSystemEvidencePosture(
      source,
      exchange,
      placementExchangeSourceId(exchange.request.requestId),
    )
  ) {
    return null;
  }

  return exchange;
}

export function parsePlacementAttemptSource(
  source: SourceRecord,
): PlacementAttempt | null {
  const attempt = parsePlacementAttempt(source.content);
  if (
    !attempt ||
    !hasValidSystemEvidencePosture(
      source,
      attempt,
      placementAttemptSourceId(attempt.request.requestId),
    )
  ) {
    return null;
  }
  return attempt;
}

/**
 * Bind a structurally valid success response to the exact request and bounded
 * projection that produced it before any candidate delta reaches the kernel.
 */
export function assertPlacementResponseMatchesRequest(
  requestInput: PlacementRequest,
  responseInput: PlacementResponse,
): void {
  const request = PlacementRequestSchema.parse(requestInput);
  const response = PlacementResponseSchema.parse(responseInput);
  if (!response.ok) return;

  const issues: string[] = [];
  const receipt = response.receipt;
  const nodeIds = new Set(request.projection.nodes.map((node) => node.id));
  const expectEqual = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) issues.push(`${label} must equal ${String(expected)}`);
  };
  const expectBounded = (label: string, id: string | null) => {
    if (id !== null && !nodeIds.has(id)) issues.push(`${label} ${id} is outside the request projection`);
  };

  expectEqual("receipt.sourceId", receipt.sourceId, request.source.sourceId);
  expectEqual("receipt.requestId", receipt.requestId, request.requestId);
  expectEqual("receipt.baseRevisionId", receipt.baseRevisionId, request.baseRevisionId);
  expectEqual("receipt.scopeId", receipt.scopeId, request.projection.scopeId);
  expectEqual("receipt.projectId", receipt.projectId, request.projection.projectId);
  expectBounded("receipt.location.targetNodeId", receipt.location.targetNodeId);
  receipt.affectedNodeIds.forEach((id) => expectBounded("receipt.affectedNodeId", id));
  receipt.alternatives.forEach((item) =>
    expectBounded("receipt.alternative.targetNodeId", item.targetNodeId),
  );
  receipt.conflicts.forEach((item) =>
    expectBounded("receipt.conflict.nodeId", item.nodeId),
  );
  receipt.proposedRelations.forEach((item) =>
    expectBounded("receipt.proposedRelation.targetNodeId", item.targetNodeId),
  );

  if (nodeIds.has(receipt.proposed.nodeId)) {
    issues.push(`receipt.proposed.nodeId ${receipt.proposed.nodeId} already exists in the request projection`);
  }

  if (receipt.decisionState === "reviewable" && response.delta === null) {
    issues.push("a reviewable receipt must carry a candidate delta");
  }
  if (
    receipt.decisionState === "needs_clarification" &&
    response.delta !== null
  ) {
    issues.push("a clarification receipt cannot carry a candidate delta");
  }

  if (response.delta) {
    const allowedOperationNodeIds = new Set([
      ...nodeIds,
      receipt.proposed.nodeId,
    ]);
    expectEqual("delta.sourceId", response.delta.sourceId, request.source.sourceId);
    expectEqual("delta.baseRevisionId", response.delta.baseRevisionId, request.baseRevisionId);
    response.delta.operations.forEach((operation) => {
      if (operation.op === "node.add") {
        expectEqual("delta.node.scopeId", operation.node.scopeId, request.projection.scopeId);
        expectEqual("delta.node.originSourceId", operation.node.originSourceId, request.source.sourceId);
      } else {
        expectEqual("delta.relation.scopeId", operation.relation.scopeId, request.projection.scopeId);
        expectEqual("delta.relation.originSourceId", operation.relation.originSourceId, request.source.sourceId);
        if (!allowedOperationNodeIds.has(operation.relation.fromNodeId)) {
          issues.push(
            `delta.relation.fromNodeId ${operation.relation.fromNodeId} is outside the request and proposed node`,
          );
        }
        if (!allowedOperationNodeIds.has(operation.relation.toNodeId)) {
          issues.push(
            `delta.relation.toNodeId ${operation.relation.toNodeId} is outside the request and proposed node`,
          );
        }
      }
    });
  }

  if (issues.length) throw new PlacementResponseCoherenceError(issues);
}
