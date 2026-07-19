import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCodexReplay } from "@/adapters/codex/replay";
import {
  HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
  HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
  HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF,
  HOME_MOVE_REPLAY_ARTIFACT_PATH,
  HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
  HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
  HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
  HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS,
  HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
  HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
  HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  HOME_MOVE_REPLAY_IDENTITY,
  HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX,
  ReplayEvidenceResponseSchema,
  type ReplayEvidenceRequest,
} from "@/adapters/replay-evidence";
import {
  PlacementErrorResponseSchema,
  PlacementSuccessResponseSchema,
  placeSource,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  createMemoryWorldstateLedgerStore,
  ledgerVersion,
  type ProjectLedgerStore,
  worldstateLedgerDocument,
} from "@/adapters/storage";
import {
  createWorldstateSession,
  type WorldstateSession,
  type WorldstateSessionSnapshot,
} from "@/application/worldstate-session";
import {
  appendLedgerEvent,
  evidenceValidationEvent,
  MOVING_COST_DELEGATION_PROFILE_ID,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  runLifecycleEvent,
  sourceCapturedEvent,
  type AgentRun,
  type LedgerEvent,
  type WorldstateLedger,
} from "@/domain";
import {
  createPrivateProjectionFixture,
  createReplayClosureFixture,
  HOME_MOVE_ACTORS,
  HOME_MOVE_IDS,
} from "@/fixtures";
import {
  codexRunAttemptSourceEvent,
  codexRunExchangeSourceEvent,
  codexRunNormalizationFailureSourceEvent,
} from "@/integration/codex-run-evidence";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { buildWorkbenchViewModel } from "./view-model";
import type { WorldstatePresentationState } from "./presentation";
import type { WorkSurface } from "./types";
import { WorkPanel, WorldstateWorkbench } from "./worldstate-workbench";

const SOURCE =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";

function append(
  ledger: WorldstateLedger,
  event: Parameters<typeof appendLedgerEvent>[1],
) {
  return appendLedgerEvent(ledger, event).ledger;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function sessionHarness(
  store: ProjectLedgerStore<LedgerEvent> = createMemoryWorldstateLedgerStore(),
  placementGateway: (
    request: PlacementRequest,
  ) => Promise<PlacementResponse> = fixtureGateway,
  idSeed = "workbench",
): { session: WorldstateSession; store: ProjectLedgerStore<LedgerEvent> } {
  let id = 0;
  let tick = 0;
  return {
    store,
    session: createWorldstateSession({
      store,
      placementGateway,
      agentGateway: async (request) => runCodexReplay(request),
      replayEvidenceGateway: async (request) => passingReplayEvidence(request),
      now: () =>
        new Date(Date.UTC(2026, 6, 17, 10, 0, 0, tick++)).toISOString(),
      nextId: (kind) => `${kind}:${idSeed}-${++id}`,
    }),
  };
}

function passingReplayEvidence(request: ReplayEvidenceRequest) {
  return ReplayEvidenceResponseSchema.parse({
    ok: true,
    status: "passed",
    verifier: {
      identity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
      version: 2,
      kind: "independent_fixture",
    },
    bindings: {
      validationRequestId: request.validationRequestId,
      validationId: request.validationId,
      closureId: request.closureId,
      runId: request.runId,
      briefId: request.briefId,
      baseRevisionId: request.baseRevisionId,
      artifactBaseRef: request.artifactBaseRef,
      replayIdentity: request.replayIdentity,
      semanticBriefDigest: request.semanticBriefDigest,
      exchangeSourceId: request.exchangeSourceId,
    },
    observedAt: "2026-07-17T10:00:30.000Z",
    bundle: {
      bundleId: HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
      version: 2,
      manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
      artifactCount: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
    },
    observations: request.evidenceRequirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      result: "passed",
      evidenceRef:
        requirement.kind === "artifact"
          ? HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF
          : `${HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX}${encodeURIComponent(
              requirement.requirementId,
            )}/${HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID}`,
      detail: "Observed independently from the replay artifact bundle.",
      artifact:
        requirement.kind === "artifact"
          ? {
              path: HOME_MOVE_REPLAY_ARTIFACT_PATH,
              digest: HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
              byteLength: HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
              manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
            }
          : null,
      execution:
        requirement.kind === "test"
          ? {
              declaredCommand: HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
              executionKind: HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
              runnerId: HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
              cases: HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.map(
                (caseId) => ({
                  caseId,
                  result: "passed" as const,
                  detail: "Observed the expected total.",
                }),
              ),
              passedCount: HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.length,
              totalCount: HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.length,
            }
          : null,
    })),
  });
}

async function fixtureGateway(
  request: PlacementRequest,
): Promise<PlacementResponse> {
  return (
    await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    })
  ).body;
}

function staticSession(snapshot: WorldstateSessionSnapshot): {
  session: WorldstateSession;
  retryPlacement: ReturnType<typeof vi.fn>;
  acceptActivePlacement: ReturnType<typeof vi.fn>;
} {
  const retryPlacement = vi.fn(async () => undefined);
  const acceptActivePlacement = vi.fn(async () => undefined);
  const prepareActiveAgentBrief = vi.fn(async () => undefined);
  const authorizeAndDispatchActiveBrief = vi.fn(async () => undefined);
  const retryActiveLiveDispatch = vi.fn(async () => undefined);
  const validateActiveReplayEvidence = vi.fn(async () => undefined);
  const proposeActiveReconciliation = vi.fn(async () => undefined);
  const integrateActiveReconciliation = vi.fn(async () => undefined);
  const proposeActiveArtifactPromotion = vi.fn(async () => undefined);
  const promoteActiveArtifact = vi.fn(async () => undefined);
  return {
    retryPlacement,
    acceptActivePlacement,
    session: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      initialize: async () => undefined,
      captureAndPlace: async () => undefined,
      retryPlacement,
      acceptActivePlacement,
      prepareActiveAgentBrief,
      authorizeAndDispatchActiveBrief,
      retryActiveLiveDispatch,
      validateActiveEvidence: validateActiveReplayEvidence,
      validateActiveReplayEvidence,
      proposeActiveReconciliation,
      integrateActiveReconciliation,
      proposeActiveArtifactPromotion,
      promoteActiveArtifact,
      resetSandbox: async () => undefined,
    },
  };
}

function replayValidationSnapshot(
  posture: "not_verified" | "stale",
): WorldstateSessionSnapshot {
  const fixture = createReplayClosureFixture();
  const validationEvent = fixture.ledger.events.at(-1);
  if (
    !validationEvent ||
    validationEvent.type !== "evidence.validation_recorded"
  ) {
    throw new Error("Expected the replay fixture validation event.");
  }
  const observations = validationEvent.payload.validation.observations.map(
    (observation, index) => ({
      ...observation,
      ...(posture === "not_verified" && index === 0
        ? { result: "failed" as const }
        : {}),
      ...(posture === "stale" ? { freshness: "stale" as const } : {}),
    }),
  );
  let ledger: WorldstateLedger = {
    ...fixture.ledger,
    events: fixture.ledger.events.slice(0, -1),
  };
  ledger = append(
    ledger,
    evidenceValidationEvent({
      ...validationEvent,
      eventId: `event-component-validation-${posture}`,
      commandId: `command-component-validation-${posture}`,
      payload: {
        validation: {
          ...validationEvent.payload.validation,
          id: `validation-component-${posture}`,
          observations,
        },
      },
    }),
  );
  const run = fixture.state.operational.runs[HOME_MOVE_IDS.run].run;
  const request = domainBriefToCodexRunRequest(
    fixture.brief,
    run.id,
    run.mode,
    `request-component-validation-${posture}`,
  );
  ledger = append(
    ledger,
    codexRunAttemptSourceEvent({
      run,
      brief: fixture.brief,
      request,
      eventId: `event-component-validation-attempt-${posture}`,
      commandId: `command-component-validation-attempt-${posture}`,
      occurredAt: "2026-07-17T10:45:00.000Z",
      actor: HOME_MOVE_ACTORS.system,
    }),
  );
  ledger = append(
    ledger,
    codexRunExchangeSourceEvent({
      request,
      response: runCodexReplay(request),
      eventId: `event-component-validation-exchange-${posture}`,
      commandId: `command-component-validation-exchange-${posture}`,
      occurredAt: "2026-07-17T10:45:01.000Z",
      actor: HOME_MOVE_ACTORS.system,
    }),
  );
  const state = reduceWorldstateLedger(ledger);
  const document = worldstateLedgerDocument({
    ledger,
    projectLabel: "Plan our home move",
    updatedAt: "2026-07-17T10:45:01.000Z",
  });
  return {
    document,
    ledger,
    state,
    version: ledgerVersion(document),
    persistenceState: "saved",
    persistenceDetail: "Browser ledger loaded.",
    operationState: "idle",
    activeSourceId: null,
    activeRequestId: null,
    activeDeltaId: null,
    activeAgentRequestId: request.requestId,
    activeBriefId: fixture.brief.id,
    activeRunId: run.id,
    activeClosureId: HOME_MOVE_IDS.closure,
    activeValidationRequestId: null,
    activeValidationId: `validation-component-${posture}`,
    activeReconciliationDeltaId: null,
    activeIntegratedRevisionId: null,
    activeArtifactPromotionId: null,
    error: null,
    retry: null,
  };
}

describe("WorldstateWorkbench", () => {
  it("applies each typed presentation command identity once without changing canonical state", async () => {
    const { session } = sessionHarness();
    const onPresentationStateChange =
      vi.fn<(state: WorldstatePresentationState) => void>();
    const onSelectionChange = vi.fn();
    const onViewChange = vi.fn();
    const { container, rerender } = render(
      <WorldstateWorkbench
        initialView="outline"
        onPresentationStateChange={onPresentationStateChange}
        onSelectionChange={onSelectionChange}
        onViewChange={onViewChange}
        session={session}
      />,
    );

    const root = await waitFor(() => {
      const rendered = container.querySelector(
        "[data-morphic-root='worldstate-workbench'][data-worldstate-revision]",
      );
      expect(rendered).toBeInTheDocument();
      return rendered;
    });
    const initialLedger = session.getSnapshot().ledger;
    const initialRevision = session.getSnapshot().state?.canonical.head.id;

    rerender(
      <WorldstateWorkbench
        initialView="outline"
        onPresentationStateChange={onPresentationStateChange}
        onSelectionChange={onSelectionChange}
        onViewChange={onViewChange}
        presentationCommand={{
          id: "presentation-command-view",
          type: "select_view",
          view: "focus",
        }}
        session={session}
      />,
    );
    await waitFor(() => {
      expect(root).toHaveAttribute("data-view", "focus");
      expect(onViewChange).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      rerender(
        <WorldstateWorkbench
          initialView="outline"
          onPresentationStateChange={onPresentationStateChange}
          onSelectionChange={onSelectionChange}
          onViewChange={onViewChange}
          presentationCommand={{
            id: "presentation-command-view",
            type: "select_view",
            view: "outline",
          }}
          session={session}
        />,
      );
      await Promise.resolve();
    });
    expect(root).toHaveAttribute("data-view", "focus");
    expect(onViewChange).toHaveBeenCalledTimes(1);

    rerender(
      <WorldstateWorkbench
        initialView="outline"
        onPresentationStateChange={onPresentationStateChange}
        onSelectionChange={onSelectionChange}
        onViewChange={onViewChange}
        presentationCommand={{
          id: "presentation-command-object",
          type: "select_object",
          objectId: HOME_MOVE_IDS.goal,
        }}
        session={session}
      />,
    );
    await waitFor(() => {
      expect(root).toHaveAttribute(
        "data-selected-object-id",
        HOME_MOVE_IDS.goal,
      );
      expect(onSelectionChange).toHaveBeenCalledWith(HOME_MOVE_IDS.goal);
      expect(onPresentationStateChange).toHaveBeenLastCalledWith({
        projectId: HOME_MOVE_IDS.project,
        projectLabel: "Plan our home move",
        view: "focus",
        selectedObjectId: HOME_MOVE_IDS.goal,
        selectedObjectLabel: "Complete the move for less than €4,000",
      });
    });

    expect(session.getSnapshot().ledger?.events).toHaveLength(
      initialLedger?.events.length ?? 0,
    );
    expect(session.getSnapshot().state?.canonical.head.id).toBe(
      initialRevision,
    );
  });

  it("rejects unsupported presentation targets without projecting them", async () => {
    const { session } = sessionHarness();
    const onSelectionChange = vi.fn();
    const { container, rerender } = render(
      <WorldstateWorkbench
        onSelectionChange={onSelectionChange}
        presentationCommand={{
          id: "presentation-command-unsupported-object",
          type: "select_object",
          objectId: "node-not-in-this-project",
        }}
        session={session}
      />,
    );

    const root = await waitFor(() => {
      const rendered = container.querySelector(
        "[data-morphic-root='worldstate-workbench'][data-worldstate-revision]",
      );
      expect(rendered).toHaveAttribute(
        "data-selected-object-id",
        HOME_MOVE_IDS.budget,
      );
      return rendered;
    });
    expect(onSelectionChange).not.toHaveBeenCalled();

    await act(async () => {
      rerender(
        <WorldstateWorkbench
          onSelectionChange={onSelectionChange}
          presentationCommand={{
            id: "presentation-command-unsupported-object",
            type: "select_object",
            objectId: HOME_MOVE_IDS.goal,
          }}
          session={session}
        />,
      );
      await Promise.resolve();
    });

    expect(root).toHaveAttribute(
      "data-selected-object-id",
      HOME_MOVE_IDS.budget,
    );
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("keeps the selected kernel object stable while the projection changes", async () => {
    const user = userEvent.setup();
    const { session } = sessionHarness();
    const { container } = render(<WorldstateWorkbench session={session} />);

    await user.click(
      await screen.findByRole("button", {
        name: /Complete the move for less than €4,000/i,
      }),
    );
    const root = container.querySelector(
      "[data-morphic-root='worldstate-workbench']",
    );
    expect(root).toHaveAttribute("data-selected-object-id", HOME_MOVE_IDS.goal);

    await user.click(screen.getByRole("tab", { name: /Focus/i }));
    expect(root).toHaveAttribute("data-view", "focus");
    expect(screen.getByText("Work unavailable")).toBeVisible();
    expect(root).toHaveAttribute("data-selected-object-id", HOME_MOVE_IDS.goal);
    expect(
      container.querySelector(
        `[data-view='focus'] [data-worldstate-id='${HOME_MOVE_IDS.goal}']`,
      ),
    ).toBeInTheDocument();
  });

  it("renders safe system summaries in Timeline while withholding invalid system payloads", () => {
    const fixture = createPrivateProjectionFixture();
    const run: AgentRun = {
      id: "run-component-withheld-system-evidence",
      briefId: fixture.brief.id,
      baseRevisionId: fixture.brief.baseRevisionId,
      artifactBaseRef: fixture.brief.artifactBaseRef,
      mode: "replay",
    };
    let ledger = append(
      fixture.ledger,
      runAuthorizedEvent({
        eventId: "event-component-withheld-run-authorized",
        commandId: "command-component-withheld-run-authorized",
        occurredAt: "2026-07-17T10:08:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
        payload: { run },
      }),
    );
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      run.id,
      run.mode,
      "request-component-safe-summary",
    );
    ledger = append(
      ledger,
      codexRunAttemptSourceEvent({
        run,
        brief: fixture.brief,
        request,
        eventId: "event-component-safe-system-source",
        commandId: "command-component-safe-system-source",
        occurredAt: "2026-07-17T10:08:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const capability = "component-signed-capability-must-never-render";
    ledger = append(
      ledger,
      sourceCapturedEvent({
        eventId: "event-component-invalid-system-source",
        commandId: "command-component-invalid-system-source",
        occurredAt: "2026-07-17T10:08:02.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          source: {
            id: "source-codex-attempt:component-tampered-live-request",
            kind: "system",
            content: JSON.stringify({
              kind: "odeu.codex-run-attempt",
              request: {
                mode: "live",
                authorization: { capability },
              },
            }),
            visibility: "shared",
            integrity: {
              algorithm: "fnv1a64",
              digest: "fnv1a64:0000000000000000",
            },
          },
        },
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const document = worldstateLedgerDocument({
      ledger,
      projectLabel: "Plan our home move",
      updatedAt: "2026-07-17T10:08:02.000Z",
    });
    const { session } = staticSession({
      document,
      ledger,
      state,
      version: ledgerVersion(document),
      persistenceState: "saved",
      persistenceDetail: "Browser ledger loaded.",
      operationState: "idle",
      activeSourceId: null,
      activeRequestId: null,
      activeDeltaId: null,
      activeAgentRequestId: request.requestId,
      activeBriefId: fixture.brief.id,
      activeRunId: run.id,
      activeClosureId: null,
      activeValidationRequestId: null,
      activeValidationId: null,
      activeArtifactPromotionId: null,
      activeReconciliationDeltaId: null,
      activeIntegratedRevisionId: null,
      error: null,
      retry: null,
    });

    const { container } = render(
      <WorldstateWorkbench
        autoInitialize={false}
        initialView="timeline"
        session={session}
      />,
    );

    expect(screen.getByText("Codex request persisted")).toBeVisible();
    expect(
      screen.getByText(
        "Replay request request-component-safe-summary was recorded before dispatch.",
      ),
    ).toBeVisible();
    expect(screen.getByText("System evidence withheld")).toBeVisible();
    expect(container).toHaveTextContent(/raw content is withheld/i);
    expect(container).not.toHaveTextContent(capability);
    expect(container).not.toHaveTextContent('"authorization"');
    expect(container).not.toHaveTextContent('"kind":"odeu.codex-run-attempt"');
  });

  it("persists source and placement before one human semantic commit", async () => {
    const user = userEvent.setup();
    const onSemanticCommit = vi.fn();
    const { session } = sessionHarness();
    const { container } = render(
      <WorldstateWorkbench
        onSemanticCommit={onSemanticCommit}
        session={session}
      />,
    );

    const capture = await screen.findByRole("button", {
      name: "Capture & place",
    });
    const root = container.querySelector(
      "[data-morphic-root='worldstate-workbench']",
    );
    const originalRevision = root?.getAttribute("data-worldstate-revision");
    await user.click(capture);

    const accept = await screen.findByRole("button", {
      name: "Adopt this placement",
    });
    await waitFor(() => expect(accept).toBeEnabled());
    expect(root).toHaveAttribute("data-worldstate-revision", originalRevision);
    expect(
      screen.getByRole("button", { name: "Prepare agent brief" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Authorize fixture replay" }),
    ).toBeDisabled();
    expect(screen.getByText("Alternative placement")).toBeVisible();
    expect(
      screen.getByText(MOVING_COST_DELEGATION_PROFILE_ID),
    ).toBeVisible();
    expect(screen.getByText("Delegation profile proposal")).toBeVisible();
    expect(
      screen.queryByText("Accepted delegation profile"),
    ).not.toBeInTheDocument();

    const pending = session.getSnapshot();
    expect(pending.activeDeltaId).not.toBeNull();
    expect(pending.state?.canonical.head.id).toBe(
      pending.state?.operational.deltas[pending.activeDeltaId as string].delta
        .baseRevisionId,
    );
    expect(Object.keys(pending.state?.operational.briefs ?? {})).toHaveLength(
      0,
    );
    expect(Object.keys(pending.state?.operational.runs ?? {})).toHaveLength(0);
    expect(Object.keys(pending.state?.operational.closures ?? {})).toHaveLength(
      0,
    );

    await user.click(accept);
    await waitFor(() =>
      expect(root?.getAttribute("data-worldstate-revision")).not.toBe(
        originalRevision,
      ),
    );
    expect(onSemanticCommit).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Placement adopted" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Prepare agent brief" }),
    ).toBeEnabled();
    expect(screen.getByText("Accepted delegation profile")).toBeVisible();
    expect(
      screen.getByText(
        `${MOVING_COST_DELEGATION_PROFILE_ID} · accepted, not run authority`,
      ),
    ).toBeVisible();

    const accepted = session.getSnapshot();
    expect(
      accepted.ledger?.events.filter(
        (event) => event.type === "source.captured",
      ),
    ).toHaveLength(3);
    expect(
      accepted.ledger?.events.filter(
        (event) => event.type === "delta.accepted",
      ),
    ).toHaveLength(2);
    expect(
      accepted.ledger?.events.some((event) => event.type === "brief.compiled"),
    ).toBe(false);
  });

  it("rehydrates the exact adopted receipt, revision, source, and selection", async () => {
    const user = userEvent.setup();
    const first = sessionHarness();
    const firstRender = render(<WorldstateWorkbench session={first.session} />);

    await user.click(
      await screen.findByRole("button", { name: "Capture & place" }),
    );
    const accept = await screen.findByRole("button", {
      name: "Adopt this placement",
    });
    await waitFor(() => expect(accept).toBeEnabled());
    await user.click(accept);
    await screen.findByRole("button", { name: "Placement adopted" });

    const durableRevision =
      first.session.getSnapshot().state?.canonical.head.id;
    const durableCandidate = first.session.getSnapshot().activeDeltaId
      ? first.session
          .getSnapshot()
          .state?.operational.deltas[
            first.session.getSnapshot().activeDeltaId as string
          ].delta.operations.find((operation) => operation.op === "node.add")
          ?.node.id
      : null;
    firstRender.unmount();

    const second = sessionHarness(first.store);
    const { container } = render(
      <WorldstateWorkbench session={second.session} />,
    );
    await screen.findByRole("button", { name: "Placement adopted" });

    expect(second.session.getSnapshot().state?.canonical.head.id).toBe(
      durableRevision,
    );
    expect(
      container.querySelector("[data-morphic-root='worldstate-workbench']"),
    ).toHaveAttribute("data-selected-object-id", durableCandidate);
    expect(screen.getByText((text) => text.includes(SOURCE))).toBeVisible();
    expect(screen.getByText("Deterministic fixture manager")).toBeVisible();
  });

  it("keeps evidence before commit and blocks delegation until a brief exists", async () => {
    const { session } = sessionHarness();
    const { container } = render(<WorldstateWorkbench session={session} />);
    await screen.findByRole("button", { name: "Capture & place" });

    for (const region of [
      "scope",
      "projection",
      "interpretation",
      "evidence",
      "governance",
      "semantic-commit",
      "work",
      "status",
    ]) {
      expect(
        container.querySelector(`[data-morphic-region='${region}']`),
      ).toBeInTheDocument();
    }

    const evidence = container.querySelector(
      "[data-morphic-region='evidence']",
    );
    const commit = container.querySelector(
      "[data-morphic-region='semantic-commit']",
    );
    expect(
      evidence && commit
        ? evidence.compareDocumentPosition(commit) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
    expect(
      container.querySelector("[data-action-cluster='agent-delegation']"),
    ).toHaveAttribute("data-gate-state", "blocked");
    expect(
      screen.getByText(/prepare and inspect a durable brief/i),
    ).toBeVisible();
  });

  it("keeps replay claims provisional, then reconciles and integrates through a separate human boundary", async () => {
    const user = userEvent.setup();
    const onAgentDispatch = vi.fn();
    const onEvidenceValidate = vi.fn();
    const onReconciliationPropose = vi.fn();
    const onResultIntegrate = vi.fn();
    const { session } = sessionHarness();
    const { container } = render(
      <WorldstateWorkbench
        onAgentDispatch={onAgentDispatch}
        onEvidenceValidate={onEvidenceValidate}
        onReconciliationPropose={onReconciliationPropose}
        onResultIntegrate={onResultIntegrate}
        session={session}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Capture & place" }),
    );
    const accept = await screen.findByRole("button", {
      name: "Adopt this placement",
    });
    await waitFor(() => expect(accept).toBeEnabled());
    await user.click(accept);

    const prepare = await screen.findByRole("button", {
      name: "Prepare agent brief",
    });
    expect(prepare).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Authorize fixture replay" }),
    ).toBeDisabled();
    await user.click(prepare);

    expect(
      await screen.findByRole("heading", {
        name: "Add a simple moving-cost comparison tool to the demo planning page.",
      }),
    ).toBeVisible();
    expect(screen.getByText(/Shared with agent ·/i)).toBeVisible();
    expect(screen.getByText(/Kept private \/ out of scope ·/i)).toBeVisible();
    expect(screen.getByText("npm test -- moving-cost")).toBeVisible();
    expect(screen.getByText("Prepared · not granted")).toBeVisible();
    expect(
      container.querySelectorAll(
        `[data-delegation-profile-id="${MOVING_COST_DELEGATION_PROFILE_ID}"]`,
      ),
    ).toHaveLength(2);
    expect(
      screen.getByText(
        "demo/moving-costs.html must import ./moving-costs.mjs exactly once, and demo/moving-costs.mjs must export calculateMovingTotalCents for independent fixed-vector verification.",
      ),
    ).toBeVisible();

    const briefEvidence = container.querySelector(
      "[data-evidence-anchor='agent-brief']",
    );
    const dispatchBoundary = container.querySelector(
      "[data-action-cluster='agent-delegation']",
    );
    expect(
      briefEvidence && dispatchBoundary
        ? briefEvidence.compareDocumentPosition(dispatchBoundary) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();

    const authorize = screen.getByRole("button", {
      name: "Authorize fixture replay",
    });
    expect(authorize).toBeEnabled();
    const canonicalBeforeReplay =
      session.getSnapshot().state?.canonical.head.id;
    await user.click(authorize);

    expect(
      await screen.findByRole("button", { name: "Replay authority used" }),
    ).toBeDisabled();
    expect(onAgentDispatch).toHaveBeenCalledOnce();
    expect(screen.getByText("Returned · unverified")).toBeVisible();
    expect(screen.getAllByText(HOME_MOVE_REPLAY_IDENTITY)).toHaveLength(2);
    const exactExchangeEvidence = container.querySelector(
      "[data-evidence-anchor='exact-codex-exchange']",
    );
    expect(exactExchangeEvidence).toHaveTextContent("Binding coherent");
    expect(exactExchangeEvidence).toHaveTextContent(
      HOME_MOVE_REPLAY_IDENTITY,
    );
    expect(
      screen.getByText("Worker claims Done criteria are satisfied"),
    ).toBeVisible();
    expect(screen.getByText("Claimed checks")).toBeVisible();
    expect(
      screen.getByText(/No SDK file or command observations/i),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Prepare reconciliation proposal" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Integrate reviewed result" }),
    ).toBeDisabled();
    expect(session.getSnapshot().state?.canonical.head.id).toBe(
      canonicalBeforeReplay,
    );
    expect(
      session
        .getSnapshot()
        .ledger?.events.some(
          (event) => event.type === "evidence.validation_recorded",
        ),
    ).toBe(false);

    const validate = screen.getByRole("button", {
      name: "Run independent validation",
    });
    expect(validate).toBeEnabled();
    await user.click(validate);

    expect(
      await screen.findByRole("button", {
        name: "Evidence validation recorded",
      }),
    ).toBeDisabled();
    expect(onEvidenceValidate).toHaveBeenCalledOnce();
    expect(screen.getAllByText("Required evidence verified")).toHaveLength(2);
    expect(
      screen.getByText(/2\/2 required checks independently observed/i),
    ).toBeVisible();
    expect(
      container.querySelector("[data-validation-verdict='verified']"),
    ).toBeVisible();
    expect(
      container.querySelectorAll(
        "[data-evidence-anchor='independent-observations'] [data-observation-result='passed']",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("Fixture-equivalent evidence")).toBeVisible();
    expect(
      screen.getByText(
        /Declared command not executed · 3\/3 registered cases passed/i,
      ),
    ).toBeVisible();
    expect(
      container.querySelector(
        "[data-execution-kind='fixture_equivalent'][data-declared-command-executed='false']",
      ),
    ).toBeVisible();
    expect(session.getSnapshot().state?.canonical.head.id).toBe(
      canonicalBeforeReplay,
    );
    expect(
      session
        .getSnapshot()
        .ledger?.events.filter(
          (event) => event.type === "evidence.validation_recorded",
        ),
    ).toHaveLength(1);
    const propose = screen.getByRole("button", {
      name: "Prepare reconciliation proposal",
    });
    expect(propose).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Integrate reviewed result" }),
    ).toBeDisabled();

    const eventCountBeforeProposal =
      session.getSnapshot().ledger?.events.length ?? 0;
    await user.click(propose);

    expect(
      await screen.findByRole("button", { name: "Candidate prepared" }),
    ).toBeDisabled();
    expect(onReconciliationPropose).toHaveBeenCalledOnce();
    expect(session.getSnapshot().state?.canonical.head.id).toBe(
      canonicalBeforeReplay,
    );
    expect(session.getSnapshot().ledger?.events.length).toBe(
      eventCountBeforeProposal + 2,
    );
    const reconciliationCandidate = container.querySelector(
      "[data-evidence-anchor='reconciliation-candidate']",
    );
    expect(reconciliationCandidate).toHaveAttribute("data-state", "candidate");
    expect(reconciliationCandidate).toHaveAttribute(
      "data-state-surface",
      "provisional-status-surface",
    );
    expect(
      container.querySelectorAll(
        "[data-evidence-anchor='reconciliation-consequences'] [data-delta-operation]",
      ),
    ).toHaveLength(3);
    expect(
      container.querySelector(
        "[data-evidence-anchor='reconciliation-consequences']",
      ),
    ).toHaveTextContent("Work · Planned / Unverified → Completed / Verified");
    expect(
      container.querySelector(
        "[data-evidence-anchor='integration-gate-evidence']",
      ),
    ).toHaveAttribute("data-integration-allowed", "true");
    expect(
      container.querySelector(
        "[data-evidence-anchor='integration-gate-evidence']",
      ),
    ).toHaveAttribute("data-integration-verified", "true");
    expect(
      container.querySelector("[data-artifact-promotion='not_performed']"),
    ).toHaveTextContent(/artifact promotion not performed/i);
    expect(
      container.querySelector("[data-causal-authorship-established='false']"),
    ).toHaveTextContent(/does not establish live execution/i);

    const proposedSnapshot = session.getSnapshot();
    if (!proposedSnapshot.ledger || !proposedSnapshot.state) {
      throw new Error("The reconciliation proposal must remain projectable.");
    }
    const proposedTimeline = buildWorkbenchViewModel({
      ledger: proposedSnapshot.ledger,
      state: proposedSnapshot.state,
    }).events;
    expect(proposedTimeline.map((event) => event.label)).toEqual(
      expect.arrayContaining([
        "Reconciliation receipt persisted",
        "Reconciliation candidate proposed",
      ]),
    );
    const receiptEvent = proposedTimeline.find(
      (event) => event.label === "Reconciliation receipt persisted",
    );
    expect(receiptEvent?.detail).toContain("artifact promotion not_performed");
    expect(receiptEvent?.detail).toContain("causal authorship not established");
    expect(receiptEvent?.detail).not.toContain(
      '\"kind\":\"odeu.result-reconciliation\"',
    );

    const validationLane = container.querySelector(
      "[data-morphic-lane='independent-validation']",
    );
    const candidateLane = container.querySelector(
      "[data-morphic-lane='reconciliation-boundary']",
    );
    const integrationLane = container.querySelector(
      "[data-morphic-lane='integration-boundary']",
    );
    expect(
      validationLane && candidateLane
        ? validationLane.compareDocumentPosition(candidateLane) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
    expect(
      candidateLane && integrationLane
        ? candidateLane.compareDocumentPosition(integrationLane) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();

    const integrate = screen.getByRole("button", {
      name: "Integrate reviewed result",
    });
    expect(integrate).toBeEnabled();
    await user.click(integrate);

    expect(
      await screen.findByRole("button", { name: "Result integrated" }),
    ).toBeDisabled();
    expect(onResultIntegrate).toHaveBeenCalledOnce();
    const integrated = session.getSnapshot();
    const integratedTargetId = integrated.activeBriefId
      ? integrated.state?.operational.briefs[integrated.activeBriefId]
          ?.targetNodeId
      : null;
    expect(integrated.state?.canonical.head.id).not.toBe(canonicalBeforeReplay);
    expect(
      integratedTargetId
        ? integrated.state?.canonical.nodes[integratedTargetId]?.work
        : null,
    ).toEqual({ phase: "completed", verification: "verified" });
    expect(
      integrated.ledger?.events.filter(
        (event) =>
          event.type === "delta.accepted" &&
          integrated.state?.operational.deltas[event.payload.deltaId]?.delta
            .purpose === "reconciliation",
      ),
    ).toHaveLength(1);
    expect(reconciliationCandidate).toHaveAttribute("data-state", "integrated");
    expect(reconciliationCandidate).toHaveAttribute(
      "data-state-surface",
      "authoritative-status-surface",
    );
    expect(
      container.querySelector("[data-validation-verdict='verified']"),
    ).toHaveTextContent(/consumed by/i);
    if (!integrated.ledger || !integrated.state) {
      throw new Error("The integrated ledger must remain projectable.");
    }
    expect(
      buildWorkbenchViewModel({
        ledger: integrated.ledger,
        state: integrated.state,
      }).events.map((event) => event.label),
    ).toContain("Result integrated");
  });

  it.each([
    ["not_verified" as const, "Evidence not verified", "failed"],
    ["stale" as const, "Validation stale", "stale"],
  ])(
    "renders %s validation as a warning without enabling integration",
    (posture, label, observationPosture) => {
      const snapshot = replayValidationSnapshot(posture);
      const { session } = staticSession(snapshot);
      const { container } = render(
        <WorldstateWorkbench autoInitialize={false} session={session} />,
      );

      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      expect(
        container.querySelector(
          `[data-validation-verdict='${posture}'][data-state-surface='warning-status-surface']`,
        ),
      ).toBeVisible();
      expect(
        container.querySelector(
          posture === "stale"
            ? "[data-observation-freshness='stale']"
            : `[data-observation-result='${observationPosture}']`,
        ),
      ).toBeVisible();
      expect(
        container.querySelector("[data-gate='integrate-result']"),
      ).toHaveAttribute("data-gate-state", "blocked");
      expect(
        snapshot.state?.canonical.nodes[HOME_MOVE_IDS.compareQuotes].work,
      ).toEqual({
        phase: "planned",
        verification: "unverified",
      });
    },
  );

  it("quarantines a cross-run exchange and renders an unknown outcome without a closure", async () => {
    const fixture = createPrivateProjectionFixture();
    const run: AgentRun = {
      id: "run-workbench-outcome-unknown",
      briefId: fixture.brief.id,
      baseRevisionId: fixture.brief.baseRevisionId,
      artifactBaseRef: fixture.brief.artifactBaseRef,
      mode: "replay",
    };
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      run.id,
      run.mode,
      "request-workbench-outcome-unknown",
    );
    const coherentResponse = runCodexReplay(request);
    if (!coherentResponse.ok) {
      throw new Error("The replay fixture must return a report.");
    }
    const failureMessage =
      "The response closure referenced a different authorized run.";
    let ledger = append(
      fixture.ledger,
      runAuthorizedEvent({
        eventId: "event-workbench-outcome-unknown-authorized",
        commandId: "command-workbench-outcome-unknown-authorized",
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
        eventId: "event-workbench-outcome-unknown-attempt",
        commandId: "command-workbench-outcome-unknown-attempt",
        occurredAt: "2026-07-17T10:30:01.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    ledger = append(
      ledger,
      codexRunExchangeSourceEvent({
        request,
        response: {
          ...coherentResponse,
          closure: {
            ...coherentResponse.closure,
            runId: "run-cross-run-substitution",
          },
        },
        eventId: "event-workbench-outcome-unknown-exchange",
        commandId: "command-workbench-outcome-unknown-exchange",
        occurredAt: "2026-07-17T10:30:02.000Z",
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
        message: failureMessage,
        eventId: "event-workbench-outcome-unknown-rejected",
        commandId: "command-workbench-outcome-unknown-rejected",
        occurredAt: "2026-07-17T10:30:03.000Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    ledger = append(
      ledger,
      runLifecycleEvent({
        eventId: "event-workbench-outcome-unknown",
        commandId: "command-workbench-outcome-unknown",
        occurredAt: "2026-07-17T10:30:04.000Z",
        actor: HOME_MOVE_ACTORS.system,
        payload: {
          runId: run.id,
          status: "outcome_unknown",
          message: failureMessage,
          evidenceRefs: [],
        },
      }),
    );
    const store = createMemoryWorldstateLedgerStore([
      worldstateLedgerDocument({
        ledger,
        projectLabel: "Plan our home move",
        updatedAt: "2026-07-17T10:30:04.000Z",
      }),
    ]);
    const { session } = sessionHarness(
      store,
      fixtureGateway,
      "unknown-outcome",
    );
    const { container } = render(<WorldstateWorkbench session={session} />);

    expect(
      await screen.findByText("Outcome unknown · no closure inferred"),
    ).toBeVisible();
    const exactExchange = container.querySelector(
      "[data-evidence-anchor='exact-codex-exchange']",
    );
    expect(exactExchange).toHaveAttribute("data-state", "quarantined");
    expect(exactExchange).toHaveTextContent("Rejected · quarantined");
    expect(exactExchange).toHaveTextContent(
      `response.closure.runId must equal ${run.id}`,
    );

    const normalizationFailure = container.querySelector(
      "[data-evidence-anchor='codex-normalization-failure']",
    );
    expect(normalizationFailure).toHaveAttribute(
      "data-failure-code",
      "coherence_rejected",
    );
    expect(normalizationFailure).toHaveTextContent(failureMessage);
    expect(normalizationFailure).toHaveTextContent(
      "No closure or verified outcome is inferred",
    );
    expect(
      container.querySelector("[data-evidence-anchor='staged-worker-result']"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Worker claims")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Staged closure witness"),
    ).not.toBeInTheDocument();
  });

  it("keeps placement-record counts and epistemic status hooks aligned with visible truth", async () => {
    const user = userEvent.setup();
    const { session } = sessionHarness();
    const { container } = render(<WorldstateWorkbench session={session} />);

    await screen.findByRole("button", { name: "Capture & place" });
    expect(screen.getByText("01 placement record")).toBeVisible();

    const idleEvidence = container.querySelector(
      "[data-morphic-region='evidence']",
    );
    const idleKnowledge = idleEvidence?.querySelector(
      "[data-state-family='knowledge']",
    );
    const idleGovernance = idleEvidence?.querySelector(
      "[data-state-family='governance']",
    );
    expect(idleKnowledge).toHaveAttribute("data-state", "supported");
    expect(idleKnowledge).toHaveTextContent("Supported");
    expect(idleGovernance).toHaveAttribute("data-state", "not-granted");
    expect(idleGovernance).toHaveTextContent("No placement to adopt");

    await user.click(screen.getByRole("button", { name: "Capture & place" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Adopt this placement" }),
      ).toBeEnabled(),
    );

    expect(screen.getByText("04 placement records")).toBeVisible();
    const reviewableReceipt = container.querySelector(
      "[data-morphic-region='interpretation']",
    );
    const reviewableKnowledge = idleEvidence?.querySelector(
      "[data-state-family='knowledge']",
    );
    const reviewableGovernance = idleEvidence?.querySelector(
      "[data-state-family='governance']",
    );
    expect(reviewableReceipt).toHaveAttribute(
      "data-state-surface",
      "provisional-status-surface",
    );
    expect(reviewableKnowledge).toHaveAttribute("data-state", "open");
    expect(reviewableKnowledge).toHaveTextContent("Open");
    expect(reviewableGovernance).toHaveAttribute("data-state", "suggested");
    expect(reviewableGovernance).toHaveTextContent("Human commit required");
  });

  it("counts and identifies a persisted manager error exchange without inventing a receipt", async () => {
    const user = userEvent.setup();
    const errorGateway = async (): Promise<PlacementResponse> =>
      PlacementErrorResponseSchema.parse({
        ok: false,
        manager: {
          requestedMode: "live",
          effectiveMode: "live",
          status: "failed",
          provider: "openai",
          model: "gpt-test",
          responseId: "response-test-error",
        },
        sourcePreserved: true,
        error: {
          code: "provider_request_failed",
          message: "The provider did not complete the placement.",
          retryable: true,
          issues: [],
        },
      });
    const { session } = sessionHarness(
      createMemoryWorldstateLedgerStore(),
      errorGateway,
    );
    render(<WorldstateWorkbench session={session} />);

    await user.click(
      await screen.findByRole("button", { name: "Capture & place" }),
    );

    expect(await screen.findByText("03 placement records")).toBeVisible();
    expect(screen.getByText(/^source-placement-exchange:/)).toBeVisible();
    expect(
      screen.queryByText("No persisted manager exchange yet"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Live manager failed · OpenAI · gpt-test"),
    ).toBeVisible();
  });

  it("renders every uncertainty and the declared severity of every conflict", async () => {
    const user = userEvent.setup();
    const nuancedGateway = async (
      request: PlacementRequest,
    ): Promise<PlacementResponse> => {
      const fixture = await fixtureGateway(request);
      if (!fixture.ok)
        throw new Error("Expected the fixture placement to succeed.");

      return PlacementSuccessResponseSchema.parse({
        ...fixture,
        receipt: {
          ...fixture.receipt,
          uncertainty: [
            "Storage recurrence remains undecided.",
            "Provider tax handling still needs review.",
          ],
          conflicts: [
            {
              nodeId: HOME_MOVE_IDS.budget,
              title: "Budget area",
              reason: "This is a notice-level overlap.",
              severity: "notice",
            },
            {
              nodeId: HOME_MOVE_IDS.adoptedDecision,
              title: "Three-quote decision",
              reason: "This materially changes the adopted comparison rule.",
              severity: "material",
            },
          ],
        },
      });
    };
    const { session } = sessionHarness(
      createMemoryWorldstateLedgerStore(),
      nuancedGateway,
    );
    const { container } = render(<WorldstateWorkbench session={session} />);

    await user.click(
      await screen.findByRole("button", { name: "Capture & place" }),
    );
    await screen.findByText("2 questions stay open");

    expect(
      screen.getByText("Storage recurrence remains undecided."),
    ).toBeVisible();
    expect(
      screen.getByText("Provider tax handling still needs review."),
    ).toBeVisible();
    expect(
      container.querySelector("[data-severity='notice']"),
    ).toHaveTextContent("NoticeBudget area — This is a notice-level overlap.");
    expect(
      container.querySelector("[data-severity='material']"),
    ).toHaveTextContent(
      "MaterialThree-quote decision — This materially changes the adopted comparison rule.",
    );
  });

  it("surfaces session-only storage failures and their real placement retry", async () => {
    const user = userEvent.setup();
    const source = sessionHarness();
    await source.session.initialize();
    await source.session.captureAndPlace(SOURCE, HOME_MOVE_IDS.budget);
    const confirmed = source.session.getSnapshot();
    if (!confirmed.activeSourceId)
      throw new Error("Expected a durable source.");

    const failedSnapshot: WorldstateSessionSnapshot = {
      ...confirmed,
      persistenceState: "unavailable",
      persistenceDetail:
        "The browser ledger could not save the placement result.",
      operationState: "idle",
      error: {
        code: "storage_unavailable",
        message: "The IndexedDB transaction was aborted.",
        retryable: true,
        scope: "placement",
      },
      retry: {
        operation: "placement",
        sourceId: confirmed.activeSourceId,
        selectedNodeId: HOME_MOVE_IDS.budget,
      },
    };
    const staticHarness = staticSession(failedSnapshot);
    const { container } = render(
      <WorldstateWorkbench
        autoInitialize={false}
        session={staticHarness.session}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "storage_unavailableThe IndexedDB transaction was aborted.",
    );
    expect(
      container.querySelector("[data-morphic-region='interpretation']"),
    ).toHaveAttribute("data-state-surface", "diagnostic-status-surface");
    const evidence = container.querySelector(
      "[data-morphic-region='evidence']",
    );
    expect(
      evidence?.querySelector("[data-state-family='knowledge']"),
    ).toHaveAttribute("data-state", "challenged");
    expect(
      evidence?.querySelector("[data-state-family='governance']"),
    ).toHaveTextContent("Failure blocks commit");
    expect(
      screen.getByRole("button", { name: "Adopt this placement" }),
    ).toBeDisabled();

    const retry = screen.getByRole("button", {
      name: "Retry from preserved source",
    });
    expect(retry).toBeEnabled();
    await user.click(retry);
    expect(staticHarness.retryPlacement).toHaveBeenCalledOnce();
  });

  it("keeps reviewed truth intact and exposes a semantic-commit retry", async () => {
    const user = userEvent.setup();
    const source = sessionHarness();
    await source.session.initialize();
    await source.session.captureAndPlace(SOURCE, HOME_MOVE_IDS.budget);
    const pending = source.session.getSnapshot();
    const failedSnapshot: WorldstateSessionSnapshot = {
      ...pending,
      persistenceState: "unavailable",
      persistenceDetail: "The semantic commit transaction was aborted.",
      operationState: "idle",
      error: {
        code: "storage_unavailable",
        message: "The semantic commit was not saved.",
        retryable: true,
        scope: "semantic_commit",
      },
      retry: null,
    };
    const staticHarness = staticSession(failedSnapshot);
    const { container } = render(
      <WorldstateWorkbench
        autoInitialize={false}
        session={staticHarness.session}
      />,
    );

    const receipt = container.querySelector(
      "[data-morphic-region='interpretation']",
    );
    expect(receipt).toHaveAttribute("data-state", "suggested");
    expect(receipt).toHaveAttribute(
      "data-state-surface",
      "provisional-status-surface",
    );
    expect(
      screen.getByText("The semantic commit was not saved."),
    ).toBeVisible();

    const retryCommit = screen.getByRole("button", {
      name: "Retry semantic commit",
    });
    expect(retryCommit).toBeEnabled();
    await user.click(retryCommit);
    expect(staticHarness.acceptActivePlacement).toHaveBeenCalledOnce();
  });

  it("does not relabel adopted truth when an atomic sandbox reset fails", async () => {
    const source = sessionHarness();
    await source.session.initialize();
    await source.session.captureAndPlace(SOURCE, HOME_MOVE_IDS.budget);
    await source.session.acceptActivePlacement();
    const adopted = source.session.getSnapshot();
    const resetFailure: WorldstateSessionSnapshot = {
      ...adopted,
      persistenceState: "unavailable",
      persistenceDetail:
        "Atomic reset failed; the prior ledger remains intact.",
      error: {
        code: "storage_unavailable",
        message: "Atomic reset failed.",
        retryable: true,
        scope: "reset",
      },
    };

    render(
      <WorldstateWorkbench
        autoInitialize={false}
        session={staticSession(resetFailure).session}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Placement adopted" }),
    ).toBeDisabled();
    expect(screen.getByText("Granted once")).toBeVisible();
    expect(
      screen.getByText("Atomic reset failed; the prior ledger remains intact."),
    ).toBeVisible();
    expect(screen.queryByText("Placement failed")).not.toBeInTheDocument();
  });

  it("rehydrates an unanswered durable request with a visible retry path", async () => {
    const user = userEvent.setup();
    const store = createMemoryWorldstateLedgerStore();
    let markGatewayStarted: (() => void) | undefined;
    const gatewayStarted = new Promise<void>((resolve) => {
      markGatewayStarted = resolve;
    });
    const unansweredGateway = vi.fn(async (): Promise<PlacementResponse> => {
      markGatewayStarted?.();
      return new Promise<PlacementResponse>(() => undefined);
    });
    const first = sessionHarness(store, unansweredGateway, "first-attempt");
    await first.session.initialize();
    void first.session.captureAndPlace(SOURCE, HOME_MOVE_IDS.goal);
    await gatewayStarted;

    const rehydrated = sessionHarness(
      store,
      fixtureGateway,
      "rehydrated-attempt",
    );
    await rehydrated.session.initialize();
    const { container } = render(
      <WorldstateWorkbench
        autoInitialize={false}
        session={rehydrated.session}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "placement_incomplete",
    );
    expect(screen.getByText((text) => text.includes(SOURCE))).toBeVisible();
    expect(
      container.querySelector("[data-morphic-root='worldstate-workbench']"),
    ).toHaveAttribute("data-selected-object-id", HOME_MOVE_IDS.goal);

    await user.click(
      screen.getByRole("button", { name: "Retry from preserved source" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Adopt this placement" }),
      ).toBeEnabled(),
    );
  });

  it("visibly disables sandbox reset while a session operation is busy", async () => {
    const source = sessionHarness();
    await source.session.initialize();
    const confirmed = source.session.getSnapshot();
    const busySnapshot: WorldstateSessionSnapshot = {
      ...confirmed,
      operationState: "placing",
      persistenceDetail: "Placement is in progress.",
    };
    const staticHarness = staticSession(busySnapshot);

    render(
      <WorldstateWorkbench
        autoInitialize={false}
        session={staticHarness.session}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Reset sandbox" }),
    ).toBeDisabled();
  });

  it("renders artifact promotion as a distinct human authority lane without secrets", () => {
    const fixture = createReplayClosureFixture();
    const base = buildWorkbenchViewModel({
      ledger: fixture.ledger,
      state: fixture.state,
      persistence: { state: "saved", detail: "Saved." },
    }).work;
    const work: WorkSurface = {
      ...base,
      artifactPromotion: {
        state: "proposed",
        canPropose: false,
        canPromote: true,
        gateReason:
          "Review the exact candidate before separate human promotion.",
        candidate: {
          id: `artifact-promotion:sha256:${"1".repeat(64)}`,
          candidateId: `artifact-candidate:sha256:${"2".repeat(64)}`,
          repositoryId: "repository-worldstate",
          targetRef: "refs/heads/main",
          expectedBaseCommit: "a".repeat(40),
          candidateCommit: "c".repeat(40),
          candidateTree: "d".repeat(40),
          manifestDigest: `sha256:${"e".repeat(64)}`,
          patchDigest: `sha256:${"f".repeat(64)}`,
          changedPaths: [
            { path: "demo/moving-costs.html", status: "modified" },
          ],
          integratedRevisionId: fixture.state.canonical.head.id,
          status: "proposed",
          observedTargetCommit: null,
          observedAt: null,
        },
      },
    };

    const { container } = render(
      <WorkPanel
        busy={false}
        integratingResult={false}
        onAuthorize={vi.fn()}
        onIntegrate={vi.fn()}
        onClearOperatorAuthority={vi.fn()}
        onOperatorCredentialChange={vi.fn()}
        onOperatorCredentialSubmit={vi.fn()}
        onPromoteArtifact={vi.fn()}
        onProposePromotion={vi.fn()}
        onProposeReconciliation={vi.fn()}
        onPrepare={vi.fn()}
        onValidate={vi.fn()}
        promotingArtifact={false}
        operatorCredentialDraft=""
        operatorCredentialReady={false}
        operatorCredentialRequired={false}
        proposingPromotion={false}
        proposingReconciliation={false}
        validatingEvidence={false}
        work={work}
      />,
    );

    const lane = container.querySelector(
      "[data-morphic-lane='artifact-promotion-boundary']",
    );
    expect(lane).toHaveAttribute(
      "data-authority-boundary",
      "human-artifact-promotion",
    );
    expect(
      screen.getByRole("button", { name: "Authorize exact ref promotion" }),
    ).toBeEnabled();
    expect(lane).toHaveTextContent("refs/heads/main");
    expect(lane).toHaveTextContent("demo/moving-costs.html");
    expect(lane?.textContent).not.toContain("hmac-sha256");
    expect(lane?.textContent).not.toContain("signingSecret");
  });
});
