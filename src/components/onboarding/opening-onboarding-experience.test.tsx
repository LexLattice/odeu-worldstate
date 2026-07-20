import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorldstatePresentationCommand,
  WorldstatePresentationState,
} from "@/components/worldstate/presentation";
import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";

import { OpeningOnboardingExperience } from "./opening-onboarding-experience";

const workbenchHarness = vi.hoisted(() => ({ props: null as unknown }));

vi.mock("@/components/worldstate/worldstate-workbench", () => ({
  WorldstateWorkbench: (props: unknown) => {
    workbenchHarness.props = props;
    return (
      <main
        aria-label="Worldstate workbench"
        data-presentation-focus-target="workbench"
        data-testid="worldstate-workbench"
        tabIndex={-1}
      >
        <header data-morphic-region="scope">Plan our home move</header>
        <button id="projection-tab-outline" type="button">
          Outline
        </button>
        <button data-worldstate-id="node-goal-under-4000" type="button">
          Complete the move for less than €4,000
        </button>
        <textarea aria-label="Source text" />
        <h2 data-placement-focus-target="receipt" tabIndex={-1}>
          Placement receipt
        </h2>
      </main>
    );
  },
}));

interface MockWorkbenchProps {
  readonly mutationAccess?:
    | "enabled"
    | "presentation-only"
    | "guided-capture"
    | "guided-adoption";
  readonly onOperationBusyChange?: (busy: boolean) => void;
  readonly onPlacementObservationChange?: (
    observation: WorldstatePlacementObservation,
  ) => void;
  readonly presentationCommand?: WorldstatePresentationCommand;
  readonly onPresentationStateChange?: (
    state: WorldstatePresentationState,
  ) => void;
}

const OTHER_PRESENTATION: WorldstatePresentationState = {
  projectId: "another-project",
  projectLabel: "Another project",
  view: "map",
  selectedObjectId: "node-area-budget",
  selectedObjectLabel: "Budget",
};

const COMPLETE_PRESENTATION: WorldstatePresentationState = {
  projectId: "project-home-move",
  projectLabel: "Plan our home move",
  view: "outline",
  selectedObjectId: "node-goal-under-4000",
  selectedObjectLabel: "Complete the move for less than €4,000",
};

const IDLE_PLACEMENT: WorldstatePlacementObservation = {
  state: "idle",
  operationState: "idle",
  persistenceState: "saved",
  sourceId: null,
  requestId: null,
  requestSelectedNodeId: null,
  attemptId: null,
  exchangeId: null,
  receiptId: null,
  deltaId: null,
  candidateId: null,
  locationTargetNodeId: null,
  baseRevisionId: null,
  acceptedRevisionId: null,
  headRevisionId: "revision-home-move-seed",
  managerMode: "fixture",
  managerLabel: "Fixture placement manager",
  retryable: false,
  canAccept: false,
};

const REVIEWABLE_BUDGET_PLACEMENT: WorldstatePlacementObservation = {
  ...IDLE_PLACEMENT,
  state: "reviewable",
  sourceId: "source-guided-placement",
  requestId: "request-guided-placement",
  requestSelectedNodeId: "node-area-budget",
  attemptId: "source-placement-attempt:request-guided-placement",
  exchangeId: "source-placement-exchange:request-guided-placement",
  receiptId: "receipt-guided-placement",
  deltaId: "delta-guided-placement",
  candidateId: "node-guided-placement",
  locationTargetNodeId: "node-area-budget",
  baseRevisionId: "revision-home-move-seed",
  canAccept: true,
};

const ADOPTED_BUDGET_PLACEMENT: WorldstatePlacementObservation = {
  ...REVIEWABLE_BUDGET_PLACEMENT,
  state: "adopted",
  acceptedRevisionId: "revision-guided-adoption",
  headRevisionId: "revision-guided-adoption",
  canAccept: false,
};

function workbenchProps(): MockWorkbenchProps {
  return workbenchHarness.props as MockWorkbenchProps;
}

function reportPresentation(state: WorldstatePresentationState) {
  act(() => {
    workbenchProps().onPresentationStateChange?.(state);
  });
}

function reportOperationBusy(busy: boolean) {
  act(() => {
    workbenchProps().onOperationBusyChange?.(busy);
  });
}

function reportPlacement(observation: WorldstatePlacementObservation) {
  act(() => {
    workbenchProps().onPlacementObservationChange?.(observation);
  });
}

afterEach(() => {
  cleanup();
  workbenchHarness.props = null;
});

describe("OpeningOnboardingExperience", () => {
  it("requires an explicit mode choice before mounting the operable workbench", async () => {
    const user = userEvent.setup();
    render(<OpeningOnboardingExperience />);

    expect(
      screen.getByRole("heading", {
        name: "See the project before changing it.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("worldstate-workbench")).not.toBeInTheDocument();
    expect(
      screen.getByText("Unavailable · captions provided"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Interactive/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Watch only/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Skip$/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /^Skip$/i }));

    expect(screen.getByTestId("worldstate-workbench")).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: "Meet the sandbox project" }),
    ).not.toBeInTheDocument();
    expect(workbenchProps().presentationCommand).toBeUndefined();
    expect(workbenchProps().mutationAccess).toBe("enabled");
  });

  it("keeps interactive progress observed, user-paced, pausable, and captioned", async () => {
    const user = userEvent.setup();
    render(<OpeningOnboardingExperience />);

    await user.click(screen.getByRole("button", { name: /Interactive/i }));

    expect(workbenchProps().mutationAccess).toBe("presentation-only");
    expect(
      screen.getByRole("heading", { name: "Meet the sandbox project" }),
    ).toHaveFocus();
    expect(
      screen.getByText("Narration audio is unavailable in this build."),
    ).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
    expect(workbenchProps().presentationCommand).toBeUndefined();

    reportPresentation(OTHER_PRESENTATION);
    expect(continueButton).toBeDisabled();
    expect(screen.getByTitle("another-project")).toHaveTextContent(
      "Another project",
    );
    expect(screen.getByTitle("node-area-budget")).toHaveTextContent("Budget");
    expect(
      screen.getByText("Select the seeded Plan our home move project."),
    ).toBeInTheDocument();

    reportPresentation({
      ...OTHER_PRESENTATION,
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
    });
    expect(continueButton).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(continueButton).toBeDisabled();
    expect(
      screen.getByText(/Guidance is paused\. Resume to continue/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide captions" }));
    expect(
      screen.getByText(/Captions hidden\. Use Show captions/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Narration audio is unavailable in this build."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show captions" }));
    expect(
      screen.getByText(/This is a temporary sandbox/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(continueButton).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Skip guide" }));
    expect(workbenchProps().mutationAccess).toBe("enabled");
    expect(screen.getByTestId("worldstate-workbench")).toHaveFocus();
  });

  it("uses only typed watch-only presentation commands and exposes replay after handoff", async () => {
    const user = userEvent.setup();
    render(<OpeningOnboardingExperience />);

    await user.click(screen.getByRole("button", { name: /Watch only/i }));

    expect(workbenchProps().presentationCommand).toEqual({
      id: "opening-onboarding:0:establish-project",
      type: "select_project",
      projectId: "project-home-move",
    });

    reportPresentation({
      ...OTHER_PRESENTATION,
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "See the project structure" }),
    ).toHaveFocus();
    expect(workbenchProps().presentationCommand).toEqual({
      id: "opening-onboarding:0:select-outline",
      type: "select_view",
      view: "outline",
    });

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(workbenchProps().presentationCommand).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(workbenchProps().presentationCommand).toMatchObject({
      type: "select_view",
      view: "outline",
    });

    reportPresentation({
      ...OTHER_PRESENTATION,
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
      view: "outline",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Find the governing goal" }),
    ).toHaveFocus();
    expect(workbenchProps().presentationCommand).toEqual({
      id: "opening-onboarding:0:select-goal",
      type: "select_object",
      objectId: "node-goal-under-4000",
    });

    reportPresentation(COMPLETE_PRESENTATION);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Bring in an ordinary idea" }),
    ).toHaveFocus();
    expect(workbenchProps().presentationCommand).toBeUndefined();
    expect(workbenchProps().mutationAccess).toBe("presentation-only");

    await user.click(screen.getByRole("button", { name: "Finish opening" }));
    expect(
      screen.getByRole("heading", {
        name: "Opening complete · choose the next boundary",
      }),
    ).toHaveFocus();
    expect(screen.getByTestId("worldstate-workbench")).toBeInTheDocument();
    expect(workbenchProps().mutationAccess).toBe("presentation-only");
    expect(
      screen.getByRole("button", { name: "Start guided placement" }),
    ).toBeDisabled();

    const replayButton = screen.getByRole("button", {
      name: "Replay opening",
    });
    reportOperationBusy(true);
    expect(replayButton).toBeDisabled();
    expect(replayButton).toHaveAccessibleDescription(
      /The workbench is still reporting its state/i,
    );
    reportOperationBusy(false);
    expect(replayButton).toBeEnabled();
    await user.click(replayButton);
    expect(
      screen.getByRole("heading", { name: "Meet the sandbox project" }),
    ).toHaveFocus();
    expect(workbenchProps().presentationCommand).toBeUndefined();
    expect(workbenchProps().mutationAccess).toBe("presentation-only");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Finish opening" }));
    await user.click(screen.getByRole("button", { name: "Close guide" }));

    expect(
      screen.queryByText("Opening complete · choose the next boundary"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("worldstate-workbench")).toHaveFocus();
    expect(workbenchProps().mutationAccess).toBe("enabled");
  });

  it("uses typed Budget selection, user-owned capture, and an explicit receipt review before restoring adoption", async () => {
    const user = userEvent.setup();
    render(<OpeningOnboardingExperience />);

    await user.click(screen.getByRole("button", { name: /Watch only/i }));
    reportPlacement(IDLE_PLACEMENT);
    reportPresentation({
      ...OTHER_PRESENTATION,
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    reportPresentation({
      ...OTHER_PRESENTATION,
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
      view: "outline",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    reportPresentation(COMPLETE_PRESENTATION);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Finish opening" }));

    expect(workbenchProps().mutationAccess).toBe("presentation-only");
    await user.click(
      screen.getByRole("button", { name: "Start guided placement" }),
    );

    expect(workbenchProps().mutationAccess).toBe("guided-capture");
    expect(workbenchProps().presentationCommand).toEqual({
      id: "source-placement-onboarding:0:select-budget-context",
      type: "select_object",
      objectId: "node-area-budget",
    });
    expect(
      screen.getByRole("heading", { name: "Set the placement context" }),
    ).toHaveFocus();

    reportPresentation({
      ...COMPLETE_PRESENTATION,
      selectedObjectId: "node-area-budget",
      selectedObjectLabel: "Budget",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(workbenchProps().presentationCommand).toBeUndefined();
    expect(
      screen.getByRole("heading", {
        name: "Save the idea, then ask where it fits",
      }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Waiting for placement" }),
    ).toBeDisabled();

    reportPlacement(REVIEWABLE_BUDGET_PLACEMENT);
    const reviewButton = screen.getByRole("button", {
      name: "Review placement",
    });
    expect(reviewButton).toBeEnabled();
    expect(screen.getByText("Reviewable · provisional")).toBeVisible();
    expect(screen.getByText(/Unchanged · revision-home-move-seed/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Placement receipt" })).not.toHaveFocus();

    await user.click(reviewButton);
    expect(
      screen.getByRole("heading", { name: "Placement receipt" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("heading", {
        name: "Review the interpretation before mutation",
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Finish source chapter" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "Source placement reviewed · decision remains separate",
      }),
    ).toHaveFocus();
    expect(workbenchProps().mutationAccess).toBe("guided-capture");

    await user.click(screen.getByRole("button", { name: "Close guide" }));
    expect(workbenchProps().mutationAccess).toBe("enabled");
    expect(screen.getByTestId("worldstate-workbench")).toHaveFocus();
  });

  it("reviews one candidate across four views before enabling one explicit semantic commit", async () => {
    const user = userEvent.setup();
    render(<OpeningOnboardingExperience />);

    await user.click(screen.getByRole("button", { name: /Watch only/i }));
    reportPlacement(IDLE_PLACEMENT);
    reportPresentation({
      ...OTHER_PRESENTATION,
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    reportPresentation({
      ...OTHER_PRESENTATION,
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
      view: "outline",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    reportPresentation(COMPLETE_PRESENTATION);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Finish opening" }));
    await user.click(
      screen.getByRole("button", { name: "Start guided placement" }),
    );
    reportPresentation({
      ...COMPLETE_PRESENTATION,
      selectedObjectId: "node-area-budget",
      selectedObjectLabel: "Budget",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    reportPlacement(REVIEWABLE_BUDGET_PLACEMENT);
    await user.click(screen.getByRole("button", { name: "Review placement" }));
    await user.click(
      screen.getByRole("button", { name: "Finish source chapter" }),
    );

    const startAdoption = screen.getByRole("button", {
      name: "Continue to adoption review",
    });
    expect(startAdoption).toBeEnabled();
    await user.click(startAdoption);

    expect(workbenchProps().mutationAccess).toBe("presentation-only");
    expect(
      screen.getByRole("heading", { name: "See where the candidate belongs" }),
    ).toHaveFocus();
    expect(workbenchProps().presentationCommand).toEqual({
      id: "semantic-adoption-onboarding:0:review-outline:select-candidate",
      type: "select_object",
      objectId: "node-guided-placement",
    });

    const candidatePresentation: WorldstatePresentationState = {
      ...COMPLETE_PRESENTATION,
      selectedObjectId: "node-guided-placement",
      selectedObjectLabel: "Compare moving quotes",
    };
    reportPresentation(candidatePresentation);
    expect(workbenchProps().presentationCommand).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(workbenchProps().presentationCommand).toMatchObject({
      type: "select_view",
      view: "map",
    });

    reportPresentation({ ...candidatePresentation, view: "map" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(workbenchProps().presentationCommand).toMatchObject({
      type: "select_view",
      view: "timeline",
    });

    reportPresentation({ ...candidatePresentation, view: "timeline" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(workbenchProps().presentationCommand).toMatchObject({
      type: "select_view",
      view: "focus",
    });

    reportPresentation({ ...candidatePresentation, view: "focus" });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(workbenchProps().mutationAccess).toBe("guided-adoption");
    expect(workbenchProps().presentationCommand).toBeUndefined();
    expect(
      screen.getByRole("heading", {
        name: "Choose whether this interpretation becomes project truth",
      }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Waiting for adoption" }),
    ).toBeDisabled();

    reportPlacement({
      ...REVIEWABLE_BUDGET_PLACEMENT,
      deltaId: "delta-unreviewed-placement",
    });
    expect(workbenchProps().mutationAccess).toBe("presentation-only");
    expect(
      screen.getByText(/frozen placement no longer satisfies/i),
    ).toBeVisible();

    reportPlacement(REVIEWABLE_BUDGET_PLACEMENT);
    expect(workbenchProps().mutationAccess).toBe("guided-adoption");

    reportPlacement({
      ...REVIEWABLE_BUDGET_PLACEMENT,
      operationState: "accepting",
      persistenceState: "saving",
      canAccept: false,
    });
    expect(
      screen.getByText(/Saving the human semantic commit/i),
    ).toBeVisible();

    reportPlacement(ADOPTED_BUDGET_PLACEMENT);
    const finishAdoption = screen.getByRole("button", {
      name: "Finish adoption chapter",
    });
    expect(finishAdoption).toBeEnabled();
    await user.click(finishAdoption);

    expect(
      screen.getByRole("heading", {
        name: "Semantic update adopted · agent authority remains separate",
      }),
    ).toHaveFocus();
    expect(screen.getByText(/revision-guided-adoption/)).toBeVisible();
    expect(workbenchProps().mutationAccess).toBe("guided-adoption");

    reportPlacement({
      ...REVIEWABLE_BUDGET_PLACEMENT,
      deltaId: "delta-after-completion",
    });
    expect(workbenchProps().mutationAccess).toBe("presentation-only");

    await user.click(screen.getByRole("button", { name: "Close guide" }));
    expect(workbenchProps().mutationAccess).toBe("enabled");
    expect(screen.getByTestId("worldstate-workbench")).toHaveFocus();
  });
});
