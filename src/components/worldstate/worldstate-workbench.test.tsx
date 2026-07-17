import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PlacementErrorResponseSchema,
  PlacementSuccessResponseSchema,
  placeSource,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  createMemoryWorldstateLedgerStore,
  type ProjectLedgerStore,
} from "@/adapters/storage";
import {
  createWorldstateSession,
  type WorldstateSession,
  type WorldstateSessionSnapshot,
} from "@/application/worldstate-session";
import type { LedgerEvent } from "@/domain";
import { HOME_MOVE_IDS } from "@/fixtures";

import { WorldstateWorkbench } from "./worldstate-workbench";

const SOURCE =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";

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
      now: () =>
        new Date(Date.UTC(2026, 6, 17, 10, 0, 0, tick++)).toISOString(),
      nextId: (kind) => `${kind}:${idSeed}-${++id}`,
    }),
  };
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
      resetSandbox: async () => undefined,
    },
  };
}

describe("WorldstateWorkbench", () => {
  it("keeps the selected kernel object stable while the projection changes", async () => {
    const user = userEvent.setup();
    const { session } = sessionHarness();
    const { container } = render(<WorldstateWorkbench session={session} />);

    await user.click(
      await screen.findByRole("button", {
        name: /Complete the move for less than €4,000/i,
      }),
    );
    const root = container.querySelector("[data-morphic-root='worldstate-workbench']");
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

    const capture = await screen.findByRole("button", { name: "Capture & place" });
    const root = container.querySelector("[data-morphic-root='worldstate-workbench']");
    const originalRevision = root?.getAttribute("data-worldstate-revision");
    await user.click(capture);

    const accept = await screen.findByRole("button", {
      name: "Adopt this placement",
    });
    await waitFor(() => expect(accept).toBeEnabled());
    expect(root).toHaveAttribute("data-worldstate-revision", originalRevision);
    expect(screen.getByText("Agent execution unavailable in this slice")).toBeVisible();
    expect(screen.getByText("Alternative placement")).toBeVisible();

    const pending = session.getSnapshot();
    expect(pending.activeDeltaId).not.toBeNull();
    expect(pending.state?.canonical.head.id).toBe(
      pending.state?.operational.deltas[pending.activeDeltaId as string].delta
        .baseRevisionId,
    );
    expect(Object.keys(pending.state?.operational.briefs ?? {})).toHaveLength(0);
    expect(Object.keys(pending.state?.operational.runs ?? {})).toHaveLength(0);
    expect(Object.keys(pending.state?.operational.closures ?? {})).toHaveLength(0);

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

    const accepted = session.getSnapshot();
    expect(
      accepted.ledger?.events.filter((event) => event.type === "source.captured"),
    ).toHaveLength(3);
    expect(
      accepted.ledger?.events.filter((event) => event.type === "delta.accepted"),
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

    const durableRevision = first.session.getSnapshot().state?.canonical.head.id;
    const durableCandidate = first.session.getSnapshot().activeDeltaId
      ? first.session
          .getSnapshot()
          .state?.operational.deltas[first.session.getSnapshot().activeDeltaId as string]
          .delta.operations.find((operation) => operation.op === "node.add")?.node.id
      : null;
    firstRender.unmount();

    const second = sessionHarness(first.store);
    const { container } = render(<WorldstateWorkbench session={second.session} />);
    await screen.findByRole("button", { name: "Placement adopted" });

    expect(second.session.getSnapshot().state?.canonical.head.id).toBe(
      durableRevision,
    );
    expect(container.querySelector("[data-morphic-root='worldstate-workbench']")).toHaveAttribute(
      "data-selected-object-id",
      durableCandidate,
    );
    expect(screen.getByText((text) => text.includes(SOURCE))).toBeVisible();
    expect(screen.getByText("Deterministic fixture manager")).toBeVisible();
  });

  it("keeps evidence before commit and exposes truthful unavailable Work", async () => {
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

    const evidence = container.querySelector("[data-morphic-region='evidence']");
    const commit = container.querySelector(
      "[data-morphic-region='semantic-commit']",
    );
    expect(
      evidence && commit
        ? evidence.compareDocumentPosition(commit) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
    expect(
      container.querySelector("[data-action-cluster='agent-delegation']"),
    ).toHaveAttribute("data-gate-state", "unavailable");
    expect(screen.getByText(/not wired for this persisted source/i)).toBeVisible();
  });

  it("keeps linked-record counts and epistemic status hooks aligned with visible truth", async () => {
    const user = userEvent.setup();
    const { session } = sessionHarness();
    const { container } = render(<WorldstateWorkbench session={session} />);

    await screen.findByRole("button", { name: "Capture & place" });
    expect(screen.getByText("01 linked record")).toBeVisible();

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

    expect(screen.getByText("04 linked records")).toBeVisible();
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

    expect(await screen.findByText("03 linked records")).toBeVisible();
    expect(
      screen.getByText(/^source-placement-exchange:/),
    ).toBeVisible();
    expect(
      screen.queryByText("No persisted manager exchange yet"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Live manager failed · OpenAI · gpt-test")).toBeVisible();
  });

  it("renders every uncertainty and the declared severity of every conflict", async () => {
    const user = userEvent.setup();
    const nuancedGateway = async (
      request: PlacementRequest,
    ): Promise<PlacementResponse> => {
      const fixture = await fixtureGateway(request);
      if (!fixture.ok) throw new Error("Expected the fixture placement to succeed.");

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

    expect(screen.getByText("Storage recurrence remains undecided.")).toBeVisible();
    expect(
      screen.getByText("Provider tax handling still needs review."),
    ).toBeVisible();
    expect(container.querySelector("[data-severity='notice']")).toHaveTextContent(
      "NoticeBudget area — This is a notice-level overlap.",
    );
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
    if (!confirmed.activeSourceId) throw new Error("Expected a durable source.");

    const failedSnapshot: WorldstateSessionSnapshot = {
      ...confirmed,
      persistenceState: "unavailable",
      persistenceDetail: "The browser ledger could not save the placement result.",
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
    const evidence = container.querySelector("[data-morphic-region='evidence']");
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
    expect(screen.getByText("The semantic commit was not saved.")).toBeVisible();

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
      persistenceDetail: "Atomic reset failed; the prior ledger remains intact.",
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
    const unansweredGateway = vi.fn(
      async (): Promise<PlacementResponse> => {
        markGatewayStarted?.();
        return new Promise<PlacementResponse>(() => undefined);
      },
    );
    const first = sessionHarness(store, unansweredGateway, "first-attempt");
    await first.session.initialize();
    void first.session.captureAndPlace(SOURCE, HOME_MOVE_IDS.goal);
    await gatewayStarted;

    const rehydrated = sessionHarness(store, fixtureGateway, "rehydrated-attempt");
    await rehydrated.session.initialize();
    const { container } = render(
      <WorldstateWorkbench autoInitialize={false} session={rehydrated.session} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "placement_incomplete",
    );
    expect(screen.getByText((text) => text.includes(SOURCE))).toBeVisible();
    expect(container.querySelector("[data-morphic-root='worldstate-workbench']"))
      .toHaveAttribute("data-selected-object-id", HOME_MOVE_IDS.goal);

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
});
