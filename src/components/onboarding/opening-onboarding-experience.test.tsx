import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorldstatePresentationCommand,
  WorldstatePresentationState,
} from "@/components/worldstate/presentation";

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
      </main>
    );
  },
}));

interface MockWorkbenchProps {
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

function workbenchProps(): MockWorkbenchProps {
  return workbenchHarness.props as MockWorkbenchProps;
}

function reportPresentation(state: WorldstatePresentationState) {
  act(() => {
    workbenchProps().onPresentationStateChange?.(state);
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
  });

  it("keeps interactive progress observed, user-paced, pausable, and captioned", async () => {
    const user = userEvent.setup();
    render(<OpeningOnboardingExperience />);

    await user.click(screen.getByRole("button", { name: /Interactive/i }));

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

    await user.click(screen.getByRole("button", { name: "Finish opening" }));
    expect(
      screen.getByRole("heading", {
        name: "Opening complete · normal workbench available",
      }),
    ).toHaveFocus();
    expect(screen.getByTestId("worldstate-workbench")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replay opening" }));
    expect(
      screen.getByRole("heading", { name: "Meet the sandbox project" }),
    ).toHaveFocus();
    expect(workbenchProps().presentationCommand).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Finish opening" }));
    await user.click(screen.getByRole("button", { name: "Close guide" }));

    expect(
      screen.queryByText("Opening complete · normal workbench available"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("worldstate-workbench")).toHaveFocus();
  });
});
