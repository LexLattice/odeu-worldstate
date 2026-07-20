import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import type {
  WorldstatePresentationCommand,
  WorldstatePresentationState,
} from "@/components/worldstate/presentation";

import type { OpeningOnboardingMode } from "./opening-onboarding-controller";
import {
  reviewableSourcePlacementObserved,
  SOURCE_PLACEMENT_ONBOARDING_SCRIPT,
  SOURCE_PLACEMENT_ONBOARDING_TARGETS,
  type SourcePlacementOnboardingStep,
  sourcePlacementPresentationCommand,
  sourcePlacementStepSatisfied,
} from "./source-placement-onboarding-script";

export type SourcePlacementOnboardingPhase =
  | "inactive"
  | "guiding"
  | "complete"
  | "skipped";

export interface ReviewablePlacementHandoff {
  readonly sourceId: string;
  readonly requestId: string;
  readonly requestSelectedNodeId: string;
  readonly attemptId: string;
  readonly exchangeId: string;
  readonly receiptId: string;
  readonly deltaId: string;
  readonly candidateId: string;
  readonly locationTargetNodeId: string;
  readonly baseRevisionId: string;
  readonly headRevisionId: string;
  readonly managerMode: "fixture" | "live";
  readonly managerLabel: string;
}

export interface SourcePlacementOnboardingState {
  readonly phase: SourcePlacementOnboardingPhase;
  readonly mode: OpeningOnboardingMode | null;
  readonly stepIndex: number;
  readonly paused: boolean;
  readonly captionsVisible: boolean;
  readonly commandGeneration: number;
  readonly baselineRevisionId: string | null;
  readonly boundSourceId: string | null;
  readonly handoff: ReviewablePlacementHandoff | null;
}

export type SourcePlacementOnboardingAction =
  | {
      readonly type: "start";
      readonly mode: OpeningOnboardingMode;
      readonly captionsVisible: boolean;
      readonly placement: WorldstatePlacementObservation | null;
    }
  | {
      readonly type: "continue";
      readonly presentation: WorldstatePresentationState | null;
      readonly placement: WorldstatePlacementObservation | null;
    }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | {
      readonly type: "set_captions";
      readonly visible: boolean;
    }
  | { readonly type: "skip" }
  | { readonly type: "replay_review" };

export interface SourcePlacementOnboardingView {
  readonly phase: SourcePlacementOnboardingPhase;
  readonly mode: OpeningOnboardingMode | null;
  readonly step: SourcePlacementOnboardingStep | null;
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly paused: boolean;
  readonly captionsVisible: boolean;
  readonly audioState: "unavailable";
  readonly prerequisiteSatisfied: boolean;
  readonly canContinue: boolean;
  readonly presentationCommand: WorldstatePresentationCommand | null;
  readonly baselineRevisionId: string | null;
  readonly boundSourceId: string | null;
  readonly handoff: ReviewablePlacementHandoff | null;
}

export function createSourcePlacementOnboardingState(
  captionsVisible = true,
): SourcePlacementOnboardingState {
  return {
    phase: "inactive",
    mode: null,
    stepIndex: 0,
    paused: false,
    captionsVisible,
    commandGeneration: 0,
    baselineRevisionId: null,
    boundSourceId: null,
    handoff: null,
  };
}

function placementHandoff(
  placement: WorldstatePlacementObservation | null,
): ReviewablePlacementHandoff | null {
  if (
    !placement?.sourceId ||
    !placement.requestId ||
    !placement.requestSelectedNodeId ||
    !placement.attemptId ||
    !placement.exchangeId ||
    !placement.receiptId ||
    !placement.deltaId ||
    !placement.candidateId ||
    !placement.locationTargetNodeId ||
    !placement.baseRevisionId ||
    !placement.headRevisionId ||
    placement.managerMode === "unavailable"
  ) {
    return null;
  }

  return Object.freeze({
    sourceId: placement.sourceId,
    requestId: placement.requestId,
    requestSelectedNodeId: placement.requestSelectedNodeId,
    attemptId: placement.attemptId,
    exchangeId: placement.exchangeId,
    receiptId: placement.receiptId,
    deltaId: placement.deltaId,
    candidateId: placement.candidateId,
    locationTargetNodeId: placement.locationTargetNodeId,
    baseRevisionId: placement.baseRevisionId,
    headRevisionId: placement.headRevisionId,
    managerMode: placement.managerMode,
    managerLabel: placement.managerLabel,
  });
}

export function canStartSourcePlacementOnboarding(
  placement: WorldstatePlacementObservation | null,
): boolean {
  if (
    !placement?.headRevisionId ||
    placement.operationState !== "idle" ||
    placement.persistenceState !== "saved"
  ) {
    return false;
  }

  if (placement.state === "idle") {
    return placement.sourceId === null && placement.requestId === null;
  }

  if (placement.state === "reviewable") {
    return reviewableSourcePlacementObserved(
      placement,
      placement.headRevisionId,
    );
  }

  return Boolean(
    placement.state === "failed" &&
      placement.retryable &&
      placement.sourceId &&
      placement.requestId &&
      placement.requestSelectedNodeId ===
        SOURCE_PLACEMENT_ONBOARDING_TARGETS.budgetId &&
      placement.attemptId &&
      placement.baseRevisionId === placement.headRevisionId,
  );
}

export function reduceSourcePlacementOnboarding(
  state: SourcePlacementOnboardingState,
  action: SourcePlacementOnboardingAction,
): SourcePlacementOnboardingState {
  switch (action.type) {
    case "start":
      return state.phase === "inactive" &&
        canStartSourcePlacementOnboarding(action.placement)
        ? {
            ...state,
            phase: "guiding",
            mode: action.mode,
            stepIndex: 0,
            paused: false,
            captionsVisible: action.captionsVisible,
            baselineRevisionId: action.placement?.headRevisionId ?? null,
            boundSourceId: null,
            handoff: null,
          }
        : state;
    case "continue": {
      if (state.phase !== "guiding" || state.paused) return state;
      const step = SOURCE_PLACEMENT_ONBOARDING_SCRIPT[state.stepIndex];
      if (
        !step ||
        !sourcePlacementStepSatisfied(step, {
          baselineRevisionId: state.baselineRevisionId,
          boundSourceId: state.boundSourceId,
          placement: action.placement,
          presentation: action.presentation,
        })
      ) {
        return state;
      }

      if (state.stepIndex === SOURCE_PLACEMENT_ONBOARDING_SCRIPT.length - 1) {
        const handoff = placementHandoff(action.placement);
        return handoff
          ? { ...state, phase: "complete", paused: false, handoff }
          : state;
      }

      return {
        ...state,
        stepIndex: state.stepIndex + 1,
        boundSourceId:
          step.id === "capture-source"
            ? (action.placement?.sourceId ?? state.boundSourceId)
            : state.boundSourceId,
      };
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
    case "replay_review":
      return state.phase === "complete" && state.mode
        ? {
            ...state,
            phase: "guiding",
            stepIndex: SOURCE_PLACEMENT_ONBOARDING_SCRIPT.length - 1,
            paused: false,
            commandGeneration: state.commandGeneration + 1,
          }
        : state;
  }
}

export function deriveSourcePlacementOnboardingView(
  state: SourcePlacementOnboardingState,
  input: {
    readonly placement: WorldstatePlacementObservation | null;
    readonly presentation: WorldstatePresentationState | null;
  },
): SourcePlacementOnboardingView {
  const step =
    state.phase === "guiding"
      ? (SOURCE_PLACEMENT_ONBOARDING_SCRIPT[state.stepIndex] ?? null)
      : null;
  const prerequisiteSatisfied = step
    ? sourcePlacementStepSatisfied(step, {
        baselineRevisionId: state.baselineRevisionId,
        boundSourceId: state.boundSourceId,
        placement: input.placement,
        presentation: input.presentation,
      })
    : false;
  const commandId = step
    ? `source-placement-onboarding:${state.commandGeneration}:${step.id}`
    : "";
  const presentationCommand =
    step &&
    state.mode === "watch_only" &&
    !state.paused &&
    !prerequisiteSatisfied
      ? sourcePlacementPresentationCommand(step, commandId)
      : null;

  return {
    phase: state.phase,
    mode: state.mode,
    step,
    stepNumber: step ? state.stepIndex + 1 : 0,
    stepCount: SOURCE_PLACEMENT_ONBOARDING_SCRIPT.length,
    paused: state.paused,
    captionsVisible: state.captionsVisible,
    audioState: "unavailable",
    prerequisiteSatisfied,
    canContinue:
      state.phase === "guiding" && !state.paused && prerequisiteSatisfied,
    presentationCommand,
    baselineRevisionId: state.baselineRevisionId,
    boundSourceId: state.boundSourceId,
    handoff: state.handoff,
  };
}
