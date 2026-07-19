import {
  type WorldstatePresentationCommand,
  type WorldstatePresentationState,
  worldstatePresentationCommandSatisfied,
} from "@/components/worldstate/presentation";

export const OPENING_ONBOARDING_TARGETS = {
  projectId: "project-home-move",
  goalId: "node-goal-under-4000",
} as const;

export type OpeningOnboardingStepId =
  | "establish-project"
  | "select-outline"
  | "select-goal"
  | "source-capture-handoff";

export type OpeningOnboardingPresentationTarget =
  | {
      readonly type: "select_project";
      readonly projectId: string;
    }
  | {
      readonly type: "select_view";
      readonly view: "outline";
    }
  | {
      readonly type: "select_object";
      readonly objectId: string;
    };

export interface OpeningOnboardingStep {
  readonly id: OpeningOnboardingStepId;
  readonly title: string;
  readonly caption: string;
  readonly prerequisite: string;
  readonly target: OpeningOnboardingPresentationTarget | null;
}

export const OPENING_ONBOARDING_SCRIPT: readonly OpeningOnboardingStep[] = [
  {
    id: "establish-project",
    title: "Meet the sandbox project",
    caption:
      "This is a temporary sandbox. Plan our home move is already seeded here, and this guide will not add to or rewrite it.",
    prerequisite: "Select the seeded Plan our home move project.",
    target: {
      type: "select_project",
      projectId: OPENING_ONBOARDING_TARGETS.projectId,
    },
  },
  {
    id: "select-outline",
    title: "See the project structure",
    caption:
      "Outline keeps the project, its goals, and its working areas together in one structured view.",
    prerequisite: "Select Outline view.",
    target: { type: "select_view", view: "outline" },
  },
  {
    id: "select-goal",
    title: "Find the governing goal",
    caption:
      "Complete the move for less than €4,000 is part of the current project state. Later ideas can be interpreted against this goal without changing it first.",
    prerequisite: "Select the under-€4,000 goal.",
    target: {
      type: "select_object",
      objectId: OPENING_ONBOARDING_TARGETS.goalId,
    },
  },
  {
    id: "source-capture-handoff",
    title: "Bring in an ordinary idea",
    caption:
      "You are ready to capture an idea in your own words. The opening guide stops here, before any source is saved or interpreted.",
    prerequisite: "Continue to the unchanged source-capture workbench.",
    target: null,
  },
] as const;

export function openingOnboardingPresentationCommand(
  step: OpeningOnboardingStep,
  commandId: string,
): WorldstatePresentationCommand | null {
  if (!step.target) return null;

  switch (step.target.type) {
    case "select_project":
      return {
        id: commandId,
        type: "select_project",
        projectId: step.target.projectId,
      };
    case "select_view":
      return {
        id: commandId,
        type: "select_view",
        view: step.target.view,
      };
    case "select_object":
      return {
        id: commandId,
        type: "select_object",
        objectId: step.target.objectId,
      };
  }
}

export function openingOnboardingStepSatisfied(
  step: OpeningOnboardingStep,
  presentation: WorldstatePresentationState | null,
): boolean {
  if (!presentation) return false;
  const command = openingOnboardingPresentationCommand(
    step,
    `onboarding-satisfaction:${step.id}`,
  );
  return command
    ? worldstatePresentationCommandSatisfied(command, presentation)
    : true;
}
