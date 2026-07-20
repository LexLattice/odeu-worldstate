import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import type {
  WorldstatePresentationCommand,
  WorldstatePresentationState,
} from "@/components/worldstate/presentation";

import type { OpeningOnboardingMode } from "./opening-onboarding-controller";
import {
  adoptedSemanticPlacementObserved,
  reviewableSemanticAdoptionObserved,
  SEMANTIC_ADOPTION_ONBOARDING_SCRIPT,
  semanticAdoptionPresentationCommand,
  semanticAdoptionStepSatisfied,
  type SemanticAdoptionOnboardingStep,
} from "./semantic-adoption-onboarding-script";
import type { ReviewablePlacementHandoff } from "./source-placement-onboarding-controller";

export type SemanticAdoptionOnboardingPhase =
  | "inactive"
  | "guiding"
  | "complete"
  | "skipped";

export type AdoptedPlacementHandoff = Omit<
  ReviewablePlacementHandoff,
  "headRevisionId"
> & {
  readonly priorHeadRevisionId: string;
  readonly acceptedRevisionId: string;
  readonly headRevisionId: string;
};

export interface SemanticAdoptionOnboardingState {
  readonly phase: SemanticAdoptionOnboardingPhase;
  readonly mode: OpeningOnboardingMode | null;
  readonly stepIndex: number;
  readonly paused: boolean;
  readonly captionsVisible: boolean;
  readonly commandGeneration: number;
  readonly placementHandoff: ReviewablePlacementHandoff | null;
  readonly adoptedHandoff: AdoptedPlacementHandoff | null;
}

export type SemanticAdoptionOnboardingAction =
  | {
      readonly type: "start";
      readonly mode: OpeningOnboardingMode;
      readonly captionsVisible: boolean;
      readonly placementHandoff: ReviewablePlacementHandoff | null;
      readonly placement: WorldstatePlacementObservation | null;
    }
  | {
      readonly type: "continue";
      readonly placement: WorldstatePlacementObservation | null;
      readonly presentation: WorldstatePresentationState | null;
    }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set_captions"; readonly visible: boolean }
  | { readonly type: "skip" };

export interface SemanticAdoptionOnboardingView {
  readonly phase: SemanticAdoptionOnboardingPhase;
  readonly mode: OpeningOnboardingMode | null;
  readonly step: SemanticAdoptionOnboardingStep | null;
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly paused: boolean;
  readonly captionsVisible: boolean;
  readonly audioState: "unavailable";
  readonly prerequisiteSatisfied: boolean;
  readonly canContinue: boolean;
  readonly presentationCommand: WorldstatePresentationCommand | null;
  readonly placementHandoff: ReviewablePlacementHandoff | null;
  readonly adoptedHandoff: AdoptedPlacementHandoff | null;
}

export function createSemanticAdoptionOnboardingState(
  captionsVisible = true,
): SemanticAdoptionOnboardingState {
  return {
    phase: "inactive",
    mode: null,
    stepIndex: 0,
    paused: false,
    captionsVisible,
    commandGeneration: 0,
    placementHandoff: null,
    adoptedHandoff: null,
  };
}

export function canStartSemanticAdoptionOnboarding(input: {
  readonly placementHandoff: ReviewablePlacementHandoff | null;
  readonly placement: WorldstatePlacementObservation | null;
}): boolean {
  return reviewableSemanticAdoptionObserved(
    input.placement,
    input.placementHandoff,
  );
}

function adoptedHandoff(
  placement: WorldstatePlacementObservation | null,
  handoff: ReviewablePlacementHandoff | null,
): AdoptedPlacementHandoff | null {
  if (
    !adoptedSemanticPlacementObserved(placement, handoff) ||
    !placement?.acceptedRevisionId ||
    !placement.headRevisionId ||
    !handoff
  ) {
    return null;
  }

  return Object.freeze({
    sourceId: handoff.sourceId,
    requestId: handoff.requestId,
    requestSelectedNodeId: handoff.requestSelectedNodeId,
    attemptId: handoff.attemptId,
    exchangeId: handoff.exchangeId,
    receiptId: handoff.receiptId,
    deltaId: handoff.deltaId,
    candidateId: handoff.candidateId,
    locationTargetNodeId: handoff.locationTargetNodeId,
    baseRevisionId: handoff.baseRevisionId,
    priorHeadRevisionId: handoff.headRevisionId,
    acceptedRevisionId: placement.acceptedRevisionId,
    headRevisionId: placement.headRevisionId,
    managerMode: handoff.managerMode,
    managerLabel: handoff.managerLabel,
  });
}

export function reduceSemanticAdoptionOnboarding(
  state: SemanticAdoptionOnboardingState,
  action: SemanticAdoptionOnboardingAction,
): SemanticAdoptionOnboardingState {
  switch (action.type) {
    case "start":
      return state.phase === "inactive" &&
        canStartSemanticAdoptionOnboarding(action)
        ? {
            ...state,
            phase: "guiding",
            mode: action.mode,
            stepIndex: 0,
            paused: false,
            captionsVisible: action.captionsVisible,
            placementHandoff: action.placementHandoff,
            adoptedHandoff: null,
          }
        : state;
    case "continue": {
      if (state.phase !== "guiding" || state.paused) return state;
      const step = SEMANTIC_ADOPTION_ONBOARDING_SCRIPT[state.stepIndex];
      if (
        !step ||
        !semanticAdoptionStepSatisfied(step, {
          handoff: state.placementHandoff,
          placement: action.placement,
          presentation: action.presentation,
        })
      ) {
        return state;
      }

      if (state.stepIndex === SEMANTIC_ADOPTION_ONBOARDING_SCRIPT.length - 1) {
        const handoff = adoptedHandoff(
          action.placement,
          state.placementHandoff,
        );
        return handoff
          ? {
              ...state,
              phase: "complete",
              paused: false,
              adoptedHandoff: handoff,
            }
          : state;
      }

      return { ...state, stepIndex: state.stepIndex + 1 };
    }
    case "pause":
      return state.phase === "guiding" && !state.paused
        ? { ...state, paused: true }
        : state;
    case "resume":
      return state.phase === "guiding" && state.paused
        ? {
            ...state,
            paused: false,
            commandGeneration: state.commandGeneration + 1,
          }
        : state;
    case "set_captions":
      return state.captionsVisible === action.visible
        ? state
        : { ...state, captionsVisible: action.visible };
    case "skip":
      return state.phase === "skipped"
        ? state
        : { ...state, phase: "skipped", paused: false };
  }
}

export function deriveSemanticAdoptionOnboardingView(
  state: SemanticAdoptionOnboardingState,
  input: {
    readonly placement: WorldstatePlacementObservation | null;
    readonly presentation: WorldstatePresentationState | null;
  },
): SemanticAdoptionOnboardingView {
  const step =
    state.phase === "guiding"
      ? (SEMANTIC_ADOPTION_ONBOARDING_SCRIPT[state.stepIndex] ?? null)
      : null;
  const prerequisiteSatisfied = step
    ? semanticAdoptionStepSatisfied(step, {
        handoff: state.placementHandoff,
        placement: input.placement,
        presentation: input.presentation,
      })
    : false;
  const presentationCommand =
    step &&
    step.id !== "adopt-placement" &&
    state.mode === "watch_only" &&
    !state.paused &&
    reviewableSemanticAdoptionObserved(
      input.placement,
      state.placementHandoff,
    )
      ? semanticAdoptionPresentationCommand(step, {
          commandId: `semantic-adoption-onboarding:${state.commandGeneration}:${step.id}`,
          presentation: input.presentation,
          handoff: state.placementHandoff,
        })
      : null;

  return {
    phase: state.phase,
    mode: state.mode,
    step,
    stepNumber: step ? state.stepIndex + 1 : 0,
    stepCount: SEMANTIC_ADOPTION_ONBOARDING_SCRIPT.length,
    paused: state.paused,
    captionsVisible: state.captionsVisible,
    audioState: "unavailable",
    prerequisiteSatisfied,
    canContinue:
      state.phase === "guiding" && !state.paused && prerequisiteSatisfied,
    presentationCommand,
    placementHandoff: state.placementHandoff,
    adoptedHandoff: state.adoptedHandoff,
  };
}
