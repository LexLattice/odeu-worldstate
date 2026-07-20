import { describe, expect, it } from "vitest";

import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import type { WorldstatePresentationState } from "@/components/worldstate/presentation";
import { HOME_MOVE_IDS } from "@/fixtures";

import {
  canStartSemanticAdoptionOnboarding,
  createSemanticAdoptionOnboardingState,
  deriveSemanticAdoptionOnboardingView,
  reduceSemanticAdoptionOnboarding,
  type SemanticAdoptionOnboardingState,
} from "./semantic-adoption-onboarding-controller";
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

function presentation(
  view: WorldstatePresentationState["view"],
): WorldstatePresentationState {
  return {
    projectId: HOME_MOVE_IDS.project,
    projectLabel: "Plan our home move",
    view,
    selectedObjectId: handoff.candidateId,
    selectedObjectLabel: "Compare moving quotes",
  };
}

function start(
  mode: "interactive" | "watch_only" = "interactive",
): SemanticAdoptionOnboardingState {
  return reduceSemanticAdoptionOnboarding(
    createSemanticAdoptionOnboardingState(),
    {
      type: "start",
      mode,
      captionsVisible: true,
      placementHandoff: handoff,
      placement: reviewablePlacement,
    },
  );
}

function continueWith(
  state: SemanticAdoptionOnboardingState,
  view: WorldstatePresentationState["view"],
  placement: WorldstatePlacementObservation = reviewablePlacement,
): SemanticAdoptionOnboardingState {
  return reduceSemanticAdoptionOnboarding(state, {
    type: "continue",
    placement,
    presentation: presentation(view),
  });
}

describe("semantic adoption onboarding controller", () => {
  it("starts only from the exact frozen current reviewable handoff", () => {
    expect(
      canStartSemanticAdoptionOnboarding({
        placement: reviewablePlacement,
        placementHandoff: handoff,
      }),
    ).toBe(true);
    expect(start().phase).toBe("guiding");
    expect(
      reduceSemanticAdoptionOnboarding(
        createSemanticAdoptionOnboardingState(),
        {
          type: "start",
          mode: "interactive",
          captionsVisible: true,
          placementHandoff: handoff,
          placement: { ...reviewablePlacement, headRevisionId: "revision-other" },
        },
      ),
    ).toEqual(createSemanticAdoptionOnboardingState());
  });

  it("requires the four projections in order before exposing adoption", () => {
    let state = start();
    expect(
      deriveSemanticAdoptionOnboardingView(state, {
        placement: reviewablePlacement,
        presentation: presentation("outline"),
      }).step?.id,
    ).toBe("review-outline");

    state = continueWith(state, "map");
    expect(state.stepIndex).toBe(0);
    state = continueWith(state, "outline");
    state = continueWith(state, "map");
    state = continueWith(state, "timeline");
    state = continueWith(state, "focus");
    expect(
      deriveSemanticAdoptionOnboardingView(state, {
        placement: reviewablePlacement,
        presentation: presentation("focus"),
      }).step?.id,
    ).toBe("adopt-placement");
  });

  it("uses presentation commands only in Watch-only review and never for adoption", () => {
    let state = start("watch_only");
    let view = deriveSemanticAdoptionOnboardingView(state, {
      placement: reviewablePlacement,
      presentation: {
        ...presentation("map"),
        selectedObjectId: HOME_MOVE_IDS.budget,
      },
    });
    expect(view.presentationCommand).toEqual({
      id: "semantic-adoption-onboarding:0:review-outline:select-candidate",
      type: "select_object",
      objectId: handoff.candidateId,
    });

    state = continueWith(state, "outline");
    state = continueWith(state, "map");
    state = continueWith(state, "timeline");
    state = continueWith(state, "focus");
    view = deriveSemanticAdoptionOnboardingView(state, {
      placement: reviewablePlacement,
      presentation: presentation("focus"),
    });
    expect(view.step?.id).toBe("adopt-placement");
    expect(view.presentationCommand).toBeNull();
  });

  it("pauses commands and progression without losing the frozen handoff", () => {
    const started = start("watch_only");
    const paused = reduceSemanticAdoptionOnboarding(started, { type: "pause" });
    const view = deriveSemanticAdoptionOnboardingView(paused, {
      placement: reviewablePlacement,
      presentation: presentation("map"),
    });
    expect(view.presentationCommand).toBeNull();
    expect(view.canContinue).toBe(false);
    expect(continueWith(paused, "outline")).toBe(paused);
    const resumed = reduceSemanticAdoptionOnboarding(paused, { type: "resume" });
    expect(resumed.placementHandoff).toBe(handoff);
    expect(resumed.commandGeneration).toBe(1);
  });

  it("freezes the exact accepted revision only after durable adoption", () => {
    let state = start();
    state = continueWith(state, "outline");
    state = continueWith(state, "map");
    state = continueWith(state, "timeline");
    state = continueWith(state, "focus");
    expect(continueWith(state, "focus")).toBe(state);

    const adoptedPlacement: WorldstatePlacementObservation = {
      ...reviewablePlacement,
      state: "adopted",
      acceptedRevisionId: ACCEPTED_REVISION_ID,
      headRevisionId: ACCEPTED_REVISION_ID,
      canAccept: false,
    };
    state = continueWith(state, "focus", adoptedPlacement);
    expect(state.phase).toBe("complete");
    expect(state.adoptedHandoff).toEqual({
      ...handoff,
      priorHeadRevisionId: BASE_REVISION_ID,
      acceptedRevisionId: ACCEPTED_REVISION_ID,
      headRevisionId: ACCEPTED_REVISION_ID,
    });
    expect(Object.isFrozen(state.adoptedHandoff)).toBe(true);
  });

  it("can close without mutating the frozen evidence", () => {
    const started = start();
    const skipped = reduceSemanticAdoptionOnboarding(started, { type: "skip" });
    expect(skipped.phase).toBe("skipped");
    expect(skipped.placementHandoff).toBe(handoff);
  });
});
