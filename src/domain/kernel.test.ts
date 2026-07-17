import { describe, expect, it } from "vitest";

import {
  appendLedgerEvent,
  briefCompiledEvent,
  buildDeltaAcceptedEvent,
  deltaDispositionEvent,
  deltaProposedEvent,
  evidenceValidationEvent,
  evaluateIntegrationGate,
  KernelError,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  selectCurrentNodes,
  type WorldstateDelta,
  type WorldstateLedger,
} from "@/domain";
import {
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
  createAdoptedDecisionConflictFixture,
  createAmbiguousPlacementFixture,
  createBlockedIntegrationFixture,
  createCompensatingRevisionFixture,
  createHappyPlacementFixture,
  createHomeMoveDemoFixture,
  createHomeMoveSeedFixture,
  createIntegratedResultFixture,
  createLiveWorkerClosureFixture,
  createManualMoveFixture,
  createMissingEvidenceFixture,
  createPrivateProjectionFixture,
  createReplayClosureFixture,
  createStaleClosureFixture,
  createStaleProposalFixture,
} from "@/fixtures";

function expectKernelCode(action: () => unknown, code: KernelError["code"]): void {
  try {
    action();
    throw new Error(`Expected KernelError(${code}).`);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe(code);
  }
}

describe("deterministic ledger reduction", () => {
  it("reduces the same ordered ledger byte-for-byte identically", () => {
    const { ledger } = createHomeMoveDemoFixture();
    const first = reduceWorldstateLedger(ledger);
    const second = reduceWorldstateLedger(JSON.parse(JSON.stringify(ledger)) as WorldstateLedger);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.canonical.head.stateHash).toBe(first.canonical.head.stateHash);
  });

  it("allows only delta.accepted events to mutate the canonical projection", () => {
    const { ledger } = createHomeMoveDemoFixture();
    let prefix: WorldstateLedger = { ...ledger, events: [] };
    let previous = reduceWorldstateLedger(prefix);

    for (const event of ledger.events) {
      prefix = { ...ledger, events: [...prefix.events, event] };
      const next = reduceWorldstateLedger(prefix);
      if (event.type === "delta.accepted") {
        expect(next.canonical.head.id).not.toBe(previous.canonical.head.id);
      } else {
        expect(next.canonical).toEqual(previous.canonical);
      }
      previous = next;
    }
  });

  it("returns the original event IDs on an exact idempotent retry", () => {
    const { ledger } = createHomeMoveSeedFixture();
    const event = ledger.events.at(-1)!;
    const result = appendLedgerEvent(ledger, event);

    expect(result.replayed).toBe(true);
    expect(result.emittedEventIds).toEqual([event.eventId]);
    expect(result.ledger).toBe(ledger);
    expect(result.ledger.events).toHaveLength(ledger.events.length);
  });

  it("rejects event and command ID reuse with different content", () => {
    const { ledger } = createHomeMoveSeedFixture();
    const event = ledger.events.at(-1)!;
    const alteredEvent = { ...event, occurredAt: "2026-07-16T10:00:00.000Z" };
    expectKernelCode(
      () => appendLedgerEvent(ledger, alteredEvent),
      "event_id_conflict",
    );

    const changedIds = { ...event, eventId: "event-different-same-command" };
    expectKernelCode(
      () => appendLedgerEvent(ledger, changedIds),
      "command_id_conflict",
    );
  });
});

describe("revision, status, and disposition law", () => {
  it("rejects an agent-authored canonical acceptance", () => {
    const accepted = createHappyPlacementFixture();
    const lastEvent = accepted.ledger.events.at(-1);
    if (!lastEvent || lastEvent.type !== "delta.accepted") {
      throw new Error("Expected the happy-placement fixture to end in delta.accepted.");
    }
    const ledger: WorldstateLedger = {
      ...accepted.ledger,
      events: accepted.ledger.events.slice(0, -1),
    };
    const state = reduceWorldstateLedger(ledger);
    const event = buildDeltaAcceptedEvent(state, {
      eventId: "event-agent-self-accept",
      commandId: "command-agent-self-accept",
      occurredAt: "2026-07-16T10:00:30.000Z",
      actor: HOME_MOVE_ACTORS.codex,
      deltaId: lastEvent.payload.deltaId,
    });

    expectKernelCode(() => appendLedgerEvent(ledger, event), "authority_violation");
  });

  it("fails closed when a proposal's exact base revision is stale", () => {
    const stale = createStaleProposalFixture();
    expect(stale.state.canonical.head.id).not.toBe(
      stale.state.operational.deltas[stale.staleDeltaId].delta.baseRevisionId,
    );
    expectKernelCode(
      () => appendLedgerEvent(stale.ledger, stale.staleAcceptedEvent),
      "revision_conflict",
    );
  });

  it("merges orthogonal status dimensions without overwriting siblings", () => {
    const seeded = createHomeMoveSeedFixture();
    const before = seeded.state.canonical.nodes[HOME_MOVE_IDS.goal];
    const delta: WorldstateDelta = {
      id: "delta-mark-goal-stale",
      baseRevisionId: seeded.state.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "correction",
      proposedBy: HOME_MOVE_ACTORS.human,
      operations: [
        {
          op: "node.patch",
          nodeId: HOME_MOVE_IDS.goal,
          patch: { knowledge: { freshness: "stale" } },
        },
      ],
      rationale: ["The budget estimate needs a fresh quote review."],
      sourceRefs: [],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "The goal is visibly stale without losing governance or work state.",
    };
    let ledger = appendLedgerEvent(
      seeded.ledger,
      deltaProposedEvent({
        eventId: "event-goal-stale-proposed",
        commandId: "command-goal-stale-proposed",
        occurredAt: "2026-07-16T10:01:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta },
      }),
    ).ledger;
    const proposedState = reduceWorldstateLedger(ledger);
    ledger = appendLedgerEvent(
      ledger,
      buildDeltaAcceptedEvent(proposedState, {
        eventId: "event-goal-stale-accepted",
        commandId: "command-goal-stale-accepted",
        occurredAt: "2026-07-16T10:01:01.000Z",
        actor: HOME_MOVE_ACTORS.human,
        deltaId: delta.id,
      }),
    ).ledger;
    const after = reduceWorldstateLedger(ledger).canonical.nodes[HOME_MOVE_IDS.goal];

    expect(after.knowledge).toEqual({ standing: "supported", freshness: "stale" });
    expect(after.governance).toEqual(before.governance);
    expect(after.work).toEqual(before.work);
  });

  it("keeps defer, reject, remand, and supersede as distinct operational dispositions", () => {
    const ambiguous = createAmbiguousPlacementFixture();
    const ambiguousDelta = ambiguous.state.operational.deltas["delta-placement-ambiguous"];
    expect(ambiguousDelta.disposition).toBe("remanded");

    const manual = createManualMoveFixture();
    expect(manual.state.operational.deltas["delta-placement-providers"].disposition).toBe(
      "superseded",
    );

    let ledger: WorldstateLedger = {
      ...ambiguous.ledger,
      events: ambiguous.ledger.events.slice(0, -1),
    };
    const pending = reduceWorldstateLedger(ledger).operational.deltas["delta-placement-ambiguous"];
    ledger = appendLedgerEvent(
      ledger,
      deltaDispositionEvent({
        eventId: "event-ambiguous-deferred-test",
        commandId: "command-ambiguous-deferred-test",
        occurredAt: "2026-07-16T10:02:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        type: "delta.deferred",
        payload: {
          deltaId: pending.delta.id,
          baseRevisionId: pending.delta.baseRevisionId,
          reason: "Review later.",
        },
      }),
    ).ledger;
    expect(reduceWorldstateLedger(ledger).operational.deltas[pending.delta.id].disposition).toBe(
      "deferred",
    );
    ledger = appendLedgerEvent(
      ledger,
      deltaDispositionEvent({
        eventId: "event-ambiguous-rejected-test",
        commandId: "command-ambiguous-rejected-test",
        occurredAt: "2026-07-16T10:02:01.000Z",
        actor: HOME_MOVE_ACTORS.human,
        type: "delta.rejected",
        payload: {
          deltaId: pending.delta.id,
          baseRevisionId: pending.delta.baseRevisionId,
          reason: "The owner declined this interpretation.",
        },
      }),
    ).ledger;
    expect(reduceWorldstateLedger(ledger).operational.deltas[pending.delta.id].disposition).toBe(
      "rejected",
    );
  });
});

describe("genealogy and projection boundaries", () => {
  it("preserves model and human placement lineage after a manual move", () => {
    const moved = createManualMoveFixture();
    const sourceId = `${HOME_MOVE_IDS.source}-manual`;
    expect(moved.state.provenance.sourceToDeltaIds[sourceId]).toEqual([
      "delta-placement-providers",
      "delta-placement-moved-budget",
    ]);
    expect(moved.state.provenance.supersession["delta-placement-providers"]).toBe(
      "delta-placement-moved-budget",
    );
    expect(
      moved.state.canonical.relations["relation-compare-quotes-placement"].toNodeId,
    ).toBe(HOME_MOVE_IDS.budget);
  });

  it("retains retired records and source provenance after a compensating revision", () => {
    const compensated = createCompensatingRevisionFixture();
    const historicalNode = compensated.state.canonical.nodes[HOME_MOVE_IDS.compareQuotes];

    expect(historicalNode.retiredRevisionId).toBe(compensated.state.canonical.head.id);
    expect(historicalNode.sourceRefs).toContain(HOME_MOVE_IDS.source);
    expect(selectCurrentNodes(compensated.state).some((node) => node.id === historicalNode.id)).toBe(
      false,
    );
    expect(compensated.state.provenance.sourceToDeltaIds[HOME_MOVE_IDS.source]).toContain(
      "delta-compensate-remove-comparison",
    );
  });

  it("does not erase an adopted decision when accepting a conflicting idea", () => {
    const conflict = createAdoptedDecisionConflictFixture();
    const decision = conflict.state.canonical.nodes[HOME_MOVE_IDS.adoptedDecision];
    const relation = conflict.state.canonical.relations[
      "relation-first-quote-conflicts-three-quotes"
    ];

    expect(decision.governance?.standing).toBe("adopted");
    expect(decision.retiredRevisionId).toBeUndefined();
    expect(relation.kind).toBe("conflicts_with");
  });

  it("compiles an agent projection by explicit allow-list and denies private context by omission", () => {
    const projected = createPrivateProjectionFixture();
    const privateReceipt = projected.brief.omittedContext.find(
      (item) => item.nodeId === HOME_MOVE_IDS.privateConstraint,
    );
    const serializedPayload = JSON.stringify(projected.agentPayload);

    expect(privateReceipt?.reason).toBe("private");
    expect(projected.brief.sharedNodes.every((node) => node.visibility === "shared")).toBe(true);
    expect(serializedPayload).not.toContain(HOME_MOVE_IDS.privateConstraint);
    expect(serializedPayload).not.toContain("new address");
    expect(serializedPayload).not.toContain("omittedContext");
  });

  it("rejects a hand-crafted brief that bypasses the private-context compiler", () => {
    const projected = createPrivateProjectionFixture();
    const ledgerWithoutBrief: WorldstateLedger = {
      ...projected.ledger,
      events: projected.ledger.events.slice(0, -1),
    };
    const privateNode = projected.state.canonical.nodes[HOME_MOVE_IDS.privateConstraint];
    const unsafeBrief = {
      ...projected.brief,
      sharedNodes: [...projected.brief.sharedNodes, privateNode],
      omittedContext: projected.brief.omittedContext.filter(
        (item) => item.nodeId !== HOME_MOVE_IDS.privateConstraint,
      ),
    };

    expectKernelCode(
      () =>
        appendLedgerEvent(
          ledgerWithoutBrief,
          briefCompiledEvent({
            eventId: "event-unsafe-brief",
            commandId: "command-unsafe-brief",
            occurredAt: "2026-07-16T10:02:30.000Z",
            actor: HOME_MOVE_ACTORS.manager,
            payload: { brief: unsafeBrief },
          }),
        ),
      "scope_violation",
    );
  });
});

describe("worker and evidence truth", () => {
  it("rejects agent authorization of its own run", () => {
    const projected = createPrivateProjectionFixture();
    const event = runAuthorizedEvent({
      eventId: "event-agent-self-authorized",
      commandId: "command-agent-self-authorized",
      occurredAt: "2026-07-16T10:02:00.000Z",
      actor: HOME_MOVE_ACTORS.codex,
      payload: {
        run: {
          id: "run-agent-self-authorized",
          briefId: projected.brief.id,
          baseRevisionId: projected.brief.baseRevisionId,
          artifactBaseRef: projected.brief.artifactBaseRef,
          mode: "live",
        },
      },
    });

    expectKernelCode(
      () => appendLedgerEvent(projected.ledger, event),
      "authority_violation",
    );
  });

  it("rejects evidence validation whose envelope actor is not the named validator", () => {
    const validated = createLiveWorkerClosureFixture();
    const recorded = validated.ledger.events.at(-1);
    if (!recorded || recorded.type !== "evidence.validation_recorded") {
      throw new Error("Expected the live worker fixture to end in evidence validation.");
    }
    const ledger: WorldstateLedger = {
      ...validated.ledger,
      events: validated.ledger.events.slice(0, -1),
    };
    const event = evidenceValidationEvent({
      eventId: "event-mismatched-validator",
      commandId: "command-mismatched-validator",
      occurredAt: "2026-07-16T10:02:10.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: { validation: recorded.payload.validation },
    });

    expectKernelCode(() => appendLedgerEvent(ledger, event), "authority_violation");
  });

  it("rejects worker self-validation when no separate-validator role is declared", () => {
    const validated = createLiveWorkerClosureFixture();
    const recorded = validated.ledger.events.at(-1);
    if (!recorded || recorded.type !== "evidence.validation_recorded") {
      throw new Error("Expected the live worker fixture to end in evidence validation.");
    }
    const ledger: WorldstateLedger = {
      ...validated.ledger,
      events: validated.ledger.events.slice(0, -1),
    };
    const event = evidenceValidationEvent({
      eventId: "event-worker-self-validation",
      commandId: "command-worker-self-validation",
      occurredAt: "2026-07-16T10:02:11.000Z",
      actor: HOME_MOVE_ACTORS.codex,
      payload: {
        validation: {
          ...recorded.payload.validation,
          id: "validation-worker-self-validation",
          validator: HOME_MOVE_ACTORS.codex,
        },
      },
    });

    expectKernelCode(() => appendLedgerEvent(ledger, event), "authority_violation");
  });

  it("keeps returned, completed, and verified as independent claims", () => {
    const missing = createMissingEvidenceFixture();
    const task = missing.state.canonical.nodes[HOME_MOVE_IDS.compareQuotes];

    expect(missing.state.operational.runs[HOME_MOVE_IDS.run].status).toBe("returned");
    expect(missing.state.operational.closures[HOME_MOVE_IDS.closure].claimedCompletion).toBe(true);
    expect(task.work).toEqual({ phase: "planned", verification: "unverified" });
  });

  it("blocks integration when required evidence is missing", () => {
    const blocked = createBlockedIntegrationFixture();
    const gate = evaluateIntegrationGate(blocked.state, blocked.deltaId);

    expect(gate.allowed).toBe(false);
    expect(gate.verified).toBe(false);
    expect(gate.reasons).toContain("evidence_unmet:requirement-focused-tests");
    expectKernelCode(
      () => appendLedgerEvent(blocked.ledger, blocked.blockedAcceptedEvent),
      "evidence_gate_blocked",
    );
  });

  it("blocks completion claims that are not evidence-bound reconciliation", () => {
    const seeded = createHomeMoveSeedFixture();
    const delta: WorldstateDelta = {
      id: "delta-unwitnessed-completion",
      baseRevisionId: seeded.state.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "correction",
      proposedBy: HOME_MOVE_ACTORS.human,
      operations: [
        {
          op: "node.patch",
          nodeId: HOME_MOVE_IDS.goal,
          patch: { work: { phase: "completed" } },
        },
      ],
      rationale: ["Attempt to claim completion without a closure witness."],
      sourceRefs: [],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "The goal would be marked completed without evidence.",
    };
    const ledger = appendLedgerEvent(
      seeded.ledger,
      deltaProposedEvent({
        eventId: "event-unwitnessed-completion-proposed",
        commandId: "command-unwitnessed-completion-proposed",
        occurredAt: "2026-07-16T10:02:40.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta },
      }),
    ).ledger;
    const event = buildDeltaAcceptedEvent(reduceWorldstateLedger(ledger), {
      eventId: "event-unwitnessed-completion-accepted",
      commandId: "command-unwitnessed-completion-accepted",
      occurredAt: "2026-07-16T10:02:41.000Z",
      actor: HOME_MOVE_ACTORS.human,
      deltaId: delta.id,
    });

    expectKernelCode(() => appendLedgerEvent(ledger, event), "evidence_gate_blocked");
  });

  it("integrates an exact-revision result only after current evidence passes", () => {
    const live = createLiveWorkerClosureFixture();
    const integrated = createIntegratedResultFixture();
    const taskBefore = live.state.canonical.nodes[HOME_MOVE_IDS.compareQuotes];
    const taskAfter = integrated.state.canonical.nodes[HOME_MOVE_IDS.compareQuotes];

    expect(taskBefore.work).toEqual({ phase: "planned", verification: "unverified" });
    expect(taskAfter.work).toEqual({ phase: "completed", verification: "verified" });
    expect(integrated.state.canonical.nodes[HOME_MOVE_IDS.resultEvidence]).toBeDefined();
  });

  it("preserves replay identity and exposes stale closure drift", () => {
    const replay = createReplayClosureFixture();
    const stale = createStaleClosureFixture();

    expect(replay.state.operational.runs[HOME_MOVE_IDS.run].run.mode).toBe("replay");
    expect(replay.state.operational.closures[HOME_MOVE_IDS.closure].mode).toBe("replay");
    expect(stale.state.operational.closures[HOME_MOVE_IDS.closure].baseRevisionId).not.toBe(
      stale.state.canonical.head.id,
    );
  });

  it("does not allow artifact compatibility to be substituted for revision compatibility", () => {
    const blocked = createBlockedIntegrationFixture();
    const mismatched = {
      ...blocked.blockedAcceptedEvent,
      payload: {
        ...blocked.blockedAcceptedEvent.payload,
        artifactBaseRef: "git:different-base",
      },
    };
    // Missing evidence is already a hard gate; a passing-evidence event proves the
    // independent artifact check below.
    expectKernelCode(() => appendLedgerEvent(blocked.ledger, mismatched), "evidence_gate_blocked");

    const live = createLiveWorkerClosureFixture();
    const delta: WorldstateDelta = {
      id: "delta-artifact-drift-test",
      baseRevisionId: live.state.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "reconciliation",
      proposedBy: HOME_MOVE_ACTORS.manager,
      operations: [
        {
          op: "node.patch",
          nodeId: HOME_MOVE_IDS.compareQuotes,
          patch: { work: { phase: "completed" } },
        },
      ],
      rationale: ["Exercise artifact compatibility independently."],
      sourceRefs: [HOME_MOVE_IDS.source],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "The task is staged for completion.",
      closureRef: HOME_MOVE_IDS.closure,
    };
    const ledger = appendLedgerEvent(
      live.ledger,
      deltaProposedEvent({
        eventId: "event-artifact-drift-proposed",
        commandId: "command-artifact-drift-proposed",
        occurredAt: "2026-07-16T10:03:00.000Z",
        actor: HOME_MOVE_ACTORS.manager,
        payload: { delta },
      }),
    ).ledger;
    const state = reduceWorldstateLedger(ledger);
    const acceptedEvent = buildDeltaAcceptedEvent(state, {
      eventId: "event-artifact-drift-accept",
      commandId: "command-artifact-drift-accept",
      occurredAt: "2026-07-16T10:03:01.000Z",
      actor: HOME_MOVE_ACTORS.human,
      deltaId: delta.id,
      artifactBaseRef: "git:different-base",
    });
    expectKernelCode(() => appendLedgerEvent(ledger, acceptedEvent), "artifact_drift");
  });
});
