import { describe, expect, it } from "vitest";

import type { WorldstatePresentationState } from "@/components/worldstate/presentation";

import {
  createOpeningOnboardingState,
  deriveOpeningOnboardingView,
  reduceOpeningOnboarding,
  type OpeningOnboardingState,
} from "./opening-onboarding-controller";

const INITIAL_PRESENTATION: WorldstatePresentationState = {
  projectId: "another-project",
  projectLabel: "Another project",
  view: "map",
  selectedObjectId: "area-budget",
  selectedObjectLabel: "Budget",
};

function act(
  state: OpeningOnboardingState,
  action: Parameters<typeof reduceOpeningOnboarding>[1],
) {
  return reduceOpeningOnboarding(state, action);
}

describe("opening onboarding controller", () => {
  it("requires consent and never emits presentation commands in interactive mode", () => {
    let state = createOpeningOnboardingState();
    expect(deriveOpeningOnboardingView(state, null)).toMatchObject({
      phase: "consent",
      mode: null,
      captionsVisible: true,
      audioState: "unavailable",
      presentationCommand: null,
      canContinue: false,
    });

    state = act(state, { type: "choose_mode", mode: "interactive" });
    const guiding = deriveOpeningOnboardingView(state, INITIAL_PRESENTATION);
    expect(guiding).toMatchObject({
      phase: "guiding",
      mode: "interactive",
      stepNumber: 1,
      prerequisiteSatisfied: false,
      canContinue: false,
      presentationCommand: null,
    });
    expect(deriveOpeningOnboardingView(state, null)).toMatchObject({
      prerequisiteSatisfied: false,
      canContinue: false,
      presentationCommand: null,
    });
    expect(
      act(state, { type: "continue", presentation: null }),
    ).toBe(state);

    expect(
      act(state, {
        type: "continue",
        presentation: INITIAL_PRESENTATION,
      }),
    ).toBe(state);
  });

  it("advances only through user-paced continues backed by observed state", () => {
    let state = act(createOpeningOnboardingState(), {
      type: "choose_mode",
      mode: "interactive",
    });
    const projectSelected = {
      ...INITIAL_PRESENTATION,
      projectId: "project-home-move",
    };
    state = act(state, {
      type: "continue",
      presentation: projectSelected,
    });
    expect(deriveOpeningOnboardingView(state, projectSelected).step?.id).toBe(
      "select-outline",
    );

    expect(
      act(state, { type: "continue", presentation: projectSelected }),
    ).toBe(state);

    const outlineSelected = { ...projectSelected, view: "outline" as const };
    state = act(state, {
      type: "continue",
      presentation: outlineSelected,
    });
    expect(deriveOpeningOnboardingView(state, outlineSelected).step?.id).toBe(
      "select-goal",
    );

    const goalSelected = {
      ...outlineSelected,
      selectedObjectId: "node-goal-under-4000",
    };
    state = act(state, {
      type: "continue",
      presentation: goalSelected,
    });
    expect(deriveOpeningOnboardingView(state, goalSelected)).toMatchObject({
      phase: "guiding",
      stepNumber: 4,
      prerequisiteSatisfied: true,
      canContinue: true,
      presentationCommand: null,
    });

    state = act(state, { type: "continue", presentation: goalSelected });
    expect(deriveOpeningOnboardingView(state, goalSelected)).toMatchObject({
      phase: "complete",
      step: null,
      presentationCommand: null,
    });
  });

  it("issues watch-only commands, pauses without replay, and resumes the same identity", () => {
    let state = act(createOpeningOnboardingState(), {
      type: "choose_mode",
      mode: "watch_only",
    });
    const firstCommand = deriveOpeningOnboardingView(
      state,
      INITIAL_PRESENTATION,
    ).presentationCommand;
    expect(firstCommand).toEqual({
      id: "opening-onboarding:0:establish-project",
      type: "select_project",
      projectId: "project-home-move",
    });

    state = act(state, { type: "pause" });
    expect(
      deriveOpeningOnboardingView(state, INITIAL_PRESENTATION),
    ).toMatchObject({ paused: true, canContinue: false, presentationCommand: null });
    expect(
      act(state, {
        type: "continue",
        presentation: {
          ...INITIAL_PRESENTATION,
          projectId: "project-home-move",
        },
      }),
    ).toBe(state);

    state = act(state, { type: "resume" });
    expect(
      deriveOpeningOnboardingView(state, INITIAL_PRESENTATION)
        .presentationCommand,
    ).toEqual(firstCommand);
  });

  it("keeps captions controllable and skip free of presentation effects", () => {
    let state = act(createOpeningOnboardingState(), {
      type: "set_captions",
      visible: false,
    });
    expect(state.captionsVisible).toBe(false);
    state = act(state, { type: "set_captions", visible: true });
    state = act(state, { type: "skip" });
    expect(deriveOpeningOnboardingView(state, INITIAL_PRESENTATION)).toMatchObject(
      {
        phase: "skipped",
        captionsVisible: true,
        presentationCommand: null,
        canContinue: false,
      },
    );
  });

  it("replays a completed opening with fresh command identities", () => {
    let state = act(createOpeningOnboardingState(), {
      type: "choose_mode",
      mode: "watch_only",
    });
    const firstRunCommand = deriveOpeningOnboardingView(
      state,
      INITIAL_PRESENTATION,
    ).presentationCommand;
    const completePresentation: WorldstatePresentationState = {
      projectId: "project-home-move",
      projectLabel: "Plan our home move",
      view: "outline",
      selectedObjectId: "node-goal-under-4000",
      selectedObjectLabel: "Complete the move for less than €4,000",
    };

    for (let index = 0; index < 4; index += 1) {
      state = act(state, {
        type: "continue",
        presentation: completePresentation,
      });
    }
    expect(state.phase).toBe("complete");

    state = act(state, { type: "replay" });
    const replayCommand = deriveOpeningOnboardingView(
      state,
      INITIAL_PRESENTATION,
    ).presentationCommand;
    expect(replayCommand).toEqual({
      id: "opening-onboarding:1:establish-project",
      type: "select_project",
      projectId: "project-home-move",
    });
    expect(replayCommand?.id).not.toBe(firstRunCommand?.id);
  });
});
