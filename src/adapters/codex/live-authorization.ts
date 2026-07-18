import { z } from "zod";

import {
  LedgerDocumentSchema,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";

import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  type AgentRunRequest,
} from "./schema";

const StableId = z.string().trim().min(1).max(160);

export const LIVE_AUTHORIZATION_MAX_EVENTS = 5_000;
export const LIVE_AUTHORIZATION_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * A transport bound applied before the domain ledger parser performs its exact
 * event and deterministic-reduction validation.
 */
export const LiveWorldstateLedgerTransportSchema = LedgerDocumentSchema.extend({
  events: z.array(z.unknown()).max(LIVE_AUTHORIZATION_MAX_EVENTS),
}).strict();

export const LiveAuthorizationRequestSchema = z
  .object({
    document: LiveWorldstateLedgerTransportSchema,
    runId: StableId,
    requestId: StableId,
  })
  .strict();

export interface BrowserLiveAuthorizationInput {
  readonly document: WorldstateLedgerDocument;
  readonly runId: string;
  readonly requestId: string;
}

export const LiveAuthorizedAgentRunRequestSchema = AgentRunRequestSchema.superRefine(
  (request, context) => {
    if (request.mode !== "live" || request.authorization === null) {
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "the authority service must return an authorized live request",
      });
    }
  },
);

export const AgentRuntimeCapabilitySchema = z
  .object({
    requestedMode: z.string().trim().min(1).max(64),
    effectiveMode: z.enum(["replay", "live"]).nullable(),
    status: z.enum(["available", "unavailable"]),
    artifactBaseRef: z
      .string()
      .regex(/^git:(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .nullable(),
    reason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((capability, context) => {
    if (
      capability.status === "available" &&
      capability.effectiveMode === "live" &&
      capability.artifactBaseRef === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifactBaseRef"],
        message: "an available live runtime must report its observed artifact base",
      });
    }
    if (
      capability.status === "unavailable" &&
      capability.reason === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "an unavailable runtime must provide a bounded reason",
      });
    }
  });

export const LiveRunStatusRequestSchema = z
  .object({
    runId: StableId,
    requestId: StableId,
  })
  .strict();

export const LiveRunStatusResponseSchema = z
  .object({
    status: z.enum([
      "not_started",
      "in_progress",
      "completed",
      "outcome_unknown",
    ]),
    response: AgentRunResponseSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.status === "completed") !== (result.response !== null)) {
      context.addIssue({
        code: "custom",
        path: ["response"],
        message: "only a completed run status may carry the exact agent response",
      });
    }
  });

export type LiveAuthorizationRequest = z.infer<
  typeof LiveAuthorizationRequestSchema
>;
export type AgentRuntimeCapability = z.infer<
  typeof AgentRuntimeCapabilitySchema
>;
export type LiveRunStatusRequest = z.infer<typeof LiveRunStatusRequestSchema>;
export type LiveRunStatusResponse = z.infer<typeof LiveRunStatusResponseSchema>;

export type BrowserLiveAuthorizationGateway = (
  input: BrowserLiveAuthorizationInput,
) => Promise<AgentRunRequest>;
