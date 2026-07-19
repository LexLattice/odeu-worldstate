import { describe, expect, it } from "vitest";

import type { WorldstatePresentationState } from "@/components/worldstate/presentation";

import {
  OPENING_ONBOARDING_SCRIPT,
  OPENING_ONBOARDING_TARGETS,
  openingOnboardingPresentationCommand,
  openingOnboardingStepSatisfied,
} from "./opening-onboarding-script";

const presentation: WorldstatePresentationState = {
  projectId: OPENING_ONBOARDING_TARGETS.projectId,
  projectLabel: "Plan our home move",
  view: "outline",
  selectedObjectId: OPENING_ONBOARDING_TARGETS.goalId,
  selectedObjectLabel: "Complete the move for less than €4,000",
};

describe("opening onboarding script", () => {
  it("binds the opening chapter to presentation targets only", () => {
    expect(
      OPENING_ONBOARDING_SCRIPT.map((step) =>
        openingOnboardingPresentationCommand(step, `command:${step.id}`),
      ),
    ).toEqual([
      {
        id: "command:establish-project",
        type: "select_project",
        projectId: "project-home-move",
      },
      {
        id: "command:select-outline",
        type: "select_view",
        view: "outline",
      },
      {
        id: "command:select-goal",
        type: "select_object",
        objectId: "node-goal-under-4000",
      },
      null,
    ]);
  });

  it("derives step completion from observed presentation truth", () => {
    expect(
      OPENING_ONBOARDING_SCRIPT.map((step) =>
        openingOnboardingStepSatisfied(step, presentation),
      ),
    ).toEqual([true, true, true, true]);

    const mismatched: WorldstatePresentationState = {
      projectId: "project-something-else",
      projectLabel: "Something else",
      view: "map",
      selectedObjectId: "area-budget",
      selectedObjectLabel: "Budget",
    };
    expect(
      OPENING_ONBOARDING_SCRIPT.map((step) =>
        openingOnboardingStepSatisfied(step, mismatched),
      ),
    ).toEqual([false, false, false, true]);
    expect(
      OPENING_ONBOARDING_SCRIPT.map((step) =>
        openingOnboardingStepSatisfied(step, null),
      ),
    ).toEqual([false, false, false, false]);
  });
});
