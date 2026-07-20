import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import {
  type WorldstatePresentationCommand,
  type WorldstatePresentationState,
  worldstatePresentationCommandSatisfied,
} from "@/components/worldstate/presentation";

import type { ReviewablePlacementHandoff } from "./source-placement-onboarding-controller";

export type SemanticAdoptionOnboardingStepId =
  | "review-outline"
  | "review-map"
  | "review-timeline"
  | "review-focus"
  | "adopt-placement";

export interface SemanticAdoptionOnboardingStep {
  readonly id: SemanticAdoptionOnboardingStepId;
  readonly title: string;
  readonly caption: string;
  readonly prerequisite: string;
  readonly view: WorldstatePresentationState["view"] | null;
}

export const SEMANTIC_ADOPTION_ONBOARDING_SCRIPT: readonly SemanticAdoptionOnboardingStep[] =
  [
    {
      id: "review-outline",
      title: "See where the candidate belongs",
      caption:
        "Outline shows the provisional task inside the Budget area. Its identity, source, receipt, and pending delta stay unchanged; only the projection changes.",
      prerequisite:
        "Select the provisional candidate in Outline while the exact placement remains pending.",
      view: "outline",
    },
    {
      id: "review-map",
      title: "See what the candidate connects",
      caption:
        "Map renders the same provisional candidate and its proposed relations. Geometry is presentation state, not canonical truth.",
      prerequisite:
        "Keep the provisional candidate selected and switch to Map.",
      view: "map",
    },
    {
      id: "review-timeline",
      title: "See where the candidate came from",
      caption:
        "Timeline keeps the original source and provisional placement in history before any accepted revision exists.",
      prerequisite:
        "Keep the provisional candidate selected and switch to Timeline.",
      view: "timeline",
    },
    {
      id: "review-focus",
      title: "Return to one explicit decision",
      caption:
        "Focus presents the same candidate, evidence, and semantic gate together. Continue only changes the guide posture; it does not adopt the delta.",
      prerequisite:
        "Keep the provisional candidate selected and switch to Focus.",
      view: "focus",
    },
    {
      id: "adopt-placement",
      title: "Choose whether this interpretation becomes project truth",
      caption:
        "Use the Workbench’s separate Adopt this placement action. That exact human action may create one revision; it does not prepare or authorize agent work.",
      prerequisite:
        "Use Adopt this placement and wait until the accepted revision is durably visible.",
      view: null,
    },
  ] as const;

function exactHandoffFieldsMatch(
  placement: WorldstatePlacementObservation,
  handoff: ReviewablePlacementHandoff,
): boolean {
  return (
    placement.sourceId === handoff.sourceId &&
    placement.requestId === handoff.requestId &&
    placement.requestSelectedNodeId === handoff.requestSelectedNodeId &&
    placement.attemptId === handoff.attemptId &&
    placement.exchangeId === handoff.exchangeId &&
    placement.receiptId === handoff.receiptId &&
    placement.deltaId === handoff.deltaId &&
    placement.candidateId === handoff.candidateId &&
    placement.locationTargetNodeId === handoff.locationTargetNodeId &&
    placement.baseRevisionId === handoff.baseRevisionId &&
    placement.managerMode === handoff.managerMode &&
    placement.managerLabel === handoff.managerLabel
  );
}

export function reviewableSemanticAdoptionObserved(
  placement: WorldstatePlacementObservation | null,
  handoff: ReviewablePlacementHandoff | null,
): boolean {
  return Boolean(
    placement &&
      handoff &&
      placement.state === "reviewable" &&
      placement.operationState === "idle" &&
      placement.persistenceState === "saved" &&
      placement.canAccept &&
      placement.acceptedRevisionId === null &&
      placement.headRevisionId === handoff.headRevisionId &&
      handoff.headRevisionId === handoff.baseRevisionId &&
      exactHandoffFieldsMatch(placement, handoff),
  );
}

export function adoptedSemanticPlacementObserved(
  placement: WorldstatePlacementObservation | null,
  handoff: ReviewablePlacementHandoff | null,
): boolean {
  return Boolean(
    placement &&
      handoff &&
      placement.state === "adopted" &&
      placement.operationState === "idle" &&
      placement.persistenceState === "saved" &&
      !placement.canAccept &&
      placement.acceptedRevisionId &&
      placement.headRevisionId === placement.acceptedRevisionId &&
      placement.headRevisionId !== handoff.headRevisionId &&
      exactHandoffFieldsMatch(placement, handoff),
  );
}

export function semanticAdoptionPresentationSatisfied(
  step: SemanticAdoptionOnboardingStep,
  presentation: WorldstatePresentationState | null,
  handoff: ReviewablePlacementHandoff | null,
): boolean {
  if (!step.view || !presentation || !handoff) return step.view === null;
  return (
    presentation.selectedObjectId === handoff.candidateId &&
    presentation.view === step.view
  );
}

export function semanticAdoptionPresentationCommand(
  step: SemanticAdoptionOnboardingStep,
  input: {
    readonly commandId: string;
    readonly presentation: WorldstatePresentationState | null;
    readonly handoff: ReviewablePlacementHandoff | null;
  },
): WorldstatePresentationCommand | null {
  if (!step.view || !input.presentation || !input.handoff) return null;
  if (input.presentation.selectedObjectId !== input.handoff.candidateId) {
    return {
      id: `${input.commandId}:select-candidate`,
      type: "select_object",
      objectId: input.handoff.candidateId,
    };
  }
  const command: WorldstatePresentationCommand = {
    id: `${input.commandId}:select-${step.view}`,
    type: "select_view",
    view: step.view,
  };
  return worldstatePresentationCommandSatisfied(command, input.presentation)
    ? null
    : command;
}

export function semanticAdoptionStepSatisfied(
  step: SemanticAdoptionOnboardingStep,
  input: {
    readonly placement: WorldstatePlacementObservation | null;
    readonly presentation: WorldstatePresentationState | null;
    readonly handoff: ReviewablePlacementHandoff | null;
  },
): boolean {
  if (step.id === "adopt-placement") {
    return adoptedSemanticPlacementObserved(input.placement, input.handoff);
  }

  return (
    reviewableSemanticAdoptionObserved(input.placement, input.handoff) &&
    semanticAdoptionPresentationSatisfied(
      step,
      input.presentation,
      input.handoff,
    )
  );
}
