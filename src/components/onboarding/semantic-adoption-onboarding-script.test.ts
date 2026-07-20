import { describe, expect, it } from "vitest";

import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import type { WorldstatePresentationState } from "@/components/worldstate/presentation";
import { HOME_MOVE_IDS } from "@/fixtures";

import {
  adoptedSemanticPlacementObserved,
  reviewableSemanticAdoptionObserved,
  SEMANTIC_ADOPTION_ONBOARDING_SCRIPT,
  semanticAdoptionPresentationCommand,
  semanticAdoptionPresentationSatisfied,
  semanticAdoptionStepSatisfied,
} from "./semantic-adoption-onboarding-script";
import type { ReviewablePlacementHandoff } from "./source-placement-onboarding-controller";

const BASE_REVISION_ID = "revision-home-move-seed";
const ACCEPTED_REVISION_ID = "revision-semantic-adoption";

const handoff: ReviewablePlacementHandoff = Object.freeze({
  sourceId: "source-guided-placement",
  requestId: "request-guided-placement",
  requestSelectedNodeId: HOME_MOVE_IDS.budget,
  attemptId: "source-placement-attempt:request-guided-placement",
  exchangeId: "source-placement-exchange:request-guided-placement",
  receiptId: "receipt-guided-placement",
  deltaId: "delta-guided-placement",
  candidateId: HOME_MOVE_IDS.compareQuotes,
  locationTargetNodeId: HOME_MOVE_IDS.budget,
  baseRevisionId: BASE_REVISION_ID,
  headRevisionId: BASE_REVISION_ID,
  managerMode: "fixture",
  managerLabel: "Deterministic fixture manager",
});

const reviewablePlacement: WorldstatePlacementObservation = {
  state: "reviewable",
  operationState: "idle",
  persistenceState: "saved",
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
  acceptedRevisionId: null,
  headRevisionId: handoff.headRevisionId,
  managerMode: handoff.managerMode,
  managerLabel: handoff.managerLabel,
  retryable: false,
  canAccept: true,
};

const outlinePresentation: WorldstatePresentationState = {
  projectId: HOME_MOVE_IDS.project,
  projectLabel: "Plan our home move",
  view: "outline",
  selectedObjectId: handoff.candidateId,
  selectedObjectLabel: "Compare moving quotes",
};

const adoptedPlacement: WorldstatePlacementObservation = {
  ...reviewablePlacement,
  state: "adopted",
  acceptedRevisionId: ACCEPTED_REVISION_ID,
  headRevisionId: ACCEPTED_REVISION_ID,
  canAccept: false,
};

describe("semantic adoption onboarding script", () => {
  it("orders four lawful projections before the explicit semantic decision", () => {
    expect(SEMANTIC_ADOPTION_ONBOARDING_SCRIPT.map((step) => step.id)).toEqual([
      "review-outline",
      "review-map",
      "review-timeline",
      "review-focus",
      "adopt-placement",
    ]);
    expect(SEMANTIC_ADOPTION_ONBOARDING_SCRIPT.map((step) => step.view)).toEqual([
      "outline",
      "map",
      "timeline",
      "focus",
      null,
    ]);
  });

  it("selects the exact candidate before changing a Watch-only view", () => {
    const mapStep = SEMANTIC_ADOPTION_ONBOARDING_SCRIPT[1];
    expect(mapStep).toBeDefined();
    if (!mapStep) return;

    expect(
      semanticAdoptionPresentationCommand(mapStep, {
        commandId: "command:map",
        handoff,
        presentation: {
          ...outlinePresentation,
          selectedObjectId: HOME_MOVE_IDS.budget,
          selectedObjectLabel: "Budget",
        },
      }),
    ).toEqual({
      id: "command:map:select-candidate",
      type: "select_object",
      objectId: handoff.candidateId,
    });
    expect(
      semanticAdoptionPresentationCommand(mapStep, {
        commandId: "command:map",
        handoff,
        presentation: outlinePresentation,
      }),
    ).toEqual({
      id: "command:map:select-map",
      type: "select_view",
      view: "map",
    });
    expect(
      semanticAdoptionPresentationCommand(mapStep, {
        commandId: "command:map",
        handoff,
        presentation: { ...outlinePresentation, view: "map" },
      }),
    ).toBeNull();
  });

  it("requires the exact pending lineage throughout projection review", () => {
    const outlineStep = SEMANTIC_ADOPTION_ONBOARDING_SCRIPT[0];
    expect(outlineStep).toBeDefined();
    if (!outlineStep) return;

    expect(reviewableSemanticAdoptionObserved(reviewablePlacement, handoff)).toBe(
      true,
    );
    expect(
      semanticAdoptionPresentationSatisfied(
        outlineStep,
        outlinePresentation,
        handoff,
      ),
    ).toBe(true);
    expect(
      semanticAdoptionStepSatisfied(outlineStep, {
        handoff,
        placement: reviewablePlacement,
        presentation: outlinePresentation,
      }),
    ).toBe(true);

    for (const drift of [
      { requestId: "request-other" },
      { candidateId: "candidate-other" },
      { headRevisionId: "revision-other" },
      { operationState: "accepting" as const },
      { persistenceState: "conflict" as const },
      { acceptedRevisionId: ACCEPTED_REVISION_ID },
      { canAccept: false },
    ]) {
      expect(
        reviewableSemanticAdoptionObserved(
          { ...reviewablePlacement, ...drift },
          handoff,
        ),
      ).toBe(false);
    }
  });

  it("recognizes completion only from the exact new accepted head", () => {
    const adoptionStep = SEMANTIC_ADOPTION_ONBOARDING_SCRIPT.at(-1);
    expect(adoptionStep).toBeDefined();
    if (!adoptionStep) return;

    expect(adoptedSemanticPlacementObserved(adoptedPlacement, handoff)).toBe(
      true,
    );
    expect(
      semanticAdoptionStepSatisfied(adoptionStep, {
        handoff,
        placement: adoptedPlacement,
        presentation: { ...outlinePresentation, view: "focus" },
      }),
    ).toBe(true);
    expect(
      adoptedSemanticPlacementObserved(
        { ...adoptedPlacement, acceptedRevisionId: BASE_REVISION_ID },
        handoff,
      ),
    ).toBe(false);
    expect(
      adoptedSemanticPlacementObserved(
        { ...adoptedPlacement, candidateId: "candidate-other" },
        handoff,
      ),
    ).toBe(false);
    expect(
      semanticAdoptionPresentationCommand(adoptionStep, {
        commandId: "command:adopt",
        handoff,
        presentation: outlinePresentation,
      }),
    ).toBeNull();
  });
});
