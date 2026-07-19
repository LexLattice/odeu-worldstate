import { describe, expect, it } from "vitest";

import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import type { WorldstatePresentationState } from "@/components/worldstate/presentation";
import { HOME_MOVE_IDS } from "@/fixtures";

import {
  reviewableSourcePlacementObserved,
  SOURCE_PLACEMENT_ONBOARDING_SCRIPT,
  SOURCE_PLACEMENT_ONBOARDING_TARGETS,
  sourcePlacementPresentationCommand,
  sourcePlacementPresentationSatisfied,
  sourcePlacementStepSatisfied,
} from "./source-placement-onboarding-script";

const BASE_REVISION_ID = "revision-onboarding-baseline";
const SOURCE_ID = "source-onboarding-idea";

const budgetPresentation: WorldstatePresentationState = {
  projectId: HOME_MOVE_IDS.project,
  projectLabel: "Plan our home move",
  view: "outline",
  selectedObjectId: HOME_MOVE_IDS.budget,
  selectedObjectLabel: "Budget",
};

const reviewablePlacement: WorldstatePlacementObservation = {
  state: "reviewable",
  operationState: "idle",
  persistenceState: "saved",
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
  headRevisionId: BASE_REVISION_ID,
  managerMode: "fixture",
  managerLabel: "Deterministic fixture manager",
  retryable: false,
  canAccept: true,
};

describe("source placement onboarding script", () => {
  it("uses one typed Budget presentation command and no semantic commands", () => {
    expect(SOURCE_PLACEMENT_ONBOARDING_TARGETS.budgetId).toBe(
      HOME_MOVE_IDS.budget,
    );
    expect(
      SOURCE_PLACEMENT_ONBOARDING_SCRIPT.map((step) =>
        sourcePlacementPresentationCommand(step, `command:${step.id}`),
      ),
    ).toEqual([
      {
        id: "command:select-budget-context",
        type: "select_object",
        objectId: HOME_MOVE_IDS.budget,
      },
      null,
      null,
    ]);
  });

  it("satisfies the context step only from the exact observed Budget selection", () => {
    const contextStep = SOURCE_PLACEMENT_ONBOARDING_SCRIPT[0];
    if (!contextStep) throw new Error("Expected a context step.");

    expect(
      sourcePlacementPresentationSatisfied(contextStep, budgetPresentation),
    ).toBe(true);
    expect(
      sourcePlacementPresentationSatisfied(contextStep, {
        ...budgetPresentation,
        selectedObjectId: HOME_MOVE_IDS.goal,
        selectedObjectLabel: "Complete the move for less than €4,000",
      }),
    ).toBe(false);
    expect(sourcePlacementPresentationSatisfied(contextStep, null)).toBe(
      false,
    );
  });

  it("requires the complete persisted lineage, exact baseline, Budget target, and available manager", () => {
    expect(
      reviewableSourcePlacementObserved(
        reviewablePlacement,
        BASE_REVISION_ID,
        SOURCE_ID,
      ),
    ).toBe(true);

    const exactIdFields = [
      "sourceId",
      "requestId",
      "requestSelectedNodeId",
      "attemptId",
      "exchangeId",
      "receiptId",
      "deltaId",
      "candidateId",
      "baseRevisionId",
      "headRevisionId",
      "locationTargetNodeId",
    ] as const satisfies readonly (keyof WorldstatePlacementObservation)[];

    for (const field of exactIdFields) {
      expect(
        reviewableSourcePlacementObserved(
          { ...reviewablePlacement, [field]: null },
          BASE_REVISION_ID,
          SOURCE_ID,
        ),
        `${field} must be present`,
      ).toBe(false);
    }

    const blocked: ReadonlyArray<
      readonly [string, Partial<WorldstatePlacementObservation>]
    > = [
      ["capturing", { operationState: "capturing" }],
      ["placement in flight", { operationState: "placing" }],
      ["result still saving", { persistenceState: "saving" }],
      ["domain accept gate closed", { canAccept: false }],
      ["manager unavailable", { managerMode: "unavailable" }],
      ["wrong request context", { requestSelectedNodeId: HOME_MOVE_IDS.goal }],
      ["base changed", { baseRevisionId: "revision-other" }],
      ["head changed", { headRevisionId: "revision-other" }],
      ["wrong target", { locationTargetNodeId: HOME_MOVE_IDS.goal }],
    ];

    for (const [label, overrides] of blocked) {
      expect(
        reviewableSourcePlacementObserved(
          { ...reviewablePlacement, ...overrides },
          BASE_REVISION_ID,
          SOURCE_ID,
        ),
        label,
      ).toBe(false);
    }
  });

  it("fails closed for failure, clarification, stale, adopted, and source mismatch", () => {
    for (const state of [
      "failed",
      "needs_clarification",
      "stale",
      "adopted",
    ] as const) {
      expect(
        reviewableSourcePlacementObserved(
          { ...reviewablePlacement, state },
          BASE_REVISION_ID,
          SOURCE_ID,
        ),
        state,
      ).toBe(false);
    }

    expect(
      reviewableSourcePlacementObserved(
        reviewablePlacement,
        BASE_REVISION_ID,
        "source-from-another-run",
      ),
    ).toBe(false);
    expect(
      reviewableSourcePlacementObserved(reviewablePlacement, null, SOURCE_ID),
    ).toBe(false);
    expect(
      reviewableSourcePlacementObserved(null, BASE_REVISION_ID, SOURCE_ID),
    ).toBe(false);
  });

  it("binds review completion to the source while allowing capture to establish it", () => {
    const captureStep = SOURCE_PLACEMENT_ONBOARDING_SCRIPT[1];
    const reviewStep = SOURCE_PLACEMENT_ONBOARDING_SCRIPT[2];
    if (!captureStep || !reviewStep) {
      throw new Error("Expected capture and review steps.");
    }

    const input = {
      baselineRevisionId: BASE_REVISION_ID,
      boundSourceId: "source-from-another-run",
      placement: reviewablePlacement,
      presentation: budgetPresentation,
    };

    expect(sourcePlacementStepSatisfied(captureStep, input)).toBe(true);
    expect(sourcePlacementStepSatisfied(reviewStep, input)).toBe(false);
    expect(
      sourcePlacementStepSatisfied(reviewStep, {
        ...input,
        boundSourceId: SOURCE_ID,
      }),
    ).toBe(true);
  });
});
