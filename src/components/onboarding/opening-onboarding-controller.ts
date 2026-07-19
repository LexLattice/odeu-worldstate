import type {
  WorldstatePresentationCommand,
  WorldstatePresentationState,
} from "@/components/worldstate/presentation";

import {
  OPENING_ONBOARDING_SCRIPT,
  type OpeningOnboardingStep,
  openingOnboardingPresentationCommand,
  openingOnboardingStepSatisfied,
} from "./opening-onboarding-script";

export type OpeningOnboardingMode = "interactive" | "watch_only";

export type OpeningOnboardingPhase =
  | "consent"
  | "guiding"
  | "complete"
  | "skipped";

export interface OpeningOnboardingState {
  readonly phase: OpeningOnboardingPhase;
  readonly mode: OpeningOnboardingMode | null;
  readonly stepIndex: number;
  readonly paused: boolean;
  readonly captionsVisible: boolean;
  readonly commandGeneration: number;
}

export type OpeningOnboardingAction =
  | {
      readonly type: "choose_mode";
      readonly mode: OpeningOnboardingMode;
    }
  | {
      readonly type: "continue";
      readonly presentation: WorldstatePresentationState | null;
    }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | {
      readonly type: "set_captions";
      readonly visible: boolean;
    }
  | { readonly type: "skip" }
  | { readonly type: "replay" };

export interface OpeningOnboardingView {
  readonly phase: OpeningOnboardingPhase;
  readonly mode: OpeningOnboardingMode | null;
  readonly step: OpeningOnboardingStep | null;
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly paused: boolean;
  readonly captionsVisible: boolean;
  readonly audioState: "unavailable";
  readonly prerequisiteSatisfied: boolean;
  readonly canContinue: boolean;
  readonly presentationCommand: WorldstatePresentationCommand | null;
}

export function createOpeningOnboardingState(
  captionsVisible = true,
): OpeningOnboardingState {
  return {
    phase: "consent",
    mode: null,
    stepIndex: 0,
    paused: false,
    captionsVisible,
    commandGeneration: 0,
  };
}

export function reduceOpeningOnboarding(
  state: OpeningOnboardingState,
  action: OpeningOnboardingAction,
): OpeningOnboardingState {
  switch (action.type) {
    case "choose_mode":
      return state.phase === "consent"
        ? {
            ...state,
            phase: "guiding",
            mode: action.mode,
            stepIndex: 0,
            paused: false,
          }
        : state;
    case "continue": {
      if (state.phase !== "guiding" || state.paused) return state;
      const step = OPENING_ONBOARDING_SCRIPT[state.stepIndex];
      if (!step || !openingOnboardingStepSatisfied(step, action.presentation)) {
        return state;
      }
      if (state.stepIndex === OPENING_ONBOARDING_SCRIPT.length - 1) {
        return { ...state, phase: "complete", paused: false };
      }
      return { ...state, stepIndex: state.stepIndex + 1 };
    }
    case "pause":
      return state.phase === "guiding" && !state.paused
        ? { ...state, paused: true }
        : state;
    case "resume":
      return state.phase === "guiding" && state.paused
        ? { ...state, paused: false }
        : state;
    case "set_captions":
      return state.captionsVisible === action.visible
        ? state
        : { ...state, captionsVisible: action.visible };
    case "skip":
      return state.phase === "skipped"
        ? state
        : { ...state, phase: "skipped", paused: false };
    case "replay":
      return state.phase === "complete" && state.mode
        ? {
            ...state,
            phase: "guiding",
            stepIndex: 0,
            paused: false,
            commandGeneration: state.commandGeneration + 1,
          }
        : state;
  }
}

export function deriveOpeningOnboardingView(
  state: OpeningOnboardingState,
  presentation: WorldstatePresentationState | null,
): OpeningOnboardingView {
  const step =
    state.phase === "guiding"
      ? (OPENING_ONBOARDING_SCRIPT[state.stepIndex] ?? null)
      : null;
  const prerequisiteSatisfied = step
    ? openingOnboardingStepSatisfied(step, presentation)
    : false;
  const commandId = step
    ? `opening-onboarding:${state.commandGeneration}:${step.id}`
    : "";
  const presentationCommand =
    step &&
    state.mode === "watch_only" &&
    !state.paused &&
    !prerequisiteSatisfied
      ? openingOnboardingPresentationCommand(step, commandId)
      : null;

  return {
    phase: state.phase,
    mode: state.mode,
    step,
    stepNumber: step ? state.stepIndex + 1 : 0,
    stepCount: OPENING_ONBOARDING_SCRIPT.length,
    paused: state.paused,
    captionsVisible: state.captionsVisible,
    audioState: "unavailable",
    prerequisiteSatisfied,
    canContinue:
      state.phase === "guiding" && !state.paused && prerequisiteSatisfied,
    presentationCommand,
  };
}
