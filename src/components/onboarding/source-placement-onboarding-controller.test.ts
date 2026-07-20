import { describe, expect, it } from "vitest";

import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import type { WorldstatePresentationState } from "@/components/worldstate/presentation";
import { HOME_MOVE_IDS } from "@/fixtures";

import {
  canStartSourcePlacementOnboarding,
  createSourcePlacementOnboardingState,
  deriveSourcePlacementOnboardingView,
  reduceSourcePlacementOnboarding,
  type SourcePlacementOnboardingState,
} from "./source-placement-onboarding-controller";

const BASE_REVISION_ID = "revision-onboarding-baseline";
const SOURCE_ID = "source-onboarding-idea";

const budgetPresentation: WorldstatePresentationState = {
  projectId: HOME_MOVE_IDS.project,
  projectLabel: "Plan our home move",
  view: "outline",
  selectedObjectId: HOME_MOVE_IDS.budget,
  selectedObjectLabel: "Budget",
};

const goalPresentation: WorldstatePresentationState = {
  ...budgetPresentation,
  selectedObjectId: HOME_MOVE_IDS.goal,
  selectedObjectLabel: "Complete the move for less than €4,000",
};

const idlePlacement: WorldstatePlacementObservation = {
  state: "idle",
  operationState: "idle",
  persistenceState: "saved",
  sourceId: null,
  requestId: null,
  requestSelectedNodeId: null,
  attemptId: null,
  exchangeId: null,
  receiptId: null,
  deltaId: null,
  candidateId: null,
  locationTargetNodeId: null,
  baseRevisionId: null,
  acceptedRevisionId: null,
  headRevisionId: BASE_REVISION_ID,
  managerMode: "unavailable",
  managerLabel: "Placement manager not observed yet",
  retryable: false,
  canAccept: false,
};

const reviewablePlacement: WorldstatePlacementObservation = {
  ...idlePlacement,
  state: "reviewable",
  sourceId: SOURCE_ID,
  requestId: "request-onboarding-placement",
  requestSelectedNodeId: HOME_MOVE_IDS.budget,
  attemptId: "source-placement-attempt:request-onboarding-placement",
  exchangeId: "source-placement-exchange:request-onboarding-placement",
  receiptId: "receipt-onboarding-placement",
  deltaId: "delta-onboarding-placement",
  candidateId: HOME_MOVE_IDS.compareQuotes,
  locationTargetNodeId: HOME_MOVE_IDS.budget,
  baseRevisionId: BASE_REVISION_ID,
  managerMode: "fixture",
  managerLabel: "Deterministic fixture manager",
  canAccept: true,
};

function act(
  state: SourcePlacementOnboardingState,
  action: Parameters<typeof reduceSourcePlacementOnboarding>[1],
) {
  return reduceSourcePlacementOnboarding(state, action);
}

function start(
  mode: "interactive" | "watch_only" = "interactive",
): SourcePlacementOnboardingState {
  return act(createSourcePlacementOnboardingState(), {
    type: "start",
    mode,
    captionsVisible: true,
    placement: idlePlacement,
  });
}

function advanceToCapture(
  mode: "interactive" | "watch_only" = "interactive",
): SourcePlacementOnboardingState {
  return act(start(mode), {
    type: "continue",
    presentation: budgetPresentation,
    placement: idlePlacement,
  });
}

function advanceToReview(
  mode: "interactive" | "watch_only" = "interactive",
): SourcePlacementOnboardingState {
  return act(advanceToCapture(mode), {
    type: "continue",
    presentation: budgetPresentation,
    placement: reviewablePlacement,
  });
}

describe("source placement onboarding controller", () => {
  it("starts only from an actionable capture, exact retry, or complete current Budget receipt", () => {
    expect(canStartSourcePlacementOnboarding(idlePlacement)).toBe(true);
    expect(canStartSourcePlacementOnboarding(reviewablePlacement)).toBe(true);
    expect(
      canStartSourcePlacementOnboarding({
        ...reviewablePlacement,
        state: "failed",
        managerMode: "unavailable",
        retryable: true,
        canAccept: false,
      }),
    ).toBe(true);
    expect(canStartSourcePlacementOnboarding(null)).toBe(false);

    const blocked: ReadonlyArray<
      readonly [string, Partial<WorldstatePlacementObservation>]
    > = [
      ["missing head", { headRevisionId: null }],
      ["initializing", { operationState: "initializing" }],
      ["placement in flight", { operationState: "placing" }],
      ["saving", { persistenceState: "saving" }],
      ["conflict", { persistenceState: "conflict" }],
      ["adopted", { state: "adopted" }],
      ["clarification", { state: "needs_clarification" }],
      ["stale", { state: "stale" }],
      ["non-retryable failure", { state: "failed" }],
      ["idle source cannot be recaptured", { sourceId: SOURCE_ID }],
    ];

    for (const [label, overrides] of blocked) {
      expect(
        canStartSourcePlacementOnboarding({
          ...idlePlacement,
          ...overrides,
        }),
        label,
      ).toBe(false);
    }

    expect(
      canStartSourcePlacementOnboarding({
        ...reviewablePlacement,
        requestSelectedNodeId: HOME_MOVE_IDS.goal,
      }),
    ).toBe(false);

    const initial = createSourcePlacementOnboardingState(false);
    expect(
      act(initial, {
        type: "start",
        mode: "interactive",
        captionsVisible: true,
        placement: { ...idlePlacement, operationState: "capturing" },
      }),
    ).toBe(initial);

    const guiding = act(initial, {
      type: "start",
      mode: "watch_only",
      captionsVisible: true,
      placement: idlePlacement,
    });
    expect(guiding).toMatchObject({
      phase: "guiding",
      mode: "watch_only",
      stepIndex: 0,
      captionsVisible: true,
      baselineRevisionId: BASE_REVISION_ID,
      boundSourceId: null,
    });
    expect(
      act(guiding, {
        type: "start",
        mode: "interactive",
        captionsVisible: false,
        placement: idlePlacement,
      }),
    ).toBe(guiding);
  });

  it("keeps interactive progress user-paced and never emits commands", () => {
    let state = start("interactive");
    expect(
      deriveSourcePlacementOnboardingView(state, {
        placement: idlePlacement,
        presentation: goalPresentation,
      }),
    ).toMatchObject({
      phase: "guiding",
      step: { id: "select-budget-context" },
      prerequisiteSatisfied: false,
      canContinue: false,
      presentationCommand: null,
    });

    expect(
      act(state, {
        type: "continue",
        presentation: goalPresentation,
        placement: idlePlacement,
      }),
    ).toBe(state);

    state = act(state, {
      type: "continue",
      presentation: budgetPresentation,
      placement: idlePlacement,
    });
    expect(
      deriveSourcePlacementOnboardingView(state, {
        placement: idlePlacement,
        presentation: budgetPresentation,
      }),
    ).toMatchObject({
      step: { id: "capture-source" },
      prerequisiteSatisfied: false,
      canContinue: false,
      presentationCommand: null,
    });

    expect(
      act(state, {
        type: "continue",
        presentation: budgetPresentation,
        placement: { ...reviewablePlacement, operationState: "placing" },
      }),
    ).toBe(state);

    state = act(state, {
      type: "continue",
      presentation: budgetPresentation,
      placement: reviewablePlacement,
    });
    expect(state).toMatchObject({
      phase: "guiding",
      stepIndex: 2,
      boundSourceId: SOURCE_ID,
    });
    expect(
      deriveSourcePlacementOnboardingView(state, {
        placement: reviewablePlacement,
        presentation: budgetPresentation,
      }),
    ).toMatchObject({
      step: { id: "review-placement" },
      prerequisiteSatisfied: true,
      canContinue: true,
      presentationCommand: null,
    });

    state = act(state, {
      type: "continue",
      presentation: budgetPresentation,
      placement: reviewablePlacement,
    });
    expect(state.phase).toBe("complete");
    expect(state.handoff).toEqual({
      sourceId: SOURCE_ID,
      requestId: reviewablePlacement.requestId,
      requestSelectedNodeId: HOME_MOVE_IDS.budget,
      attemptId: reviewablePlacement.attemptId,
      exchangeId: reviewablePlacement.exchangeId,
      receiptId: reviewablePlacement.receiptId,
      deltaId: reviewablePlacement.deltaId,
      candidateId: reviewablePlacement.candidateId,
      locationTargetNodeId: HOME_MOVE_IDS.budget,
      baseRevisionId: BASE_REVISION_ID,
      headRevisionId: BASE_REVISION_ID,
      managerMode: "fixture",
      managerLabel: "Deterministic fixture manager",
    });
    expect(Object.isFrozen(state.handoff)).toBe(true);
  });

  it("lets watch-only issue only the Budget presentation command", () => {
    let state = start("watch_only");
    expect(
      deriveSourcePlacementOnboardingView(state, {
        placement: idlePlacement,
        presentation: goalPresentation,
      }).presentationCommand,
    ).toEqual({
      id: "source-placement-onboarding:0:select-budget-context",
      type: "select_object",
      objectId: HOME_MOVE_IDS.budget,
    });

    expect(
      deriveSourcePlacementOnboardingView(state, {
        placement: idlePlacement,
        presentation: budgetPresentation,
      }).presentationCommand,
    ).toBeNull();

    state = advanceToCapture("watch_only");
    for (const placement of [
      idlePlacement,
      { ...idlePlacement, operationState: "capturing" as const },
      { ...idlePlacement, operationState: "placing" as const },
      reviewablePlacement,
    ]) {
      expect(
        deriveSourcePlacementOnboardingView(state, {
          placement,
          presentation: budgetPresentation,
        }).presentationCommand,
      ).toBeNull();
    }
  });

  it("pins the baseline and source before allowing review completion", () => {
    let state = advanceToReview();
    expect(state).toMatchObject({
      baselineRevisionId: BASE_REVISION_ID,
      boundSourceId: SOURCE_ID,
      stepIndex: 2,
    });

    for (const placement of [
      { ...reviewablePlacement, sourceId: "source-from-another-run" },
      { ...reviewablePlacement, requestSelectedNodeId: HOME_MOVE_IDS.goal },
      { ...reviewablePlacement, baseRevisionId: "revision-other" },
      { ...reviewablePlacement, headRevisionId: "revision-other" },
    ]) {
      expect(
        act(state, {
          type: "continue",
          presentation: budgetPresentation,
          placement,
        }),
      ).toBe(state);
    }

    state = act(state, {
      type: "continue",
      presentation: budgetPresentation,
      placement: reviewablePlacement,
    });
    expect(state.phase).toBe("complete");
  });

  it("blocks failure, clarification, and stale observations without inventing a command", () => {
    const state = advanceToCapture("watch_only");

    for (const placementState of [
      "failed",
      "needs_clarification",
      "stale",
    ] as const) {
      const placement: WorldstatePlacementObservation = {
        ...reviewablePlacement,
        state: placementState,
        canAccept: false,
        retryable: placementState === "failed",
      };
      const view = deriveSourcePlacementOnboardingView(state, {
        placement,
        presentation: budgetPresentation,
      });
      expect(view).toMatchObject({
        prerequisiteSatisfied: false,
        canContinue: false,
        presentationCommand: null,
      });
      expect(
        act(state, {
          type: "continue",
          presentation: budgetPresentation,
          placement,
        }),
      ).toBe(state);
    }
  });

  it("pauses progression and replays only the evidence-review step with no command", () => {
    let state = advanceToReview("watch_only");
    state = act(state, { type: "pause" });
    expect(
      deriveSourcePlacementOnboardingView(state, {
        placement: reviewablePlacement,
        presentation: budgetPresentation,
      }),
    ).toMatchObject({ paused: true, canContinue: false, presentationCommand: null });
    expect(
      act(state, {
        type: "continue",
        presentation: budgetPresentation,
        placement: reviewablePlacement,
      }),
    ).toBe(state);

    state = act(state, { type: "resume" });
    state = act(state, {
      type: "continue",
      presentation: budgetPresentation,
      placement: reviewablePlacement,
    });
    expect(state.phase).toBe("complete");

    const replayed = act(state, { type: "replay_review" });
    expect(replayed).toMatchObject({
      phase: "guiding",
      stepIndex: 2,
      commandGeneration: 1,
      boundSourceId: SOURCE_ID,
      baselineRevisionId: BASE_REVISION_ID,
    });
    expect(
      deriveSourcePlacementOnboardingView(replayed, {
        placement: reviewablePlacement,
        presentation: goalPresentation,
      }),
    ).toMatchObject({
      step: { id: "review-placement" },
      canContinue: true,
      presentationCommand: null,
    });
  });
});
