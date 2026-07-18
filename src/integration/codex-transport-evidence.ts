import { z } from "zod";

import {
  fingerprint,
  sourceCapturedEvent,
  stableStringify,
  type Actor,
  type LedgerEventOf,
  type SourceRecord,
} from "@/domain";

export const CODEX_TRANSPORT_BODY_EXCERPT_MAX_LENGTH = 2_000;

const IntegrityDigestSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/);

export const CodexTransportObservationSchema = z
  .object({
    kind: z.literal("odeu.codex-transport-observation"),
    version: z.literal(1),
    requestId: z.string().trim().min(1).max(160),
    runId: z.string().trim().min(1).max(160),
    outcome: z.enum(["transport_failed", "response_invalid"]),
    httpStatus: z.number().int().min(0).max(999).nullable(),
    contentType: z.string().trim().min(1).max(1_000).nullable(),
    bodyExcerpt: z
      .string()
      .max(CODEX_TRANSPORT_BODY_EXCERPT_MAX_LENGTH)
      .nullable(),
    bodyTruncated: z.boolean(),
    bodyDigest: IntegrityDigestSchema.nullable(),
  })
  .strict()
  .superRefine((observation, context) => {
    const hasExcerpt = observation.bodyExcerpt !== null;
    const hasDigest = observation.bodyDigest !== null;

    if (hasExcerpt !== hasDigest) {
      context.addIssue({
        code: "custom",
        path: [hasExcerpt ? "bodyDigest" : "bodyExcerpt"],
        message: "Body excerpt and digest must either both be present or both be absent.",
      });
    }
    if (observation.bodyTruncated && !hasExcerpt) {
      context.addIssue({
        code: "custom",
        path: ["bodyTruncated"],
        message: "An unknown body cannot be marked truncated.",
      });
    }
    if (
      hasExcerpt &&
      hasDigest &&
      !observation.bodyTruncated &&
      fingerprint(observation.bodyExcerpt) !== observation.bodyDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["bodyDigest"],
        message: "A complete body excerpt must match its full-body digest.",
      });
    }
    if (
      observation.outcome === "transport_failed" &&
      (hasExcerpt || hasDigest || observation.bodyTruncated)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "A transport failure cannot claim a fully observed response body.",
      });
    }
    if (
      observation.outcome === "response_invalid" &&
      (observation.httpStatus === null || !hasExcerpt || !hasDigest)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "An invalid response requires known HTTP and body evidence.",
      });
    }
    if (observation.httpStatus === null && observation.contentType !== null) {
      context.addIssue({
        code: "custom",
        path: ["contentType"],
        message: "Content type cannot be known without an observed HTTP response.",
      });
    }
  });

export type CodexTransportObservation = z.infer<
  typeof CodexTransportObservationSchema
>;
export type CodexTransportObservationInput = Omit<
  CodexTransportObservation,
  "kind" | "version"
>;

export function codexTransportObservationSourceId(requestId: string): string {
  return `source-codex-transport-observation:${requestId}`;
}

export function codexTransportObservationSourceEvent(input: {
  readonly observation: CodexTransportObservationInput;
  readonly eventId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly systemActor: Actor;
}): LedgerEventOf<"source.captured"> {
  if (input.systemActor.kind !== "system") {
    throw new Error(
      "Codex transport evidence must be captured by the trusted system boundary.",
    );
  }

  const artifact = CodexTransportObservationSchema.parse({
    kind: "odeu.codex-transport-observation",
    version: 1,
    requestId: input.observation.requestId,
    runId: input.observation.runId,
    outcome: input.observation.outcome,
    httpStatus: input.observation.httpStatus,
    contentType: input.observation.contentType,
    bodyExcerpt: input.observation.bodyExcerpt,
    bodyTruncated: input.observation.bodyTruncated,
    bodyDigest: input.observation.bodyDigest,
  });

  return sourceCapturedEvent({
    eventId: input.eventId,
    commandId: input.commandId,
    occurredAt: input.occurredAt,
    actor: input.systemActor,
    payload: {
      source: {
        id: codexTransportObservationSourceId(artifact.requestId),
        kind: "system",
        content: stableStringify(artifact),
        visibility: "shared",
        integrity: {
          algorithm: "fnv1a64",
          digest: fingerprint(artifact),
        },
      },
    },
  });
}

export function parseCodexTransportObservation(
  content: string,
): CodexTransportObservation | null {
  try {
    return CodexTransportObservationSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

export function parseCodexTransportObservationSource(
  source: SourceRecord,
): CodexTransportObservation | null {
  const observation = parseCodexTransportObservation(source.content);
  if (
    !observation ||
    source.kind !== "system" ||
    source.visibility !== "shared" ||
    source.id !== codexTransportObservationSourceId(observation.requestId) ||
    source.content !== stableStringify(observation) ||
    source.integrity?.algorithm !== "fnv1a64" ||
    source.integrity.digest !== fingerprint(observation)
  ) {
    return null;
  }
  return observation;
}

export function parseCodexTransportObservationEvent(
  event: LedgerEventOf<"source.captured">,
): CodexTransportObservation | null {
  if (event.actor.kind !== "system") return null;
  return parseCodexTransportObservationSource(event.payload.source);
}
