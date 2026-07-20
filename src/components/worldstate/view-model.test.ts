import { describe, expect, it } from "vitest";

import { runCodexReplay } from "@/adapters/codex/replay";
import { HOME_MOVE_REPLAY_IDENTITY } from "@/adapters/replay-evidence";
import { authorizedCodexRunRequest } from "@/integration/authorized-codex-run";
import {
  invalidJsonPlacementResponse,
  placeSource,
  PlacementErrorResponseSchema,
  PlacementSuccessResponseSchema,
  type PlacementResponse,
  type PlacementSuccessResponse,
} from "@/adapters/manager";
import {
  appendLedgerEvent,
  buildDeltaAcceptedEvent,
  createLedgerEvent,
  deltaDispositionEvent,
  deltaProposedEvent,
  fingerprint,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  runLifecycleEvent,
  sourceCapturedEvent,
  type AgentRun,
  type WorldstateDelta,
  type WorldstateLedger,
} from "@/domain";
import {
  createHomeMoveSeedFixture,
  createPrivateProjectionFixture,
  createReplayClosureFixture,
  createStaleClosureFixture,
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
} from "@/fixtures/home-move";
import {
  placementAttemptSourceEvent,
  placementExchangeSourceEvent,
  placementExchangeSourceId,
} from "@/integration/placement-evidence";
import {
  codexRunAttemptSourceEvent,
  codexRunExchangeSourceEvent,
  codexRunNormalizationFailureSourceEvent,
  codexRunResponseEvents,
} from "@/integration/codex-run-evidence";
import { codexTransportObservationSourceEvent } from "@/integration/codex-transport-evidence";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";
import { placementResponseToKernelDelta } from "@/integration/placement-to-kernel";
import { compilePlacementRequest } from "@/integration/worldstate-to-placement";

import { buildWorkbenchViewModel } from "./view-model";

const SOURCE_ID = "source-workbench-view-model";
const SOURCE_TEXT = "Compare our moving provider quotes.";
const SOURCE_TIME = "2026-07-17T10:00:00.000Z";
const ATTEMPT_TIME = "2026-07-17T10:00:00.500Z";
const EXCHANGE_TIME = "2026-07-17T10:00:01.000Z";
const PROPOSAL_TIME = "2026-07-17T10:00:02.000Z";
const ACCEPT_TIME = "2026-07-17T10:00:03.000Z";

function append(ledger: WorldstateLedger, event: Parameters<typeof appendLedgerEvent>[1]) {
  return appendLedgerEvent(ledger, event).ledger;
}

function durablePlacementAttempt() {
  let { ledger } = createHomeMoveSeedFixture();
  ledger = append(
    ledger,
    sourceCapturedEvent({
      eventId: "event-workbench-source",
      commandId: "command-workbench-source",
      occurredAt: SOURCE_TIME,
      actor: HOME_MOVE_ACTORS.human,
      payload: {
        source: {
          id: SOURCE_ID,
          kind: "text",
          content: SOURCE_TEXT,
          visibility: "shared",
        },
      },
    }),
  );

  const sourceState = reduceWorldstateLedger(ledger);
  const request = compilePlacementRequest({
    state: sourceState,
    sourceId: SOURCE_ID,
    requestId: "request-workbench-view-model",
    scopeId: HOME_MOVE_IDS.project,
    projectId: HOME_MOVE_IDS.projectNode,
    selectedNodeId: HOME_MOVE_IDS.budget,
  });
  ledger = append(
    ledger,
    placementAttemptSourceEvent({
      request,
      eventId: "event-workbench-attempt",
      commandId: "command-workbench-attempt",
      occurredAt: ATTEMPT_TIME,
      actor: HOME_MOVE_ACTORS.system,
    }),
  );

  return { ledger, request };
}

async function placementAttempt(
  transformResponse: (
    response: PlacementSuccessResponse,
  ) => PlacementResponse = (response) => response,
) {
  const durableAttempt = durablePlacementAttempt();
  let { ledger } = durableAttempt;
  const { request } = durableAttempt;
  const gatewayResult = await placeSource(request, {
    environment: { ODEU_MANAGER_MODE: "fixture" },
  });
  if (!gatewayResult.body.ok) throw new Error("Expected fixture placement success.");
  const response = transformResponse(gatewayResult.body);
  ledger = append(
    ledger,
    placementExchangeSourceEvent({
      request,
      response,
      eventId: "event-workbench-exchange",
      commandId: "command-workbench-exchange",
      occurredAt: EXCHANGE_TIME,
      actor: HOME_MOVE_ACTORS.system,
    }),
  );

  let kernelDelta: WorldstateDelta | null = null;
  if (response.ok && response.delta) {
    kernelDelta = placementResponseToKernelDelta(response, {
      evidenceSourceId: placementExchangeSourceId(request.requestId),
    });
    if (!kernelDelta) throw new Error("Expected a placement delta.");
    ledger = append(
      ledger,
      deltaProposedEvent({
        eventId: "event-workbench-proposal",
        commandId: "command-workbench-proposal",
        occurredAt: PROPOSAL_TIME,
        actor: HOME_MOVE_ACTORS.manager,
        payload: { delta: kernelDelta },
      }),
    );
  }

  return {
    ledger,
    state: reduceWorldstateLedger(ledger),
    request,
    response,
    kernelDelta,
  };
}

describe("buildWorkbenchViewModel", () => {
  it("projects the seed ledger as stable, shared-only canonical truth", () => {
    const seed = createHomeMoveSeedFixture();
    const model = buildWorkbenchViewModel({
      ledger: seed.ledger,
      state: seed.state,
      runtimeFallback: { mode: "fixture", label: "Configured fixture manager" },
    });

    expect(model).toMatchObject({
      project: "Plan our home move",
      projectId: HOME_MOVE_IDS.project,
      projectNodeId: HOME_MOVE_IDS.projectNode,
      revision: `Revision ${seed.state.canonical.head.number} · ${seed.state.canonical.head.id}`,
      placement: {
        state: "idle",
        canAccept: false,
      },
      runtime: { mode: "fixture", label: "Configured fixture manager" },
      work: {
        state: "ineligible",
        available: false,
        reason: "Adopt a placement before preparing a bounded agent brief.",
      },
    });
    expect(model.nodes).toHaveLength(8);
    expect(model.relations).toHaveLength(7);
    expect(model.nodes.some((node) => node.id === HOME_MOVE_IDS.privateConstraint)).toBe(
      false,
    );
    expect(
      model.relations.some(
        (relation) =>
          relation.source === HOME_MOVE_IDS.privateConstraint ||
          relation.target === HOME_MOVE_IDS.privateConstraint,
      ),
    ).toBe(false);
    expect(model.nodes.map((node) => node.id)).toEqual(
      [...model.nodes.map((node) => node.id)].sort(),
    );
    expect(
      model.nodes.find((node) => node.id === HOME_MOVE_IDS.budget)?.parentId,
    ).toBe(HOME_MOVE_IDS.projectNode);
  });

  it("surfaces a durable placement attempt without an exchange as retryable evidence", () => {
    const attempt = durablePlacementAttempt();
    const state = reduceWorldstateLedger(attempt.ledger);
    const model = buildWorkbenchViewModel({
      ledger: attempt.ledger,
      state,
      runtimeFallback: { mode: "fixture", label: "Configured fixture manager" },
    });

    expect(model.placement).toMatchObject({
      state: "failed",
      sourceId: SOURCE_ID,
      sourceText: SOURCE_TEXT,
      sourceCapturedAt: SOURCE_TIME,
      requestId: attempt.request.requestId,
      requestSelectedNodeId: HOME_MOVE_IDS.budget,
      attemptId: expect.any(String),
      baseRevisionId: attempt.request.baseRevisionId,
      errorCode: "placement_incomplete",
      errorMessage: "The persisted placement request has no matching manager exchange.",
      retryable: true,
      canAccept: false,
    });
    expect(model.placement.gateReason).toContain("can be retried");
    expect(model.events.find((event) => event.id === "event-workbench-attempt")).toEqual({
      id: "event-workbench-attempt",
      kind: "evidence",
      label: "Placement request persisted",
      detail:
        "Request request-workbench-view-model was durably recorded before manager dispatch.",
      time: ATTEMPT_TIME,
      worldstateId: HOME_MOVE_IDS.budget,
    });
  });

  it("overlays a persisted pending placement as Suggested without advancing the head", async () => {
    const attempt = await placementAttempt();
    const model = buildWorkbenchViewModel({
      ledger: attempt.ledger,
      state: attempt.state,
    });
    if (!attempt.response.ok || !attempt.response.delta) {
      throw new Error("Expected reviewable response.");
    }
    const candidateId = attempt.response.receipt.proposed.nodeId;
    const candidate = model.nodes.find((node) => node.id === candidateId);

    expect(model.revision).toBe(
      `Revision ${attempt.state.canonical.head.number} · ${attempt.state.canonical.head.id}`,
    );
    expect(attempt.state.canonical.head.id).toBe(attempt.request.baseRevisionId);
    expect(model.placement).toMatchObject({
      state: "reviewable",
      sourceId: SOURCE_ID,
      sourceText: SOURCE_TEXT,
      sourceCapturedAt: SOURCE_TIME,
      requestId: attempt.request.requestId,
      requestSelectedNodeId: HOME_MOVE_IDS.budget,
      attemptId: expect.any(String),
      baseRevisionId: attempt.request.baseRevisionId,
      deltaId: attempt.response.delta.deltaId,
      candidateId,
      receiptId: attempt.response.receipt.receiptId,
      locationTargetNodeId: HOME_MOVE_IDS.budget,
      locationLabel: "Budget",
      affectedTitles: ["Budget"],
      managerLabel: "Fixture placement manager",
      canAccept: true,
    });
    expect(model.runtime).toEqual({
      mode: "fixture",
      label: "Deterministic fixture manager",
    });
    expect(candidate).toMatchObject({
      id: candidateId,
      parentId: HOME_MOVE_IDS.budget,
      status: {
        knowledge: "Draft",
        governance: "Suggested",
        work: "Planned",
      },
    });
    expect(
      model.relations.find((relation) => relation.source === candidateId),
    ).toMatchObject({ target: HOME_MOVE_IDS.budget, posture: "proposed" });
  });

  it("renders an accepted placement as canonical at the exact committed revision", async () => {
    const attempt = await placementAttempt();
    if (!attempt.kernelDelta || !attempt.response.ok) {
      throw new Error("Expected pending placement.");
    }
    const acceptedEvent = buildDeltaAcceptedEvent(attempt.state, {
      eventId: "event-workbench-accepted",
      commandId: "command-workbench-accepted",
      occurredAt: ACCEPT_TIME,
      actor: HOME_MOVE_ACTORS.human,
      deltaId: attempt.kernelDelta.id,
    });
    const ledger = append(attempt.ledger, acceptedEvent);
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });
    const candidateId = attempt.response.receipt.proposed.nodeId;

    expect(model.placement).toMatchObject({
      state: "adopted",
      canAccept: false,
      candidateId,
      acceptedRevisionId: state.canonical.head.id,
    });
    expect(model.nodes.find((node) => node.id === candidateId)).toMatchObject({
      eyebrow: "Task · Canonical",
      status: { governance: "Adopted" },
    });
    expect(
      model.relations.find((relation) => relation.source === candidateId),
    ).toMatchObject({ posture: "canonical" });
    expect(model.revision).toBe(`Revision ${state.canonical.head.number} · ${state.canonical.head.id}`);
    expect(model.events.at(-1)).toEqual({
      id: "event-workbench-accepted",
      kind: "revision",
      label: "Semantic update adopted",
      detail: `Revision ${state.canonical.head.number} · ${state.canonical.head.id} adopted ${attempt.kernelDelta.id}.`,
      time: ACCEPT_TIME,
      revision: state.canonical.head.id,
      worldstateId: candidateId,
    });
    expect(model.events.find((event) => event.id === "event-workbench-source")?.time).toBe(
      SOURCE_TIME,
    );
    expect(model.work).toMatchObject({
      state: "eligible",
      available: true,
      targetNodeId: candidateId,
      canPrepare: true,
      canAuthorize: false,
      authority: { state: "absent", label: "Not granted" },
    });
  });

  it("projects the immutable brief before authority and exact replay evidence after return", () => {
    const fixture = createPrivateProjectionFixture();
    const preview = buildWorkbenchViewModel({
      ledger: fixture.ledger,
      state: fixture.state,
    });

    expect(preview.work).toMatchObject({
      state: "previewable",
      canPrepare: false,
      canAuthorize: true,
      authority: { state: "prepared", label: "Prepared · not granted" },
      brief: {
        id: fixture.brief.id,
        goal: "Add a simple moving-cost comparison tool to the demo planning page.",
        expectedArtifacts: ["demo/moving-costs.html"],
      },
    });
    expect(preview.work.brief?.omittedContext).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "private" }),
        expect.objectContaining({ reason: "out_of_scope" }),
      ]),
    );
    expect(preview.work.brief?.evidenceRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "requirement-focused-tests",
          command: "npm test -- moving-cost",
          required: true,
        }),
      ]),
    );

    const run: AgentRun = {
      id: "run-view-model-replay",
      briefId: fixture.brief.id,
      baseRevisionId: fixture.brief.baseRevisionId,
      artifactBaseRef: fixture.brief.artifactBaseRef,
      mode: "replay",
    };
    let ledger = append(
      fixture.ledger,
      runAuthorizedEvent({
        eventId: "event-view-model-run-authorized",
        commandId: "command-view-model-run-authorized",
        occurredAt: "2026-07-17T10:10:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { run },
      }),
    );
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      run.id,
      run.mode,
      "request-view-model-replay",
    );
    ledger = append(
      ledger,
      codexRunAttemptSourceEvent({
        run,
        brief: fixture.brief,
        request,
        eventId: "event-view-model-run-attempt",
        commandId: "command-view-model-run-attempt",
        occurredAt: "2026-07-17T10:10:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const response = runCodexReplay(request);
    for (const event of codexRunResponseEvents({
      run,
      brief: fixture.brief,
      request,
      response,
      recordedAt: "2026-07-17T10:10:19.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    })) {
      ledger = append(ledger, event);
    }
    const state = reduceWorldstateLedger(ledger);
    const returned = buildWorkbenchViewModel({ ledger, state });

    expect(returned.work).toMatchObject({
      state: "returned",
      canAuthorize: false,
      canValidate: true,
      validation: null,
      authority: { state: "used", label: "Used" },
      exchangeEvidence: {
        disposition: "accepted",
        requestId: request.requestId,
        requestRunId: run.id,
        responseKind: "success",
        issues: [],
      },
      runtime: {
        mode: "replay",
        requestedMode: "replay",
        effectiveMode: "replay",
        status: "replayed",
        provider: "codex",
        replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
        replayKind: "fixture",
      },
      result: {
        outcome: "returned",
        claimedDone: true,
        observedFiles: [],
        observedCommands: [],
      },
    });
    expect(returned.work.result?.claimedArtifacts).toEqual([
      expect.objectContaining({
        path: "demo/moving-costs.html",
        kind: "updated",
      }),
    ]);
    expect(returned.work.result?.claimedChecks).toHaveLength(2);
    expect(
      returned.events.find(
        (event) =>
          event.id === "event-codex-exchange:request-view-model-replay",
      ),
    ).toMatchObject({
      kind: "worker",
      label: "Codex exchange evidence persisted",
      worldstateId: fixture.brief.targetNodeId,
    });
    expect(returned.work.reconciliation).toMatchObject({
      state: "unavailable",
      canPropose: false,
      canIntegrate: false,
    });
    expect(returned.work.reconciliation.proposalGateReason).toContain(
      "Independent evidence validation must be recorded",
    );
    expect(state.canonical.head.id).toBe(fixture.state.canonical.head.id);

    const attemptedValidation = buildWorkbenchViewModel({
      ledger,
      state,
      workOperation: {
        state: "idle",
        activeValidationRequestId: "request-view-model-validation-attempt",
      },
    });
    expect(attemptedValidation.work.canValidate).toBe(false);
    expect(attemptedValidation.work.validationGateReason).toContain(
      "cannot be retried safely",
    );
  });

  it("offers only the exact live dispatch retry after a private not-started status", () => {
    const fixture = createPrivateProjectionFixture({
      executionMode: "live",
      artifactBaseRef: `git:${"a".repeat(40)}`,
    });
    const run: AgentRun = {
      id: "run-view-model-live-not-started",
      briefId: fixture.brief.id,
      baseRevisionId: fixture.brief.baseRevisionId,
      artifactBaseRef: fixture.brief.artifactBaseRef,
      mode: "live",
    };
    let ledger = append(
      fixture.ledger,
      runAuthorizedEvent({
        eventId: "event-view-model-live-authorized",
        commandId: "command-view-model-live-authorized",
        occurredAt: "2026-07-17T10:10:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { run },
      }),
    );
    const request = authorizedCodexRunRequest({
      state: reduceWorldstateLedger(ledger),
      runId: run.id,
      requestId: "request-view-model-live-not-started",
      secret: "view-model-live-authority-secret",
      now: new Date("2026-07-17T10:10:00.000Z"),
      nonce: "00000000-0000-4000-8000-000000000126",
    });
    ledger = append(
      ledger,
      codexRunAttemptSourceEvent({
        run,
        brief: fixture.brief,
        request,
        eventId: "event-view-model-live-attempt",
        commandId: "command-view-model-live-attempt",
        occurredAt: "2026-07-17T10:10:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({
      ledger,
      state,
      workOperation: {
        state: "idle",
        activeBriefId: fixture.brief.id,
        activeRunId: run.id,
        activeAgentRequestId: request.requestId,
        error: {
          code: "delegation_not_started",
          message: "The live request awaits an explicit dispatch retry.",
        },
      },
    });

    expect(model.work).toMatchObject({
      state: "queued",
      canAuthorize: false,
      canRetryDispatch: true,
      errorCode: "delegation_not_started",
    });
    expect(model.work.dispatchGateReason).toContain(
      "without granting new authority",
    );
  });

  it("summarizes recognized system evidence and withholds unknown or invalid system payloads", () => {
    const fixture = createPrivateProjectionFixture();
    const run: AgentRun = {
      id: "run-view-model-withheld-system-evidence",
      briefId: fixture.brief.id,
      baseRevisionId: fixture.brief.baseRevisionId,
      artifactBaseRef: fixture.brief.artifactBaseRef,
      mode: "replay",
    };
    let ledger = append(
      fixture.ledger,
      runAuthorizedEvent({
        eventId: "event-view-model-withheld-run-authorized",
        commandId: "command-view-model-withheld-run-authorized",
        occurredAt: "2026-07-17T10:12:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { run },
      }),
    );
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      run.id,
      run.mode,
      "request-view-model-safe-summary",
    );
    ledger = append(
      ledger,
      codexRunAttemptSourceEvent({
        run,
        brief: fixture.brief,
        request,
        eventId: "event-view-model-safe-system-source",
        commandId: "command-view-model-safe-system-source",
        occurredAt: "2026-07-17T10:12:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );

    const signedAuthorizationPayload = JSON.stringify({
      kind: "odeu.codex-run-attempt",
      authorization: {
        nonce: "00000000-0000-4000-8000-000000000099",
        capability: "signed-live-capability-must-never-render",
      },
    });
    ledger = append(
      ledger,
      sourceCapturedEvent({
        eventId: "event-view-model-invalid-known-system-source",
        commandId: "command-view-model-invalid-known-system-source",
        occurredAt: "2026-07-17T10:12:02.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          source: {
            id: "source-codex-attempt:tampered-live-request",
            kind: "system",
            content: signedAuthorizationPayload,
            visibility: "shared",
            integrity: {
              algorithm: "fnv1a64",
              digest: "fnv1a64:0000000000000000",
            },
          },
        },
      }),
    );
    const unknownPayload =
      '{"kind":"unknown-system-envelope","secret":"unknown-system-content-must-never-render"}';
    ledger = append(
      ledger,
      sourceCapturedEvent({
        eventId: "event-view-model-unknown-system-source",
        commandId: "command-view-model-unknown-system-source",
        occurredAt: "2026-07-17T10:12:03.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          source: {
            id: "source-unknown-system-envelope",
            kind: "system",
            content: unknownPayload,
            visibility: "shared",
          },
        },
      }),
    );

    const model = buildWorkbenchViewModel({
      ledger,
      state: reduceWorldstateLedger(ledger),
    });

    expect(
      model.events.find(
        (event) => event.id === "event-view-model-safe-system-source",
      ),
    ).toMatchObject({
      label: "Codex request persisted",
      detail:
        "Replay request request-view-model-safe-summary was recorded before dispatch.",
      worldstateId: fixture.brief.targetNodeId,
    });
    expect(
      model.events.filter(
        (event) => event.label === "System evidence withheld",
      ),
    ).toHaveLength(2);
    const projectedTimeline = JSON.stringify(model.events);
    expect(projectedTimeline).not.toContain(signedAuthorizationPayload);
    expect(projectedTimeline).not.toContain(
      "signed-live-capability-must-never-render",
    );
    expect(projectedTimeline).not.toContain(unknownPayload);
    expect(projectedTimeline).not.toContain(
      "unknown-system-content-must-never-render",
    );
  });

  it("projects independent validation separately from returned claims and canonical work", () => {
    const fixture = createReplayClosureFixture();
    const run = fixture.state.operational.runs[HOME_MOVE_IDS.run].run;
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      run.id,
      run.mode,
      "request-view-model-validated-replay",
    );
    let ledger = append(
      fixture.ledger,
      codexRunAttemptSourceEvent({
        run,
        brief: fixture.brief,
        request,
        eventId: "event-view-model-validated-attempt",
        commandId: "command-view-model-validated-attempt",
        occurredAt: "2026-07-17T10:15:00.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    ledger = append(
      ledger,
      codexRunExchangeSourceEvent({
        request,
        response: runCodexReplay(request),
        eventId: "event-view-model-validated-exchange",
        commandId: "command-view-model-validated-exchange",
        occurredAt: "2026-07-17T10:15:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(model.work).toMatchObject({
      state: "returned",
      canValidate: false,
      validation: {
        id: "validation-moving-tool-replay",
        verdict: "verified",
        requiredPassed: 2,
        requiredTotal: 2,
        evidenceSourceId: "source-evidence-validation-replay",
      },
    });
    expect(model.work.validation?.observations).toEqual([
      expect.objectContaining({
        requirementId: "requirement-focused-tests",
        result: "passed",
        freshness: "current",
      }),
      expect.objectContaining({
        requirementId: "requirement-artifact-change",
        result: "passed",
        freshness: "current",
      }),
    ]);
    expect(state.canonical.nodes[HOME_MOVE_IDS.compareQuotes].work).toEqual({
      phase: "planned",
      verification: "unverified",
    });
    expect(model.work.reconciliation).toMatchObject({
      state: "unavailable",
      canPropose: false,
      canIntegrate: false,
    });
    expect(model.work.reconciliation.proposalGateReason).toContain(
      "exact registered replay-verifier exchange",
    );
  });

  it("quarantines a cross-run response and suppresses its report and existing closure", () => {
    const fixture = createReplayClosureFixture();
    const run = fixture.state.operational.runs[HOME_MOVE_IDS.run].run;
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      run.id,
      run.mode,
      "request-view-model-cross-run",
    );
    let ledger = append(
      fixture.ledger,
      codexRunAttemptSourceEvent({
        run,
        brief: fixture.brief,
        request,
        eventId: "event-view-model-cross-run-attempt",
        commandId: "command-view-model-cross-run-attempt",
        occurredAt: "2026-07-17T10:20:00.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const coherent = runCodexReplay(request);
    const crossRunResponse = {
      ...coherent,
      closure: { ...coherent.closure, runId: "run-cross-run-substitution" },
    };
    ledger = append(
      ledger,
      codexRunExchangeSourceEvent({
        request,
        response: crossRunResponse,
        eventId: "event-view-model-cross-run-exchange",
        commandId: "command-view-model-cross-run-exchange",
        occurredAt: "2026-07-17T10:20:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    ledger = append(
      ledger,
      codexRunNormalizationFailureSourceEvent({
        requestId: request.requestId,
        runId: run.id,
        briefId: fixture.brief.id,
        code: "coherence_rejected",
        message:
          "response.closure.runId did not match the active authorized run",
        eventId: "event-view-model-cross-run-rejected",
        commandId: "command-view-model-cross-run-rejected",
        occurredAt: "2026-07-17T10:20:02.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(state.operational.closures[HOME_MOVE_IDS.closure]).toBeDefined();
    expect(model.work).toMatchObject({
      state: "quarantined",
      result: null,
      authority: { state: "used" },
      runtime: {
        status: "quarantined",
        replayIdentity: null,
        label: "Codex exchange quarantined",
      },
      exchangeEvidence: {
        disposition: "quarantined",
        requestRunId: run.id,
        replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
        responseKind: "success",
      },
      normalizationFailure: {
        code: "coherence_rejected",
        message:
          "response.closure.runId did not match the active authorized run",
      },
    });
    expect(model.work.exchangeEvidence?.issues).toContain(
      `response.closure.runId must equal ${run.id}`,
    );
    expect(
      model.events.find(
        (event) => event.id === "event-view-model-cross-run-rejected",
      ),
    ).toMatchObject({
      label: "Codex normalization rejected",
      detail:
        "coherence_rejected: response.closure.runId did not match the active authorized run",
      worldstateId: fixture.brief.targetNodeId,
    });
  });

  it("renders a normalization state conflict as outcome unknown without inferring a closure", () => {
    const fixture = createPrivateProjectionFixture();
    const run: AgentRun = {
      id: "run-view-model-outcome-unknown",
      briefId: fixture.brief.id,
      baseRevisionId: fixture.brief.baseRevisionId,
      artifactBaseRef: fixture.brief.artifactBaseRef,
      mode: "replay",
    };
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      run.id,
      run.mode,
      "request-view-model-outcome-unknown",
    );
    let ledger = append(
      fixture.ledger,
      runAuthorizedEvent({
        eventId: "event-view-model-outcome-unknown-authorized",
        commandId: "command-view-model-outcome-unknown-authorized",
        occurredAt: "2026-07-17T10:30:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { run },
      }),
    );
    ledger = append(
      ledger,
      codexRunAttemptSourceEvent({
        run,
        brief: fixture.brief,
        request,
        eventId: "event-view-model-outcome-unknown-attempt",
        commandId: "command-view-model-outcome-unknown-attempt",
        occurredAt: "2026-07-17T10:30:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    ledger = append(
      ledger,
      codexRunExchangeSourceEvent({
        request,
        response: runCodexReplay(request),
        eventId: "event-view-model-outcome-unknown-exchange",
        commandId: "command-view-model-outcome-unknown-exchange",
        occurredAt: "2026-07-17T10:30:02.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const privateBodyExcerpt = "provider body must not appear in timeline";
    ledger = append(
      ledger,
      codexTransportObservationSourceEvent({
        observation: {
          requestId: request.requestId,
          runId: run.id,
          outcome: "response_invalid",
          httpStatus: 502,
          contentType: "text/html",
          bodyExcerpt: privateBodyExcerpt,
          bodyTruncated: false,
          bodyDigest: fingerprint(privateBodyExcerpt),
        },
        eventId: "event-view-model-outcome-unknown-transport",
        commandId: "command-view-model-outcome-unknown-transport",
        occurredAt: "2026-07-17T10:30:02.500Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    );
    ledger = append(
      ledger,
      codexRunNormalizationFailureSourceEvent({
        requestId: request.requestId,
        runId: run.id,
        briefId: fixture.brief.id,
        code: "state_conflict",
        message: "The normalized lifecycle conflicted with durable state.",
        eventId: "event-view-model-outcome-unknown-conflict",
        commandId: "command-view-model-outcome-unknown-conflict",
        occurredAt: "2026-07-17T10:30:03.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    ledger = append(
      ledger,
      runLifecycleEvent({
        eventId: "event-view-model-outcome-unknown",
        commandId: "command-view-model-outcome-unknown",
        occurredAt: "2026-07-17T10:30:04.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          runId: run.id,
          status: "outcome_unknown",
          message: "The normalized lifecycle conflicted with durable state.",
          evidenceRefs: [],
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(
      Object.values(state.operational.closures).some(
        (closure) => closure.runId === run.id,
      ),
    ).toBe(false);
    expect(model.work).toMatchObject({
      state: "outcome_unknown",
      reason:
        "The run reached outcome_unknown. No trustworthy terminal outcome or closure can be inferred.",
      run: { status: "outcome_unknown" },
      runtime: {
        status: "outcome_unknown",
        label: "Codex outcome not observed",
        replayIdentity: null,
      },
      exchangeEvidence: { disposition: "accepted" },
      normalizationFailure: {
        code: "state_conflict",
        message: "The normalized lifecycle conflicted with durable state.",
      },
      result: {
        closureId: null,
        outcome: "returned",
        claimedDone: true,
      },
    });
    expect(
      model.events.find(
        (event) => event.id === "event-view-model-outcome-unknown-conflict",
      ),
    ).toMatchObject({
      label: "Codex normalization conflict",
      detail:
        "state_conflict: The normalized lifecycle conflicted with durable state.",
    });
    const transportTimeline = model.events.find(
      (event) => event.id === "event-view-model-outcome-unknown-transport",
    );
    expect(transportTimeline).toMatchObject({
      label: "Codex response rejected at transport boundary",
      worldstateId: fixture.brief.targetNodeId,
    });
    expect(transportTimeline?.detail).toContain(
      `response_invalid · HTTP 502 · text/html · ${fingerprint(privateBodyExcerpt)} · complete`,
    );
    expect(transportTimeline?.detail).not.toContain(privateBodyExcerpt);
  });

  it("marks a closure against an older revision as stale and blocks new authority", () => {
    const fixture = createStaleClosureFixture();
    const model = buildWorkbenchViewModel({
      ledger: fixture.ledger,
      state: fixture.state,
    });

    expect(model.work).toMatchObject({
      state: "stale",
      canPrepare: false,
      canAuthorize: false,
      authority: { state: "used" },
      brief: { stale: true },
      run: { stale: true },
      result: { stale: true },
    });
    expect(model.work.dispatchGateReason).toContain("No new authority");
  });

  it("surfaces clarification and error exchanges without a committable overlay", async () => {
    const clarification = await placementAttempt((response) =>
      PlacementSuccessResponseSchema.parse({
        ...response,
        manager: {
          requestedMode: "live",
          effectiveMode: "live",
          status: "available",
          provider: "openai",
          model: "gpt-test",
          responseId: "response-test",
        },
        receipt: {
          ...response.receipt,
          decisionState: "needs_clarification",
          location: {
            targetNodeId: null,
            label: "Project area not resolved",
            breadcrumb: ["Plan our home move"],
          },
          clarificationQuestion: "Which project area should contain this task?",
        },
        delta: null,
      }),
    );
    const clarificationModel = buildWorkbenchViewModel({
      ledger: clarification.ledger,
      state: clarification.state,
    });

    expect(clarificationModel.placement).toMatchObject({
      state: "needs_clarification",
      clarificationQuestion: "Which project area should contain this task?",
      canAccept: false,
    });
    expect(clarificationModel.runtime).toEqual({
      mode: "live",
      label: "Live manager · OpenAI · gpt-test",
    });
    expect(
      clarificationModel.nodes.some(
        (node) => node.id === clarificationModel.placement.candidateId,
      ),
    ).toBe(false);

    const failure = await placementAttempt(
      () => invalidJsonPlacementResponse({ ODEU_MANAGER_MODE: "fixture" }).body,
    );
    const failureModel = buildWorkbenchViewModel({
      ledger: failure.ledger,
      state: failure.state,
    });
    expect(failureModel.placement).toMatchObject({
      state: "failed",
      errorCode: "invalid_json",
      canAccept: false,
      sourceId: SOURCE_ID,
      exchangeId: placementExchangeSourceId(failure.request.requestId),
    });
    expect(failureModel.runtime.mode).toBe("unavailable");
  });

  it("keeps a stale pending proposal visible but blocks semantic commit", async () => {
    const attempt = await placementAttempt();
    const advancingDelta: WorldstateDelta = {
      id: "delta-advance-after-placement",
      baseRevisionId: attempt.state.canonical.head.id,
      scopeId: HOME_MOVE_IDS.project,
      purpose: "correction",
      proposedBy: HOME_MOVE_ACTORS.human,
      operations: [
        {
          op: "node.add",
          node: {
            id: "node-advance-after-placement",
            scopeId: HOME_MOVE_IDS.project,
            kind: "Idea",
            title: "Advance the canonical head",
            visibility: "shared",
            sourceRefs: [SOURCE_ID],
            data: {},
          },
        },
      ],
      rationale: ["Advance the head to exercise stale placement handling."],
      sourceRefs: [SOURCE_ID],
      uncertainty: [],
      alternatives: [],
      conflicts: [],
      visibleConsequence: "A separate canonical idea advances the project head.",
    };
    let ledger = append(
      attempt.ledger,
      deltaProposedEvent({
        eventId: "event-advance-proposed",
        commandId: "command-advance-proposed",
        occurredAt: "2026-07-17T10:01:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { delta: advancingDelta },
      }),
    );
    const beforeAdvance = reduceWorldstateLedger(ledger);
    ledger = append(
      ledger,
      buildDeltaAcceptedEvent(beforeAdvance, {
        eventId: "event-advance-accepted",
        commandId: "command-advance-accepted",
        occurredAt: "2026-07-17T10:01:01.000Z",
        actor: HOME_MOVE_ACTORS.human,
        deltaId: advancingDelta.id,
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(model.placement).toMatchObject({ state: "stale", canAccept: false });
    expect(model.placement.gateReason).toContain(attempt.state.canonical.head.id);
    expect(model.placement.gateReason).toContain(state.canonical.head.id);
    expect(
      model.nodes.find((node) => node.id === model.placement.candidateId)?.status.governance,
    ).toBe("Suggested");
  });

  it("does not keep a deferred delta provisional or committable", async () => {
    const attempt = await placementAttempt();
    if (!attempt.kernelDelta) throw new Error("Expected pending placement.");
    const ledger = append(
      attempt.ledger,
      deltaDispositionEvent({
        type: "delta.deferred",
        eventId: "event-workbench-deferred",
        commandId: "command-workbench-deferred",
        occurredAt: "2026-07-17T10:00:04.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: {
          deltaId: attempt.kernelDelta.id,
          baseRevisionId: attempt.kernelDelta.baseRevisionId,
          reason: "Wait for an updated provider list.",
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(model.placement).toMatchObject({
      state: "failed",
      errorCode: "delta_deferred",
      canAccept: false,
    });
    expect(model.nodes.some((node) => node.id === model.placement.candidateId)).toBe(false);
  });

  it("lets a later persisted failure block the receipt without erasing responded runtime truth", async () => {
    const attempt = await placementAttempt();
    const ledger = append(
      attempt.ledger,
      createLedgerEvent({
        type: "manager.failure_recorded",
        eventId: "event-workbench-retry-failed",
        commandId: "command-workbench-retry-failed",
        occurredAt: "2026-07-17T10:02:00.000Z",
        actor: HOME_MOVE_ACTORS.manager,
        payload: {
          sourceId: SOURCE_ID,
          code: "network_retry_failed",
          message: "The retry could not reach the placement manager.",
          retriable: true,
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const model = buildWorkbenchViewModel({ ledger, state });

    expect(model.placement).toMatchObject({
      state: "failed",
      sourceId: SOURCE_ID,
      errorCode: "network_retry_failed",
      retryable: true,
      canAccept: false,
      exchangeId: placementExchangeSourceId(attempt.request.requestId),
    });
    expect(model.runtime).toEqual({
      mode: "fixture",
      label: "Deterministic fixture manager",
    });
    expect(model.nodes.some((node) => node.id === model.placement.candidateId)).toBe(false);

    const nextSourceId = "source-workbench-next-attempt";
    const nextLedger = append(
      ledger,
      sourceCapturedEvent({
        eventId: "event-workbench-next-source",
        commandId: "command-workbench-next-source",
        occurredAt: "2026-07-17T10:03:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: {
          source: {
            id: nextSourceId,
            kind: "text",
            content: "Add a packing checklist.",
            visibility: "shared",
          },
        },
      }),
    );
    const nextModel = buildWorkbenchViewModel({
      ledger: nextLedger,
      state: reduceWorldstateLedger(nextLedger),
    });
    expect(nextModel.placement).toMatchObject({
      state: "idle",
      sourceId: nextSourceId,
      sourceText: "Add a packing checklist.",
      canAccept: false,
    });
    expect(nextModel.runtime.mode).toBe("fixture");
  });

  it("retains failed live-provider metadata after its failure event is recorded", async () => {
    const attempt = await placementAttempt(() =>
      PlacementErrorResponseSchema.parse({
        ok: false,
        manager: {
          requestedMode: "live",
          effectiveMode: "live",
          status: "failed",
          provider: "openai",
          model: "gpt-live-test",
          responseId: "response-live-test",
        },
        sourcePreserved: true,
        error: {
          code: "provider_request_failed",
          message: "The live provider did not complete the request.",
          retryable: true,
          issues: [],
        },
      }),
    );
    const ledger = append(
      attempt.ledger,
      createLedgerEvent({
        type: "manager.failure_recorded",
        eventId: "event-workbench-live-failure",
        commandId: "command-workbench-live-failure",
        occurredAt: "2026-07-17T10:02:00.000Z",
        actor: HOME_MOVE_ACTORS.manager,
        payload: {
          sourceId: SOURCE_ID,
          code: "provider_request_failed",
          message: "The live provider did not complete the request.",
          retriable: true,
        },
      }),
    );
    const model = buildWorkbenchViewModel({
      ledger,
      state: reduceWorldstateLedger(ledger),
    });

    expect(model.placement).toMatchObject({
      state: "failed",
      errorCode: "provider_request_failed",
      retryable: true,
    });
    expect(model.runtime).toEqual({
      mode: "live",
      label: "Live manager failed · OpenAI · gpt-live-test",
    });
    expect(model.placement.managerLabel).toBe(
      "Live manager failed · OpenAI · gpt-live-test",
    );
  });
});
