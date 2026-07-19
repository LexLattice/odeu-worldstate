import { describe, expect, it } from "vitest";

import {
  appendLedgerEvent,
  artifactPromotionAuthorizedEvent,
  artifactPromotionOutcomeRecordedEvent,
  artifactPromotionProposedEvent,
  briefCompiledEvent,
  buildDeltaAcceptedEvent,
  closureStagedEvent,
  deltaDispositionEvent,
  deltaProposedEvent,
  evidenceValidationEvent,
  evaluateIntegrationGate,
  fingerprint,
  KernelError,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  runLifecycleEvent,
  selectCurrentNodes,
  sourceCapturedEvent,
  type RunLifecycleStatus,
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

type PreUnknownRunStatus = "queued" | "received" | "working" | "blocked";
type PreUnknownLifecycleEventStatus = Exclude<
  RunLifecycleStatus,
  "queued" | "outcome_unknown" | "returned" | "failed" | "cancelled"
>;

const PRE_UNKNOWN_PATHS: Readonly<
  Record<PreUnknownRunStatus, readonly PreUnknownLifecycleEventStatus[]>
> = {
  queued: [],
  received: ["received"],
  working: ["received", "working"],
  blocked: ["received", "blocked"],
};

function ledgerWithRunStatus(status: PreUnknownRunStatus) {
  const projected = createPrivateProjectionFixture();
  const runId = `run-before-outcome-unknown-${status}`;
  let ledger = appendLedgerEvent(
    projected.ledger,
    runAuthorizedEvent({
      eventId: `event-authorize-${runId}`,
      commandId: `command-authorize-${runId}`,
      occurredAt: "2026-07-16T10:02:00.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        run: {
          id: runId,
          briefId: projected.brief.id,
          baseRevisionId: projected.brief.baseRevisionId,
          artifactBaseRef: projected.brief.artifactBaseRef,
          mode: "replay",
        },
      },
    }),
  ).ledger;

  for (const [index, lifecycleStatus] of PRE_UNKNOWN_PATHS[status].entries()) {
    ledger = appendLedgerEvent(
      ledger,
      runLifecycleEvent({
        eventId: `event-${runId}-${lifecycleStatus}`,
        commandId: `command-${runId}-${lifecycleStatus}`,
        occurredAt: `2026-07-16T10:02:0${index + 1}.000Z`,
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          runId,
          status: lifecycleStatus,
          evidenceRefs: [],
        },
      }),
    ).ledger;
  }

  return { ledger, projected, runId };
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

function integratedLivePromotionFixture() {
  const live = createLiveWorkerClosureFixture();
  const delta: WorldstateDelta = {
    id: "delta-live-promotion-reconciliation",
    baseRevisionId: live.state.canonical.head.id,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "reconciliation",
    proposedBy: HOME_MOVE_ACTORS.manager,
    operations: [
      {
        op: "node.patch",
        nodeId: HOME_MOVE_IDS.compareQuotes,
        patch: {
          knowledge: { standing: "supported", freshness: "current" },
          work: { phase: "completed", verification: "verified" },
        },
      },
    ],
    rationale: ["Integrate the independently validated live result semantically."],
    sourceRefs: ["source-evidence-validation-live"],
    uncertainty: [],
    alternatives: [],
    conflicts: [],
    visibleConsequence: "The live result becomes semantic worldstate truth.",
    closureRef: HOME_MOVE_IDS.closure,
    validationRef: "validation-moving-tool-live",
  };
  let ledger = appendLedgerEvent(
    live.ledger,
    deltaProposedEvent({
      eventId: "event-live-promotion-reconciliation-proposed",
      commandId: "command-live-promotion-reconciliation-proposed",
      occurredAt: "2026-07-18T10:00:00.000Z",
      actor: HOME_MOVE_ACTORS.manager,
      payload: { delta },
    }),
  ).ledger;
  ledger = appendLedgerEvent(
    ledger,
    buildDeltaAcceptedEvent(reduceWorldstateLedger(ledger), {
      eventId: "event-live-promotion-reconciliation-accepted",
      commandId: "command-live-promotion-reconciliation-accepted",
      occurredAt: "2026-07-18T10:00:01.000Z",
      actor: HOME_MOVE_ACTORS.human,
      deltaId: delta.id,
      artifactBaseRef: live.brief.artifactBaseRef,
    }),
  ).ledger;
  const integrated = reduceWorldstateLedger(ledger);
  const candidateArtifact = {
    kind: "odeu.artifact-candidate",
    version: 1,
    candidateId: `artifact-candidate:sha256:${"b".repeat(64)}`,
    candidateCommit: "c".repeat(40),
  };
  const candidateSourceId = "source-live-artifact-candidate";
  ledger = appendLedgerEvent(
    ledger,
    sourceCapturedEvent({
      eventId: "event-live-artifact-candidate",
      commandId: "command-live-artifact-candidate",
      occurredAt: "2026-07-18T10:00:02.000Z",
      actor: HOME_MOVE_ACTORS.system,
      payload: {
        source: {
          id: candidateSourceId,
          kind: "system",
          content: JSON.stringify(candidateArtifact),
          visibility: "shared",
          integrity: {
            algorithm: "fnv1a64",
            digest: fingerprint(candidateArtifact),
          },
        },
      },
    }),
  ).ledger;
  const proposal = {
    id: "promotion-live-result",
    runId: HOME_MOVE_IDS.run,
    briefId: HOME_MOVE_IDS.brief,
    closureId: HOME_MOVE_IDS.closure,
    validationId: "validation-moving-tool-live",
    reconciliationDeltaId: delta.id,
    integratedRevisionId: integrated.canonical.head.id,
    artifactBaseRef: live.brief.artifactBaseRef,
    repositoryId: "home-move-demo",
    targetRef: "refs/heads/odeu-authoritative-demo",
    expectedBaseCommit: "a".repeat(40),
    candidateId: `artifact-candidate:sha256:${"b".repeat(64)}`,
    candidateCommit: "c".repeat(40),
    candidateTree: "d".repeat(40),
    manifestDigest: `sha256:${"e".repeat(64)}`,
    patchDigest: `sha256:${"f".repeat(64)}`,
    changedPaths: [
      { path: "demo/moving-costs.html", status: "modified" as const },
    ],
    candidateEvidenceSourceId: candidateSourceId,
    proposalSourceId: candidateSourceId,
  };
  ledger = appendLedgerEvent(
    ledger,
    artifactPromotionProposedEvent({
      eventId: "event-live-artifact-promotion-proposed",
      commandId: "command-live-artifact-promotion-proposed",
      occurredAt: "2026-07-18T10:00:03.000Z",
      actor: HOME_MOVE_ACTORS.manager,
      payload: { proposal },
    }),
  ).ledger;
  return { ledger, proposal, semanticHead: integrated.canonical.head.id };
}

describe("authoritative artifact promotion", () => {
  it("keeps proposal, human authority, and exact target-ref outcome operational", () => {
    const fixture = integratedLivePromotionFixture();
    const requestArtifact = {
      kind: "odeu.artifact-promotion-request",
      version: 1,
      promotionId: fixture.proposal.id,
      candidateId: fixture.proposal.candidateId,
    };
    const requestSourceId = "source-live-artifact-promotion-request";
    let ledger = appendLedgerEvent(
      fixture.ledger,
      sourceCapturedEvent({
        eventId: "event-live-artifact-promotion-request",
        commandId: "command-live-artifact-promotion-request",
        occurredAt: "2026-07-18T10:00:04.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          source: {
            id: requestSourceId,
            kind: "system",
            content: JSON.stringify(requestArtifact),
            visibility: "shared",
            integrity: {
              algorithm: "fnv1a64",
              digest: fingerprint(requestArtifact),
            },
          },
        },
      }),
    ).ledger;
    ledger = appendLedgerEvent(
      ledger,
      artifactPromotionAuthorizedEvent({
        eventId: "event-live-artifact-promotion-authorized",
        commandId: "command-live-artifact-promotion-authorized",
        occurredAt: "2026-07-18T10:00:05.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: {
          promotionId: fixture.proposal.id,
          integratedRevisionId: fixture.semanticHead,
          requestSourceId,
        },
      }),
    ).ledger;
    const competingDelta: WorldstateDelta = {
      id: "delta-while-artifact-promotion-unresolved",
      baseRevisionId: fixture.semanticHead,
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
      rationale: [
        "Exercise the semantic-head reservation held by promotion authority.",
      ],
      sourceRefs: [],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence:
        "A concurrent semantic commit must wait for the promotion outcome.",
    };
    const competingLedger = appendLedgerEvent(
      ledger,
      deltaProposedEvent({
        eventId: "event-delta-while-artifact-promotion-unresolved",
        commandId: "command-delta-while-artifact-promotion-unresolved",
        occurredAt: "2026-07-18T10:00:05.500Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta: competingDelta },
      }),
    ).ledger;
    expectKernelCode(
      () =>
        appendLedgerEvent(
          competingLedger,
          buildDeltaAcceptedEvent(reduceWorldstateLedger(competingLedger), {
            eventId: "event-accept-while-artifact-promotion-unresolved",
            commandId: "command-accept-while-artifact-promotion-unresolved",
            occurredAt: "2026-07-18T10:00:05.750Z",
            actor: HOME_MOVE_ACTORS.human,
            deltaId: competingDelta.id,
          }),
        ),
      "revision_conflict",
    );
    const responseArtifact = {
      kind: "odeu.artifact-promotion-response",
      version: 1,
      outcome: "promoted",
      promotionId: fixture.proposal.id,
    };
    const responseSourceId = "source-live-artifact-promotion-response";
    ledger = appendLedgerEvent(
      ledger,
      sourceCapturedEvent({
        eventId: "event-live-artifact-promotion-response",
        commandId: "command-live-artifact-promotion-response",
        occurredAt: "2026-07-18T10:00:06.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          source: {
            id: responseSourceId,
            kind: "system",
            content: JSON.stringify(responseArtifact),
            visibility: "shared",
            integrity: {
              algorithm: "fnv1a64",
              digest: fingerprint(responseArtifact),
            },
          },
        },
      }),
    ).ledger;
    ledger = appendLedgerEvent(
      ledger,
      artifactPromotionOutcomeRecordedEvent({
        eventId: "event-live-artifact-promotion-recorded",
        commandId: "command-live-artifact-promotion-recorded",
        occurredAt: "2026-07-18T10:00:07.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          outcome: {
            promotionId: fixture.proposal.id,
            outcome: "promoted",
            repositoryId: fixture.proposal.repositoryId,
            targetRef: fixture.proposal.targetRef,
            expectedBaseCommit: fixture.proposal.expectedBaseCommit,
            candidateCommit: fixture.proposal.candidateCommit,
            observedTargetCommit: fixture.proposal.candidateCommit,
            responseSourceId,
          },
        },
      }),
    ).ledger;
    const state = reduceWorldstateLedger(ledger);

    expect(state.canonical.head.id).toBe(fixture.semanticHead);
    expect(state.operational.artifactPromotions[fixture.proposal.id]).toMatchObject({
      status: "promoted",
      latestOutcome: {
        observedTargetCommit: fixture.proposal.candidateCommit,
      },
    });
  });

  it("rejects non-human promotion authority", () => {
    const fixture = integratedLivePromotionFixture();
    const requestArtifact = { promotionId: fixture.proposal.id };
    const requestSourceId = "source-non-human-promotion-request";
    const ledger = appendLedgerEvent(
      fixture.ledger,
      sourceCapturedEvent({
        eventId: "event-non-human-promotion-request",
        commandId: "command-non-human-promotion-request",
        occurredAt: "2026-07-18T10:01:00.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          source: {
            id: requestSourceId,
            kind: "system",
            content: JSON.stringify(requestArtifact),
            visibility: "shared",
            integrity: {
              algorithm: "fnv1a64",
              digest: fingerprint(requestArtifact),
            },
          },
        },
      }),
    ).ledger;

    expectKernelCode(
      () =>
        appendLedgerEvent(
          ledger,
          artifactPromotionAuthorizedEvent({
            eventId: "event-non-human-promotion-authorized",
            commandId: "command-non-human-promotion-authorized",
            occurredAt: "2026-07-18T10:01:01.000Z",
            actor: HOME_MOVE_ACTORS.manager,
            payload: {
              promotionId: fixture.proposal.id,
              integratedRevisionId: fixture.semanticHead,
              requestSourceId,
            },
          }),
        ),
      "authority_violation",
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
    expect(projected.agentPayload.unknowns).toEqual([
      "Recurring storage costs may need a separate comparison.",
    ]);
    expect(projected.agentPayload.expectedArtifacts).toEqual([
      "demo/moving-costs.html",
    ]);
    expect(
      projected.agentPayload.evidenceContract.requirements.map(
        (requirement) => requirement.command,
      ),
    ).toEqual(["npm test -- moving-cost", null]);
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

  it("rejects a hand-crafted brief whose profile differs from its accepted target", () => {
    const projected = createPrivateProjectionFixture();
    const ledgerWithoutBrief: WorldstateLedger = {
      ...projected.ledger,
      events: projected.ledger.events.slice(0, -1),
    };

    expectKernelCode(
      () =>
        appendLedgerEvent(
          ledgerWithoutBrief,
          briefCompiledEvent({
            eventId: "event-mismatched-profile-brief",
            commandId: "command-mismatched-profile-brief",
            occurredAt: "2026-07-16T10:02:31.000Z",
            actor: HOME_MOVE_ACTORS.manager,
            payload: {
              brief: {
                ...projected.brief,
                delegationProfileId: null,
              },
            },
          }),
        ),
      "scope_violation",
    );
  });

  it("rejects a hand-crafted brief that widens a registered profile contract", () => {
    const projected = createPrivateProjectionFixture();
    const ledgerWithoutBrief: WorldstateLedger = {
      ...projected.ledger,
      events: projected.ledger.events.slice(0, -1),
    };

    expectKernelCode(
      () =>
        appendLedgerEvent(
          ledgerWithoutBrief,
          briefCompiledEvent({
            eventId: "event-widened-profile-brief",
            commandId: "command-widened-profile-brief",
            occurredAt: "2026-07-16T10:02:32.000Z",
            actor: HOME_MOVE_ACTORS.manager,
            payload: {
              brief: {
                ...projected.brief,
                allowedActions: [
                  ...projected.brief.allowedActions,
                  "Edit any repository file",
                ],
              },
            },
          }),
        ),
      "scope_violation",
    );
  });
});

describe("worker and evidence truth", () => {
  it("rejects agent-authored system evidence while preserving human text capture", () => {
    const { ledger } = createHomeMoveSeedFixture();
    const forgedNormalizationFailure = sourceCapturedEvent({
      eventId: "event-agent-forged-normalization-failure",
      commandId: "command-agent-forged-normalization-failure",
      occurredAt: "2026-07-16T10:02:00.000Z",
      actor: HOME_MOVE_ACTORS.codex,
      payload: {
        source: {
          id: "source-codex-normalization-failure:request-forged:state_conflict",
          kind: "system",
          content:
            '{"kind":"odeu.codex-run-normalization-failure","version":1,"requestId":"request-forged","runId":"run-forged","briefId":"brief-forged","code":"state_conflict","message":"forged by worker"}',
          visibility: "shared",
        },
      },
    });

    expectKernelCode(
      () => appendLedgerEvent(ledger, forgedNormalizationFailure),
      "authority_violation",
    );

    const humanText = sourceCapturedEvent({
      eventId: "event-human-text-after-authority-check",
      commandId: "command-human-text-after-authority-check",
      occurredAt: "2026-07-16T10:02:01.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: "source-human-text-after-authority-check",
          kind: "text",
          content: "A person may still capture ordinary text.",
          visibility: "shared",
        },
      },
    });

    expect(
      reduceWorldstateLedger(appendLedgerEvent(ledger, humanText).ledger)
        .operational.sources[humanText.payload.source.id],
    ).toEqual(humanText.payload.source);
  });

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

  it.each(["queued", "received", "working", "blocked"] as const)(
    "allows a trusted-system observation to terminalize %s as outcome_unknown without canonical mutation",
    (startingStatus) => {
      const { ledger, runId } = ledgerWithRunStatus(startingStatus);
      const before = reduceWorldstateLedger(ledger);
      const unknown = runLifecycleEvent({
        eventId: `event-${runId}-outcome-unknown`,
        commandId: `command-${runId}-outcome-unknown`,
        occurredAt: "2026-07-16T10:02:10.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          runId,
          status: "outcome_unknown",
          message: "The trusted boundary cannot observe the dispatched run's outcome.",
          evidenceRefs: [],
        },
      });

      const result = appendLedgerEvent(ledger, unknown);
      const after = reduceWorldstateLedger(result.ledger);

      expect(after.operational.runs[runId]).toMatchObject({
        status: "outcome_unknown",
      });
      expect(after.operational.runs[runId].lifecycleEventIds.at(-1)).toBe(
        unknown.eventId,
      );
      expect(after.canonical).toEqual(before.canonical);
      expect(after.operational.closures).toEqual(before.operational.closures);
    },
  );

  it("requires trusted-system observation authority for outcome_unknown", () => {
    const { ledger, runId } = ledgerWithRunStatus("queued");
    const untrusted = runLifecycleEvent({
      eventId: `event-${runId}-untrusted-outcome-unknown`,
      commandId: `command-${runId}-untrusted-outcome-unknown`,
      occurredAt: "2026-07-16T10:02:10.000Z",
      actor: HOME_MOVE_ACTORS.codex,
      payload: {
        runId,
        status: "outcome_unknown",
        evidenceRefs: [],
      },
    });

    expectKernelCode(
      () => appendLedgerEvent(ledger, untrusted),
      "authority_violation",
    );
  });

  it("makes outcome_unknown terminal and refuses every closure witness", () => {
    const { ledger, projected, runId } = ledgerWithRunStatus("working");
    const unknownLedger = appendLedgerEvent(
      ledger,
      runLifecycleEvent({
        eventId: `event-${runId}-outcome-unknown`,
        commandId: `command-${runId}-outcome-unknown`,
        occurredAt: "2026-07-16T10:02:10.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          runId,
          status: "outcome_unknown",
          evidenceRefs: [],
        },
      }),
    ).ledger;

    for (const nextStatus of [
      "received",
      "working",
      "blocked",
      "outcome_unknown",
      "returned",
      "failed",
      "cancelled",
    ] as const) {
      expectKernelCode(
        () =>
          appendLedgerEvent(
            unknownLedger,
            runLifecycleEvent({
              eventId: `event-${runId}-${nextStatus}-after-unknown`,
              commandId: `command-${runId}-${nextStatus}-after-unknown`,
              occurredAt: "2026-07-16T10:02:11.000Z",
              actor: HOME_MOVE_ACTORS.system,
              payload: { runId, status: nextStatus, evidenceRefs: [] },
            }),
          ),
        "lifecycle_conflict",
      );
    }

    for (const outcome of ["returned", "failed", "cancelled"] as const) {
      expectKernelCode(
        () =>
          appendLedgerEvent(
            unknownLedger,
            closureStagedEvent({
              eventId: `event-${runId}-${outcome}-closure-after-unknown`,
              commandId: `command-${runId}-${outcome}-closure-after-unknown`,
              occurredAt: "2026-07-16T10:02:11.000Z",
              actor: HOME_MOVE_ACTORS.system,
              payload: {
                closure: {
                  id: `closure-${runId}-${outcome}`,
                  runId,
                  briefId: projected.brief.id,
                  baseRevisionId: projected.brief.baseRevisionId,
                  artifactBaseRef: projected.brief.artifactBaseRef,
                  artifactCandidateId: null,
                  artifactCandidateCommit: null,
                  mode: "replay",
                  outcome,
                  claimedCompletion: false,
                  summary: "No closure is lawful for an unknown outcome.",
                  changes: [],
                  artifactRefs: [],
                  evidenceRefs: [],
                  failures: [],
                  unresolved: [],
                },
              },
            }),
          ),
        "lifecycle_conflict",
      );
    }

    expect(reduceWorldstateLedger(unknownLedger).operational).toMatchObject({
      runs: { [runId]: { status: "outcome_unknown" } },
      closures: {},
    });
  });

  it("requires the trusted orchestration boundary to record worker lifecycle and closure claims", () => {
    const returned = createLiveWorkerClosureFixture();
    const lifecycle = returned.ledger.events.find(
      (event) =>
        event.type === "run.lifecycle_recorded" &&
        event.payload.status === "received",
    );
    if (!lifecycle || lifecycle.type !== "run.lifecycle_recorded") {
      throw new Error("Expected a recorded lifecycle event.");
    }
    const beforeLifecycle: WorldstateLedger = {
      ...returned.ledger,
      events: returned.ledger.events.slice(
        0,
        returned.ledger.events.findIndex((event) => event.eventId === lifecycle.eventId),
      ),
    };
    expectKernelCode(
      () =>
        appendLedgerEvent(beforeLifecycle, {
          ...lifecycle,
          eventId: "event-agent-recorded-lifecycle",
          commandId: "command-agent-recorded-lifecycle",
          actor: HOME_MOVE_ACTORS.codex,
        }),
      "authority_violation",
    );

    const closure = returned.ledger.events.find(
      (event) => event.type === "closure.staged",
    );
    if (!closure || closure.type !== "closure.staged") {
      throw new Error("Expected a staged closure event.");
    }
    const beforeClosure: WorldstateLedger = {
      ...returned.ledger,
      events: returned.ledger.events.slice(
        0,
        returned.ledger.events.findIndex((event) => event.eventId === closure.eventId),
      ),
    };
    expectKernelCode(
      () =>
        appendLedgerEvent(beforeClosure, {
          ...closure,
          eventId: "event-agent-recorded-closure",
          commandId: "command-agent-recorded-closure",
          actor: HOME_MOVE_ACTORS.codex,
        }),
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

  it("grounds validation in an existing shared integrity-bound system source", () => {
    const validated = createLiveWorkerClosureFixture();
    const recorded = validated.ledger.events.at(-1);
    if (!recorded || recorded.type !== "evidence.validation_recorded") {
      throw new Error("Expected the live worker fixture to end in evidence validation.");
    }

    const source = validated.state.operational.sources[
      recorded.payload.validation.evidenceSourceId
    ];
    expect(source).toMatchObject({
      kind: "system",
      visibility: "shared",
      integrity: {
        algorithm: "fnv1a64",
        digest: expect.stringMatching(/^fnv1a64:[0-9a-f]{16}$/),
      },
    });
    expect(source?.integrity?.digest).toBe(
      fingerprint(JSON.parse(source?.content ?? "")),
    );
    expect(
      recorded.payload.validation.observations.every((observation) =>
        observation.evidenceRefs.includes(recorded.payload.validation.evidenceSourceId),
      ),
    ).toBe(true);
  });

  it("rejects missing or untrusted validation evidence sources", () => {
    const validated = createLiveWorkerClosureFixture();
    const recorded = validated.ledger.events.at(-1);
    if (!recorded || recorded.type !== "evidence.validation_recorded") {
      throw new Error("Expected the live worker fixture to end in evidence validation.");
    }
    const sourceIndex = validated.ledger.events.findIndex(
      (event) =>
        event.type === "source.captured" &&
        event.payload.source.id === recorded.payload.validation.evidenceSourceId,
    );
    if (sourceIndex < 0) {
      throw new Error("Expected the fixture validation evidence source.");
    }
    const beforeEvidence: WorldstateLedger = {
      ...validated.ledger,
      events: validated.ledger.events.slice(0, sourceIndex),
    };

    const validationEvent = (evidenceSourceId: string, suffix: string) =>
      evidenceValidationEvent({
        ...recorded,
        eventId: `event-validation-${suffix}`,
        commandId: `command-validation-${suffix}`,
        payload: {
          validation: {
            ...recorded.payload.validation,
            id: `validation-${suffix}`,
            evidenceSourceId,
          },
        },
      });

    expectKernelCode(
      () =>
        appendLedgerEvent(
          beforeEvidence,
          validationEvent("source-validation-missing", "missing-source"),
        ),
      "reference_missing",
    );

    const invalidSources = [
      {
        id: "source-validation-human-text",
        actor: HOME_MOVE_ACTORS.human,
        source: {
          id: "source-validation-human-text",
          kind: "text" as const,
          content: "A human note is not system validation evidence.",
          visibility: "shared" as const,
          integrity: { algorithm: "fnv1a64", digest: "fnv1a64:0000000000000000" },
        },
      },
      {
        id: "source-validation-private-system",
        actor: HOME_MOVE_ACTORS.system,
        source: {
          id: "source-validation-private-system",
          kind: "system" as const,
          content: "Private system evidence cannot ground a shared validation.",
          visibility: "private" as const,
          integrity: { algorithm: "fnv1a64", digest: "fnv1a64:0000000000000000" },
        },
      },
      {
        id: "source-validation-without-integrity",
        actor: HOME_MOVE_ACTORS.system,
        source: {
          id: "source-validation-without-integrity",
          kind: "system" as const,
          content: "System evidence without integrity metadata is insufficient.",
          visibility: "shared" as const,
        },
      },
      {
        id: "source-validation-wrong-algorithm",
        actor: HOME_MOVE_ACTORS.system,
        source: {
          id: "source-validation-wrong-algorithm",
          kind: "system" as const,
          content: '{"kind":"independent-validation","passed":true}',
          visibility: "shared" as const,
          integrity: { algorithm: "sha256", digest: "sha256:not-a-semantic-fnv" },
        },
      },
      {
        id: "source-validation-malformed-json",
        actor: HOME_MOVE_ACTORS.system,
        source: {
          id: "source-validation-malformed-json",
          kind: "system" as const,
          content: "not-json",
          visibility: "shared" as const,
          integrity: { algorithm: "fnv1a64", digest: "fnv1a64:0000000000000000" },
        },
      },
      {
        id: "source-validation-digest-mismatch",
        actor: HOME_MOVE_ACTORS.system,
        source: {
          id: "source-validation-digest-mismatch",
          kind: "system" as const,
          content: '{"kind":"independent-validation","passed":true}',
          visibility: "shared" as const,
          integrity: { algorithm: "fnv1a64", digest: "fnv1a64:0000000000000000" },
        },
      },
    ];

    for (const [index, invalid] of invalidSources.entries()) {
      const ledger = appendLedgerEvent(
        beforeEvidence,
        sourceCapturedEvent({
          eventId: `event-${invalid.id}`,
          commandId: `command-${invalid.id}`,
          occurredAt: `2026-07-16T10:02:${20 + index}.000Z`,
          actor: invalid.actor,
          payload: { source: invalid.source },
        }),
      ).ledger;
      expectKernelCode(
        () =>
          appendLedgerEvent(
            ledger,
            validationEvent(invalid.id, `untrusted-${index}`),
          ),
        "evidence_gate_blocked",
      );
    }
  });

  it("rejects a replayed validation whose grounding source content was tampered", () => {
    const validated = createLiveWorkerClosureFixture();
    const recorded = validated.ledger.events.at(-1);
    if (!recorded || recorded.type !== "evidence.validation_recorded") {
      throw new Error("Expected the live worker fixture to end in evidence validation.");
    }
    const sourceIndex = validated.ledger.events.findIndex(
      (event) =>
        event.type === "source.captured" &&
        event.payload.source.id === recorded.payload.validation.evidenceSourceId,
    );
    if (sourceIndex < 0) throw new Error("Expected validation grounding evidence.");
    const sourceEvent = validated.ledger.events[sourceIndex];
    if (sourceEvent.type !== "source.captured") {
      throw new Error("Expected a captured validation source.");
    }
    const tampered: WorldstateLedger = {
      ...validated.ledger,
      events: validated.ledger.events.map((event, index) =>
        index === sourceIndex
          ? {
              ...sourceEvent,
              payload: {
                source: {
                  ...sourceEvent.payload.source,
                  content: sourceEvent.payload.source.content.replace(
                    '"version":1',
                    '"version":2',
                  ),
                },
              },
            }
          : event,
      ),
    };

    expectKernelCode(
      () => reduceWorldstateLedger(tampered),
      "evidence_gate_blocked",
    );
  });

  it("requires every validation observation to cite its exact grounding source", () => {
    const validated = createLiveWorkerClosureFixture();
    const recorded = validated.ledger.events.at(-1);
    if (!recorded || recorded.type !== "evidence.validation_recorded") {
      throw new Error("Expected the live worker fixture to end in evidence validation.");
    }
    const withoutValidation: WorldstateLedger = {
      ...validated.ledger,
      events: validated.ledger.events.slice(0, -1),
    };
    const ungrounded = evidenceValidationEvent({
      ...recorded,
      eventId: "event-validation-ungrounded-observation",
      commandId: "command-validation-ungrounded-observation",
      payload: {
        validation: {
          ...recorded.payload.validation,
          id: "validation-ungrounded-observation",
          observations: recorded.payload.validation.observations.map(
            (observation, index) =>
              index === 0
                ? {
                    ...observation,
                    result: "failed",
                    evidenceRefs: observation.evidenceRefs.filter(
                      (reference) =>
                        reference !== recorded.payload.validation.evidenceSourceId,
                    ),
                  }
                : observation,
          ),
        },
      },
    });

    expectKernelCode(
      () => appendLedgerEvent(withoutValidation, ungrounded),
      "evidence_gate_blocked",
    );
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
      sourceRefs: [HOME_MOVE_IDS.source, "source-evidence-validation-live"],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "The task is staged for completion.",
      closureRef: HOME_MOVE_IDS.closure,
      validationRef: "validation-moving-tool-live",
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
