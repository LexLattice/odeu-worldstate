import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import {
  type WorldstatePresentationCommand,
  type WorldstatePresentationState,
  worldstatePresentationCommandSatisfied,
} from "@/components/worldstate/presentation";
import { HOME_MOVE_IDS } from "@/fixtures";

export const SOURCE_PLACEMENT_ONBOARDING_TARGETS = {
  budgetId: HOME_MOVE_IDS.budget,
} as const;

export type SourcePlacementOnboardingStepId =
  | "select-budget-context"
  | "capture-source"
  | "review-placement";

export interface SourcePlacementOnboardingStep {
  readonly id: SourcePlacementOnboardingStepId;
  readonly title: string;
  readonly caption: string;
  readonly prerequisite: string;
  readonly target:
    | {
        readonly type: "select_object";
        readonly objectId: string;
      }
    | null;
}

export const SOURCE_PLACEMENT_ONBOARDING_SCRIPT: readonly SourcePlacementOnboardingStep[] =
  [
    {
      id: "select-budget-context",
      title: "Set the placement context",
      caption:
        "Select Budget before capturing the idea. That gives the placement manager an exact working context while the under-€4,000 goal remains part of the evidence.",
      prerequisite: "Select the Budget working area.",
      target: {
        type: "select_object",
        objectId: SOURCE_PLACEMENT_ONBOARDING_TARGETS.budgetId,
      },
    },
    {
      id: "capture-source",
      title: "Save the idea, then ask where it fits",
      caption:
        "Edit the sample or write your own, then use Capture & place in the workbench. This saves the exact source and requests a provisional interpretation; it does not adopt anything.",
      prerequisite:
        "Use the workbench Capture & place action and wait for a reviewable provisional receipt.",
      target: null,
    },
    {
      id: "review-placement",
      title: "Review the interpretation before mutation",
      caption:
        "The source, exact request and Manager exchange, pending delta, rationale, uncertainty, and canonical revision are visible together. The placement is still provisional.",
      prerequisite:
        "Review the persisted provisional receipt while the canonical revision remains unchanged.",
      target: null,
    },
  ] as const;

export function sourcePlacementPresentationCommand(
  step: SourcePlacementOnboardingStep,
  commandId: string,
): WorldstatePresentationCommand | null {
  return step.target
    ? {
        id: commandId,
        type: "select_object",
        objectId: step.target.objectId,
      }
    : null;
}

export function sourcePlacementPresentationSatisfied(
  step: SourcePlacementOnboardingStep,
  presentation: WorldstatePresentationState | null,
): boolean {
  if (!presentation) return false;
  const command = sourcePlacementPresentationCommand(
    step,
    `source-placement-satisfaction:${step.id}`,
  );
  return command
    ? worldstatePresentationCommandSatisfied(command, presentation)
    : true;
}

export function reviewableSourcePlacementObserved(
  observation: WorldstatePlacementObservation | null,
  baselineRevisionId: string | null,
  boundSourceId: string | null = null,
): boolean {
  if (
    !observation ||
    !baselineRevisionId ||
    observation.state !== "reviewable" ||
    observation.operationState !== "idle" ||
    observation.persistenceState !== "saved" ||
    observation.canAccept !== true ||
    observation.managerMode === "unavailable"
  ) {
    return false;
  }

  const exactIds = [
    observation.sourceId,
    observation.requestId,
    observation.requestSelectedNodeId,
    observation.attemptId,
    observation.exchangeId,
    observation.receiptId,
    observation.deltaId,
    observation.candidateId,
    observation.baseRevisionId,
    observation.headRevisionId,
    observation.locationTargetNodeId,
  ];

  return (
    exactIds.every((value) => Boolean(value)) &&
    observation.baseRevisionId === baselineRevisionId &&
    observation.headRevisionId === baselineRevisionId &&
    observation.requestSelectedNodeId ===
      SOURCE_PLACEMENT_ONBOARDING_TARGETS.budgetId &&
    observation.locationTargetNodeId ===
      SOURCE_PLACEMENT_ONBOARDING_TARGETS.budgetId &&
    (!boundSourceId || observation.sourceId === boundSourceId)
  );
}

export function sourcePlacementStepSatisfied(
  step: SourcePlacementOnboardingStep,
  input: {
    readonly baselineRevisionId: string | null;
    readonly boundSourceId: string | null;
    readonly placement: WorldstatePlacementObservation | null;
    readonly presentation: WorldstatePresentationState | null;
  },
): boolean {
  if (step.id === "select-budget-context") {
    return sourcePlacementPresentationSatisfied(step, input.presentation);
  }

  return reviewableSourcePlacementObserved(
    input.placement,
    input.baselineRevisionId,
    step.id === "review-placement" ? input.boundSourceId : null,
  );
}
