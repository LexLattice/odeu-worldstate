import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runCodexReplay } from "@/adapters/codex/replay";
import { verifyReplayEvidence } from "@/adapters/replay-evidence/server";
import {
  appendLedgerEvent,
  buildDeltaAcceptedEvent,
  deltaProposedEvent,
  evidenceValidationEvent,
  evaluateIntegrationGate,
  fingerprint,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  sourceCapturedEvent,
  stableStringify,
  type AgentRun,
  type WorldstateLedger,
} from "@/domain";
import { createPrivateProjectionFixture, HOME_MOVE_ACTORS } from "@/fixtures";
import {
  codexRunResponseEvents,
  parseCodexRunExchangeSource,
} from "@/integration/codex-run-evidence";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";
import {
  INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
  compileReplayEvidenceRequest,
  replayEvidenceValidationAttemptSourceEvent,
  replayEvidenceValidationExchangeSourceEvent,
  replayEvidenceValidationRecordedEvent,
} from "@/integration/replay-evidence-validation";
import {
  ReconciliationCompilationError,
  assertReconciliationDeltaMatchesCurrentState,
  compileValidatedClosureReconciliation,
  parseResultReconciliationArtifactSource,
  resultReconciliationDeltaId,
  resultReconciliationProposalEvents,
  resultReconciliationSourceId,
} from "./validated-closure-to-reconciliation";

function append(
  ledger: WorldstateLedger,
  event: Parameters<typeof appendLedgerEvent>[1],
): WorldstateLedger {
  return appendLedgerEvent(ledger, event).ledger;
}

async function validatedReplayFixture() {
  const fixture = createPrivateProjectionFixture();
  const run: AgentRun = {
    id: "run-result-reconciliation",
    briefId: fixture.brief.id,
    baseRevisionId: fixture.brief.baseRevisionId,
    artifactBaseRef: fixture.brief.artifactBaseRef,
    mode: "replay",
  };
  let ledger = append(
    fixture.ledger,
    runAuthorizedEvent({
      eventId: "event-result-reconciliation-run",
      commandId: "command-result-reconciliation-run",
      occurredAt: "2026-07-18T09:00:00.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: { run },
    }),
  );
  const request = domainBriefToCodexRunRequest(
    fixture.brief,
    run.id,
    run.mode,
    "request-result-reconciliation-codex",
  );
  const response = runCodexReplay(request);
  for (const event of codexRunResponseEvents({
    run,
    brief: fixture.brief,
    request,
    response,
    recordedAt: "2026-07-18T09:00:01.000Z",
    systemActor: HOME_MOVE_ACTORS.system,
  })) {
    ledger = append(ledger, event);
  }
  const returnedState = reduceWorldstateLedger(ledger);
  const closure = Object.values(returnedState.operational.closures).find(
    (candidate) => candidate.runId === run.id,
  );
  const codexExchange = ledger.events
    .filter((event) => event.type === "source.captured")
    .map((event) => parseCodexRunExchangeSource(event.payload.source))
    .find((candidate) => candidate?.request.runId === run.id);
  if (!closure || !codexExchange) {
    throw new Error("Expected a returned replay closure and exact exchange.");
  }
  const validationRequest = compileReplayEvidenceRequest({
    validationRequestId: "request-result-reconciliation-validation",
    validationId: "validation-result-reconciliation",
    run,
    brief: fixture.brief,
    closure,
    codexExchange,
  });
  ledger = append(
    ledger,
    replayEvidenceValidationAttemptSourceEvent({
      request: validationRequest,
      eventId: "event-result-reconciliation-validation-attempt",
      commandId: "command-result-reconciliation-validation-attempt",
      occurredAt: "2026-07-18T09:00:02.000Z",
      actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
    }),
  );
  const validationResponse = await verifyReplayEvidence(validationRequest, {
    now: () => new Date("2026-07-18T09:00:03.000Z"),
  });
  ledger = append(
    ledger,
    replayEvidenceValidationExchangeSourceEvent({
      request: validationRequest,
      response: validationResponse,
      eventId: "event-result-reconciliation-validation-exchange",
      commandId: "command-result-reconciliation-validation-exchange",
      occurredAt: "2026-07-18T09:00:03.000Z",
      actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
    }),
  );
  ledger = append(
    ledger,
    replayEvidenceValidationRecordedEvent({
      state: reduceWorldstateLedger(ledger),
      request: validationRequest,
      response: validationResponse,
      eventId: "event-result-reconciliation-validation-recorded",
      commandId: "command-result-reconciliation-validation-recorded",
      occurredAt: "2026-07-18T09:00:04.000Z",
      actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
    }),
  );
  const state = reduceWorldstateLedger(ledger);
  const deltaId = resultReconciliationDeltaId({
    closureId: closure.id,
    validationId: validationRequest.validationId,
    baseRevisionId: state.canonical.head.id,
  });
  return {
    fixture,
    run,
    closure,
    validationRequest,
    ledger,
    state,
    deltaId,
  };
}

describe("validated closure reconciliation", () => {
  it("persists an integrity-bound candidate without canonical mutation", async () => {
    const fixture = await validatedReplayFixture();
    const beforeHead = fixture.state.canonical.head;
    const events = resultReconciliationProposalEvents({
      state: fixture.state,
      closureId: fixture.closure.id,
      validationId: fixture.validationRequest.validationId,
      deltaId: fixture.deltaId,
      occurredAt: "2026-07-18T09:01:00.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    });
    let ledger = fixture.ledger;
    for (const event of events) ledger = append(ledger, event);
    const proposed = reduceWorldstateLedger(ledger);
    const projection = proposed.operational.deltas[fixture.deltaId];
    const source = proposed.operational.sources[
      resultReconciliationSourceId(fixture.deltaId)
    ];
    const artifact = parseResultReconciliationArtifactSource(source);

    expect(proposed.canonical.head).toEqual(beforeHead);
    expect(proposed.canonical.revisionOrder).toEqual(
      fixture.state.canonical.revisionOrder,
    );
    expect(projection.disposition).toBe("pending");
    expect(projection.delta.validationRef).toBe(
      fixture.validationRequest.validationId,
    );
    expect(projection.delta.sourceRefs).toEqual(
      expect.arrayContaining([
        fixture.validationRequest.exchangeSourceId,
        `source-replay-evidence-exchange:${fixture.validationRequest.validationRequestId}`,
        resultReconciliationSourceId(fixture.deltaId),
      ]),
    );
    expect(artifact?.delta).toEqual(projection.delta);
    expect(artifact).toMatchObject({
      verificationScope: "registered_fixture_bundle",
      causalAuthorshipEstablished: false,
      artifactPromotion: "not_performed",
    });
    expect(projection.delta.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "node.patch" }),
        expect.objectContaining({ op: "node.add" }),
        expect.objectContaining({ op: "relation.add" }),
      ]),
    );
    expect(() =>
      assertReconciliationDeltaMatchesCurrentState(
        proposed,
        fixture.deltaId,
      ),
    ).not.toThrow();
  });

  it("rejects manager-substituted consequences even when the evidence gate passes", async () => {
    const fixture = await validatedReplayFixture();
    const events = resultReconciliationProposalEvents({
      state: fixture.state,
      closureId: fixture.closure.id,
      validationId: fixture.validationRequest.validationId,
      deltaId: fixture.deltaId,
      occurredAt: "2026-07-18T09:02:00.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    });
    const withSource = append(fixture.ledger, events[0]);
    const tampered = deltaProposedEvent({
      ...events[1],
      payload: {
        delta: {
          ...events[1].payload.delta,
          visibleConsequence: "A manager-substituted canonical claim.",
        },
      },
    });
    const state = reduceWorldstateLedger(append(withSource, tampered));

    expect(() =>
      assertReconciliationDeltaMatchesCurrentState(state, fixture.deltaId),
    ).toThrow(ReconciliationCompilationError);
  });

  it("rejects a digest-valid receipt whose lineage bindings were substituted", async () => {
    const fixture = await validatedReplayFixture();
    const events = resultReconciliationProposalEvents({
      state: fixture.state,
      closureId: fixture.closure.id,
      validationId: fixture.validationRequest.validationId,
      deltaId: fixture.deltaId,
      occurredAt: "2026-07-18T09:02:30.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    });
    const artifact = parseResultReconciliationArtifactSource(
      events[0].payload.source,
    );
    if (!artifact) throw new Error("Expected a valid reconciliation receipt.");
    const substituted = {
      ...artifact,
      bindings: { ...artifact.bindings, runId: "run-substituted" },
    };
    const sourceEvent = sourceCapturedEvent({
      ...events[0],
      payload: {
        source: {
          ...events[0].payload.source,
          content: stableStringify(substituted),
          integrity: {
            algorithm: "fnv1a64",
            digest: fingerprint(substituted),
          },
        },
      },
    });
    const ledger = append(append(fixture.ledger, sourceEvent), events[1]);

    expect(() =>
      assertReconciliationDeltaMatchesCurrentState(
        reduceWorldstateLedger(ledger),
        fixture.deltaId,
      ),
    ).toThrow(/exactly match the deterministic candidate/i);
  });

  it("pins proposal meaning to validationRef when a later validation is recorded", async () => {
    const fixture = await validatedReplayFixture();
    let ledger = fixture.ledger;
    for (const event of resultReconciliationProposalEvents({
      state: fixture.state,
      closureId: fixture.closure.id,
      validationId: fixture.validationRequest.validationId,
      deltaId: fixture.deltaId,
      occurredAt: "2026-07-18T09:03:00.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    })) {
      ledger = append(ledger, event);
    }
    const original = fixture.state.operational.validations[
      fixture.validationRequest.validationId
    ];
    ledger = append(
      ledger,
      evidenceValidationEvent({
        eventId: "event-later-reconciliation-validation",
        commandId: "command-later-reconciliation-validation",
        occurredAt: "2026-07-18T09:03:01.000Z",
        actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
        payload: {
          validation: {
            ...original,
            id: "validation-result-reconciliation-later",
            observations: original.observations.map((observation, index) =>
              index === 0
                ? { ...observation, result: "failed" as const }
                : observation,
            ),
          },
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);

    expect(state.operational.latestValidationByClosure[fixture.closure.id]).toBe(
      "validation-result-reconciliation-later",
    );
    expect(() =>
      assertReconciliationDeltaMatchesCurrentState(state, fixture.deltaId),
    ).not.toThrow();
    expect(evaluateIntegrationGate(state, fixture.deltaId)).toMatchObject({
      allowed: true,
      verified: true,
      reasons: [],
    });
  });

  it("refuses failed required evidence before any proposal event is created", async () => {
    const fixture = await validatedReplayFixture();
    const original = fixture.state.operational.validations[
      fixture.validationRequest.validationId
    ];
    const failedId = "validation-result-reconciliation-failed";
    const ledger = append(
      fixture.ledger,
      evidenceValidationEvent({
        eventId: "event-failed-reconciliation-validation",
        commandId: "command-failed-reconciliation-validation",
        occurredAt: "2026-07-18T09:04:00.000Z",
        actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
        payload: {
          validation: {
            ...original,
            id: failedId,
            observations: original.observations.map((observation, index) =>
              index === 0
                ? { ...observation, result: "failed" as const }
                : observation,
            ),
          },
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);

    expect(() =>
      compileValidatedClosureReconciliation(state, {
        closureId: fixture.closure.id,
        validationId: failedId,
        deltaId: "delta-failed-evidence",
      }),
    ).toThrow(ReconciliationCompilationError);
    expect(state.canonical.head).toEqual(fixture.state.canonical.head);
  });

  it("refuses to rebase a validated closure after the canonical head advances", async () => {
    const fixture = await validatedReplayFixture();
    const correction = {
      id: "delta-concurrent-before-reconciliation",
      baseRevisionId: fixture.state.canonical.head.id,
      scopeId: fixture.state.canonical.projectId,
      purpose: "correction" as const,
      proposedBy: HOME_MOVE_ACTORS.human,
      operations: [
        {
          op: "node.patch" as const,
          nodeId: fixture.fixture.brief.targetNodeId,
          patch: { data: { concurrentRevision: true } },
        },
      ],
      rationale: ["Advance canonical truth before reconciliation."],
      sourceRefs: [],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "The task records a concurrent canonical update.",
    };
    let ledger = append(
      fixture.ledger,
      deltaProposedEvent({
        eventId: "event-concurrent-before-reconciliation",
        commandId: "command-concurrent-before-reconciliation",
        occurredAt: "2026-07-18T09:04:30.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta: correction },
      }),
    );
    const proposed = reduceWorldstateLedger(ledger);
    ledger = append(
      ledger,
      buildDeltaAcceptedEvent(proposed, {
        eventId: "event-concurrent-before-reconciliation-accepted",
        commandId: "command-concurrent-before-reconciliation-accepted",
        occurredAt: "2026-07-18T09:04:31.000Z",
        actor: HOME_MOVE_ACTORS.human,
        deltaId: correction.id,
      }),
    );
    const advanced = reduceWorldstateLedger(ledger);

    expect(advanced.canonical.head.id).not.toBe(
      fixture.state.canonical.head.id,
    );
    expect(() =>
      compileValidatedClosureReconciliation(advanced, {
        closureId: fixture.closure.id,
        validationId: fixture.validationRequest.validationId,
        deltaId: fixture.deltaId,
      }),
    ).toThrow(/one current worldstate revision/i);
  });

  it("requires a separate human acceptance and advances exactly one revision", async () => {
    const fixture = await validatedReplayFixture();
    let ledger = fixture.ledger;
    for (const event of resultReconciliationProposalEvents({
      state: fixture.state,
      closureId: fixture.closure.id,
      validationId: fixture.validationRequest.validationId,
      deltaId: fixture.deltaId,
      occurredAt: "2026-07-18T09:05:00.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    })) {
      ledger = append(ledger, event);
    }
    const proposed = reduceWorldstateLedger(ledger);
    const systemAcceptance = buildDeltaAcceptedEvent(proposed, {
      eventId: "event-system-result-integration",
      commandId: "command-system-result-integration",
      occurredAt: "2026-07-18T09:05:01.000Z",
      actor: HOME_MOVE_ACTORS.system,
      deltaId: fixture.deltaId,
      artifactBaseRef: fixture.closure.artifactBaseRef,
    });
    expect(() => append(ledger, systemAcceptance)).toThrow(
      /explicit human authority/i,
    );

    const acceptance = buildDeltaAcceptedEvent(proposed, {
      eventId: "event-human-result-integration",
      commandId: "command-human-result-integration",
      occurredAt: "2026-07-18T09:05:02.000Z",
      actor: HOME_MOVE_ACTORS.human,
      deltaId: fixture.deltaId,
      artifactBaseRef: fixture.closure.artifactBaseRef,
    });
    const integrated = reduceWorldstateLedger(append(ledger, acceptance));
    const task = integrated.canonical.nodes[fixture.fixture.brief.targetNodeId];

    expect(integrated.canonical.revisionOrder).toHaveLength(
      proposed.canonical.revisionOrder.length + 1,
    );
    expect(task.work).toEqual({
      phase: "completed",
      verification: "verified",
    });
    expect(task.data).toMatchObject({
      verificationScope: "registered_fixture_bundle",
      causalAuthorshipEstablished: false,
      artifactPromotion: "not_performed",
    });
    expect(integrated.operational.runs[fixture.run.id].status).toBe("returned");
    expect(() =>
      assertReconciliationDeltaMatchesCurrentState(
        integrated,
        fixture.deltaId,
      ),
    ).not.toThrow();
  });
});
