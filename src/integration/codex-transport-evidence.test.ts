import { describe, expect, it } from "vitest";

import { fingerprint, stableStringify } from "@/domain";
import { HOME_MOVE_ACTORS } from "@/fixtures";

import {
  CODEX_TRANSPORT_BODY_EXCERPT_MAX_LENGTH,
  codexTransportObservationSourceEvent,
  codexTransportObservationSourceId,
  parseCodexTransportObservationEvent,
  parseCodexTransportObservationSource,
  type CodexTransportObservationInput,
} from "./codex-transport-evidence";

const RAW_INVALID_BODY = JSON.stringify({ ok: true });

function invalidResponseObservation(): CodexTransportObservationInput {
  return {
    requestId: "request-transport-evidence",
    runId: "run-transport-evidence",
    outcome: "response_invalid",
    httpStatus: 422,
    contentType: "application/problem+json",
    bodyExcerpt: RAW_INVALID_BODY,
    bodyTruncated: false,
    bodyDigest: fingerprint(RAW_INVALID_BODY),
  };
}

function observationEvent(
  observation: CodexTransportObservationInput = invalidResponseObservation(),
) {
  return codexTransportObservationSourceEvent({
    observation,
    eventId: "event-codex-transport-observation",
    commandId: "command-codex-transport-observation",
    occurredAt: "2026-07-17T14:00:07.000Z",
    systemActor: HOME_MOVE_ACTORS.system,
  });
}

describe("Codex transport evidence", () => {
  it("round-trips deterministic system/shared integrity-bound evidence", () => {
    const event = observationEvent();
    const parsed = parseCodexTransportObservationEvent(event);

    expect(event.payload.source).toMatchObject({
      id: codexTransportObservationSourceId(
        invalidResponseObservation().requestId,
      ),
      kind: "system",
      visibility: "shared",
      integrity: { algorithm: "fnv1a64" },
    });
    expect(parsed).toEqual({
      kind: "odeu.codex-transport-observation",
      version: 1,
      ...invalidResponseObservation(),
    });
    expect(event.payload.source.content).toBe(stableStringify(parsed));
  });

  it("rejects altered content, integrity, identity, visibility, and actor posture", () => {
    const event = observationEvent();
    const source = event.payload.source;

    expect(
      parseCodexTransportObservationSource({
        ...source,
        content: source.content.replace("response_invalid", "transport_failed"),
      }),
    ).toBeNull();
    expect(
      parseCodexTransportObservationSource({
        ...source,
        integrity: { algorithm: "fnv1a64", digest: "fnv1a64:0000000000000000" },
      }),
    ).toBeNull();
    expect(
      parseCodexTransportObservationSource({ ...source, id: "source-wrong" }),
    ).toBeNull();
    expect(
      parseCodexTransportObservationSource({ ...source, visibility: "private" }),
    ).toBeNull();
    expect(
      parseCodexTransportObservationEvent({
        ...event,
        actor: HOME_MOVE_ACTORS.codex,
      }),
    ).toBeNull();
  });

  it("accepts bounded truncated evidence while retaining the full-body digest", () => {
    const rawBody = "x".repeat(
      CODEX_TRANSPORT_BODY_EXCERPT_MAX_LENGTH + 1_000,
    );
    const event = observationEvent({
      ...invalidResponseObservation(),
      bodyExcerpt: rawBody.slice(0, CODEX_TRANSPORT_BODY_EXCERPT_MAX_LENGTH),
      bodyTruncated: true,
      bodyDigest: fingerprint(rawBody),
    });

    expect(parseCodexTransportObservationEvent(event)).toMatchObject({
      bodyExcerpt: rawBody.slice(0, CODEX_TRANSPORT_BODY_EXCERPT_MAX_LENGTH),
      bodyTruncated: true,
      bodyDigest: fingerprint(rawBody),
    });
  });

  it("fails closed on internally incoherent or oversized observations", () => {
    expect(() =>
      observationEvent({
        ...invalidResponseObservation(),
        bodyDigest: fingerprint("different body"),
      }),
    ).toThrow(/complete body excerpt must match/i);
    expect(() =>
      observationEvent({
        ...invalidResponseObservation(),
        bodyExcerpt: "x".repeat(CODEX_TRANSPORT_BODY_EXCERPT_MAX_LENGTH + 1),
        bodyTruncated: true,
      }),
    ).toThrow();
    expect(() =>
      observationEvent({
        requestId: "request-transport-failed-with-body",
        runId: "run-transport-failed-with-body",
        outcome: "transport_failed",
        httpStatus: null,
        contentType: null,
        bodyExcerpt: "claimed partial body",
        bodyTruncated: false,
        bodyDigest: fingerprint("claimed partial body"),
      }),
    ).toThrow(/transport failure cannot claim/i);
  });

  it("requires a system actor when constructing the observation event", () => {
    expect(() =>
      codexTransportObservationSourceEvent({
        observation: invalidResponseObservation(),
        eventId: "event-untrusted-transport-observation",
        commandId: "command-untrusted-transport-observation",
        occurredAt: "2026-07-17T14:00:07.000Z",
        systemActor: HOME_MOVE_ACTORS.codex,
      }),
    ).toThrow(/trusted system boundary/i);
  });
});
