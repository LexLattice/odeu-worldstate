import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runCodexReplay } from "@/adapters/codex/replay";
import {
  ReplayEvidenceRequestSchema,
  ReplayEvidenceSuccessSchema,
  type ReplayEvidenceSuccess,
} from "@/adapters/replay-evidence";
import { verifyReplayEvidence } from "@/adapters/replay-evidence/server";
import {
  appendLedgerEvent,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  type AgentRun,
  type WorldstateLedger,
} from "@/domain";
import {
  createPrivateProjectionFixture,
  HOME_MOVE_ACTORS,
} from "@/fixtures";
import {
  codexRunResponseEvents,
  parseCodexRunExchangeSource,
} from "./codex-run-evidence";
import { domainBriefToCodexRunRequest } from "./domain-brief-to-codex";
import {
  INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
  ReplayEvidenceValidationCoherenceError,
  compileReplayEvidenceRequest,
  parseReplayEvidenceValidationExchangeSource,
  replayEvidenceValidationAttemptSourceEvent,
  replayEvidenceValidationExchangeSourceEvent,
  replayEvidenceValidationRecordedEvent,
} from "./replay-evidence-validation";

function append(
  ledger: WorldstateLedger,
  event: Parameters<typeof appendLedgerEvent>[1],
): WorldstateLedger {
  return appendLedgerEvent(ledger, event).ledger;
}

function returnedReplayFixture() {
  const fixture = createPrivateProjectionFixture();
  const run: AgentRun = {
    id: "run-independent-validation",
    briefId: fixture.brief.id,
    baseRevisionId: fixture.brief.baseRevisionId,
    artifactBaseRef: fixture.brief.artifactBaseRef,
    mode: "replay",
  };
  let ledger = append(
    fixture.ledger,
    runAuthorizedEvent({
      eventId: "event-independent-validation-run",
      commandId: "command-independent-validation-run",
      occurredAt: "2026-07-17T15:00:00.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: { run },
    }),
  );
  const codexRequest = domainBriefToCodexRunRequest(
    fixture.brief,
    run.id,
    run.mode,
    "request-independent-validation-codex",
  );
  const codexResponse = runCodexReplay(codexRequest);
  for (const event of codexRunResponseEvents({
    run,
    brief: fixture.brief,
    request: codexRequest,
    response: codexResponse,
    recordedAt: "2026-07-17T15:00:01.000Z",
    systemActor: HOME_MOVE_ACTORS.system,
  })) {
    ledger = append(ledger, event);
  }
  const state = reduceWorldstateLedger(ledger);
  const closure = Object.values(state.operational.closures).find(
    (candidate) => candidate.runId === run.id,
  );
  const codexExchange = ledger.events
    .filter((event) => event.type === "source.captured")
    .map((event) => parseCodexRunExchangeSource(event.payload.source))
    .find((candidate) => candidate?.request.runId === run.id);
  if (!closure || !codexExchange) {
    throw new Error("Expected a coherent returned replay fixture.");
  }
  const validationRequest = compileReplayEvidenceRequest({
    validationRequestId: "request-independent-validation",
    validationId: "validation-independent-replay",
    run,
    brief: fixture.brief,
    closure,
    codexExchange,
  });
  return {
    fixture,
    run,
    ledger,
    closure,
    validationRequest,
  };
}

async function observedExchange(
  input: ReturnType<typeof returnedReplayFixture>,
  response?: ReplayEvidenceSuccess,
) {
  let ledger = append(
    input.ledger,
    replayEvidenceValidationAttemptSourceEvent({
      request: input.validationRequest,
      eventId: "event-independent-validation-attempt",
      commandId: "command-independent-validation-attempt",
      occurredAt: "2026-07-17T15:00:02.000Z",
      actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
    }),
  );
  const observed =
    response ??
    (await verifyReplayEvidence(input.validationRequest, {
      now: () => new Date("2026-07-17T15:00:03.000Z"),
    }));
  ledger = append(
    ledger,
    replayEvidenceValidationExchangeSourceEvent({
      request: input.validationRequest,
      response: observed,
      eventId: "event-independent-validation-exchange",
      commandId: "command-independent-validation-exchange",
      occurredAt: "2026-07-17T15:00:03.000Z",
      actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
    }),
  );
  return { ledger, response: observed };
}

describe("independent replay evidence normalization", () => {
  it("grounds passing observations in an exact verifier source without canonical mutation", async () => {
    const fixture = returnedReplayFixture();
    const beforeCanonical = fixture.fixture.state.canonical;
    const observed = await observedExchange(fixture);
    const beforeValidation = reduceWorldstateLedger(observed.ledger);
    const event = replayEvidenceValidationRecordedEvent({
      state: beforeValidation,
      request: fixture.validationRequest,
      response: observed.response,
      eventId: "event-independent-validation-recorded",
      commandId: "command-independent-validation-recorded",
      occurredAt: "2026-07-17T15:00:04.000Z",
      actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
    });
    const ledger = append(observed.ledger, event);
    const state = reduceWorldstateLedger(ledger);
    const validation =
      state.operational.validations[fixture.validationRequest.validationId];

    expect(validation.evidenceSourceId).toBe(
      `source-replay-evidence-exchange:${fixture.validationRequest.validationRequestId}`,
    );
    expect(validation.observations).toHaveLength(
      fixture.fixture.brief.evidenceContract.requirements.length,
    );
    expect(
      validation.observations.every(
        (observation) =>
          observation.result === "passed" &&
          observation.freshness === "current" &&
          observation.evidenceRefs.includes(validation.evidenceSourceId),
      ),
    ).toBe(true);
    expect(state.canonical).toEqual(beforeCanonical);
    expect(
      Object.values(state.operational.deltas).some(
        (projection) => projection.delta.purpose === "reconciliation",
      ),
    ).toBe(false);
  });

  it("normalizes an omitted declared observation as missing instead of inventing a pass", async () => {
    const fixture = returnedReplayFixture();
    const complete = await verifyReplayEvidence(fixture.validationRequest, {
      now: () => new Date("2026-07-17T15:05:00.000Z"),
    });
    const incomplete = ReplayEvidenceSuccessSchema.parse({
      ...complete,
      observations: complete.observations.slice(0, 1),
      status: "passed",
    });
    const observed = await observedExchange(fixture, incomplete);
    const state = reduceWorldstateLedger(observed.ledger);
    const event = replayEvidenceValidationRecordedEvent({
      state,
      request: fixture.validationRequest,
      response: observed.response,
      eventId: "event-independent-validation-missing",
      commandId: "command-independent-validation-missing",
      occurredAt: "2026-07-17T15:05:01.000Z",
      actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
    });
    const normalized = event.payload.validation.observations;

    expect(normalized).toHaveLength(2);
    expect(normalized.filter((item) => item.result === "missing")).toHaveLength(1);
  });

  it("rejects a fabricated pass that uses the wrong evidence kind for its requirement", async () => {
    const fixture = returnedReplayFixture();
    const complete = await verifyReplayEvidence(fixture.validationRequest, {
      now: () => new Date("2026-07-17T15:07:00.000Z"),
    });
    if (!complete.ok) throw new Error("Expected registered replay evidence.");
    const artifactObservation = complete.observations.find(
      (observation) => observation.artifact !== null,
    );
    const testObservation = complete.observations.find(
      (observation) => observation.execution !== null,
    );
    if (!artifactObservation?.artifact || !testObservation) {
      throw new Error("Expected artifact and execution observations.");
    }
    const fabricated = ReplayEvidenceSuccessSchema.parse({
      ...complete,
      observations: complete.observations.map((observation) =>
        observation.requirementId === testObservation.requirementId
          ? {
              ...observation,
              evidenceRef: artifactObservation.evidenceRef,
              artifact: artifactObservation.artifact,
              execution: null,
            }
          : observation,
      ),
    });
    const observed = await observedExchange(fixture, fabricated);

    expect(() =>
      replayEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(observed.ledger),
        request: fixture.validationRequest,
        response: fabricated,
        eventId: "event-independent-validation-wrong-evidence-kind",
        commandId: "command-independent-validation-wrong-evidence-kind",
        occurredAt: "2026-07-17T15:07:01.000Z",
        actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
      }),
    ).toThrow(ReplayEvidenceValidationCoherenceError);
  });

  it("normalizes only the exact request and response stored in the durable exchange", async () => {
    const fixture = returnedReplayFixture();
    const observed = await observedExchange(fixture);
    if (!observed.response.ok) {
      throw new Error("Expected registered replay evidence.");
    }
    const substituted = ReplayEvidenceSuccessSchema.parse({
      ...observed.response,
      observedAt: "2026-07-17T15:08:00.000Z",
    });

    expect(() =>
      replayEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(observed.ledger),
        request: fixture.validationRequest,
        response: substituted,
        eventId: "event-independent-validation-substituted",
        commandId: "command-independent-validation-substituted",
        occurredAt: "2026-07-17T15:08:01.000Z",
        actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
      }),
    ).toThrow(ReplayEvidenceValidationCoherenceError);
  });

  it("rejects validation that substitutes a nonexistent original Codex exchange", async () => {
    const fixture = returnedReplayFixture();
    const substitutedRequest = ReplayEvidenceRequestSchema.parse({
      ...fixture.validationRequest,
      exchangeSourceId: "source-codex-exchange:request-substituted-codex",
    });
    const substitutedFixture = {
      ...fixture,
      validationRequest: substitutedRequest,
    };
    const observed = await observedExchange(substitutedFixture);

    expect(() =>
      replayEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(observed.ledger),
        request: substitutedRequest,
        response: observed.response,
        eventId: "event-independent-validation-substituted-codex-source",
        commandId: "command-independent-validation-substituted-codex-source",
        occurredAt: "2026-07-17T15:09:01.000Z",
        actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
      }),
    ).toThrow(ReplayEvidenceValidationCoherenceError);
  });

  it("persists a mismatched exact response but refuses to mint validation from it", async () => {
    const fixture = returnedReplayFixture();
    const response = await verifyReplayEvidence(fixture.validationRequest, {
      now: () => new Date("2026-07-17T15:10:00.000Z"),
    });
    const mismatched = ReplayEvidenceSuccessSchema.parse({
      ...response,
      bindings: { ...response.bindings, closureId: "closure-other" },
    });
    const observed = await observedExchange(fixture, mismatched);
    const source = observed.ledger.events.at(-1);
    if (source?.type !== "source.captured") {
      throw new Error("Expected the mismatched response source.");
    }
    expect(
      parseReplayEvidenceValidationExchangeSource(source.payload.source),
    ).not.toBeNull();
    expect(() =>
      replayEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(observed.ledger),
        request: fixture.validationRequest,
        response: mismatched,
        eventId: "event-independent-validation-mismatch",
        commandId: "command-independent-validation-mismatch",
        occurredAt: "2026-07-17T15:10:01.000Z",
        actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
      }),
    ).toThrow(ReplayEvidenceValidationCoherenceError);
  });
});
