import { describe, expect, it } from "vitest";

import type { PlacementSurface } from "./types";
import {
  deriveWorldstatePlacementObservation,
  type WorldstatePlacementObservation,
  worldstatePlacementObservationEqual,
} from "./placement-observation";

function placement(
  overrides: Partial<PlacementSurface> = {},
): PlacementSurface {
  return {
    state: "reviewable",
    sourceId: "source-human-1",
    sourceText: "A private-to-this-projection source body.",
    sourceCapturedAt: "2026-07-19T12:00:00.000Z",
    requestId: "request-1",
    requestSelectedNodeId: "node-area-budget",
    attemptId: "source-placement-attempt:request-1",
    baseRevisionId: "revision-1",
    deltaId: "delta-placement-1",
    candidateId: "node-candidate-1",
    exchangeId: "source-placement-exchange:request-1",
    receiptId: "receipt-1",
    locationTargetNodeId: "node-area-budget",
    locationLabel: "Budget",
    breadcrumb: ["Plan our home move", "Budget"],
    proposedKind: "task",
    delegationProfileId: "moving-cost-contract-v1",
    proposedTitle: "Compare provider quotes",
    proposedSummary: "Compare bounded moving costs.",
    rationale: "The idea concerns the project budget.",
    confidence: "high",
    uncertainty: ["Recurring storage remains open."],
    alternatives: [
      { title: "Providers", rationale: "Provider comparison is adjacent." },
    ],
    conflicts: [],
    affectedTitles: ["Complete the move for less than €4,000"],
    visibleConsequence: "Stage one provisional comparison task.",
    clarificationQuestion: null,
    managerLabel: "Deterministic fixture manager",
    errorCode: null,
    errorMessage: null,
    retryable: false,
    canAccept: true,
    gateReason: "Persisted evidence is ready for human review.",
    ...overrides,
  };
}

function observation(
  surface: PlacementSurface = placement(),
): WorldstatePlacementObservation {
  return deriveWorldstatePlacementObservation({
    placement: surface,
    operationState: "placing",
    persistenceState: "saving",
    headRevisionId: "revision-1",
    managerMode: "fixture",
  });
}

describe("worldstate placement observation", () => {
  it("projects only immutable scalar placement and revision truth", () => {
    const projected = observation();

    expect(projected).toEqual({
      state: "reviewable",
      operationState: "placing",
      persistenceState: "saving",
      sourceId: "source-human-1",
      requestId: "request-1",
      requestSelectedNodeId: "node-area-budget",
      attemptId: "source-placement-attempt:request-1",
      exchangeId: "source-placement-exchange:request-1",
      receiptId: "receipt-1",
      deltaId: "delta-placement-1",
      candidateId: "node-candidate-1",
      locationTargetNodeId: "node-area-budget",
      baseRevisionId: "revision-1",
      headRevisionId: "revision-1",
      managerMode: "fixture",
      managerLabel: "Deterministic fixture manager",
      retryable: false,
      canAccept: true,
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected).not.toHaveProperty("sourceText");
    expect(projected).not.toHaveProperty("gateReason");
    expect(projected).not.toHaveProperty("session");
    expect(projected).not.toHaveProperty("command");
  });

  it("compares every exposed scalar while ignoring unexposed presentation detail", () => {
    const left = observation();
    const sameTruth = observation(
      placement({
        sourceText: "Different unexposed source text.",
        rationale: "Different unexposed rationale.",
        uncertainty: ["Different unexposed uncertainty."],
        gateReason: "Different unexposed explanation.",
      }),
    );

    expect(worldstatePlacementObservationEqual(left, sameTruth)).toBe(true);
    expect(worldstatePlacementObservationEqual(left, left)).toBe(true);
    expect(worldstatePlacementObservationEqual(left, null)).toBe(false);
    expect(worldstatePlacementObservationEqual(null, null)).toBe(true);

    const changedValues: Readonly<
      Partial<Record<keyof WorldstatePlacementObservation, unknown>>
    > = {
      state: "failed",
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
      baseRevisionId: "revision-0",
      headRevisionId: "revision-2",
      managerMode: "live",
      managerLabel: "Live manager · OpenAI",
      retryable: true,
      canAccept: false,
    };

    for (const [field, value] of Object.entries(changedValues)) {
      const changed = Object.freeze({ ...left, [field]: value });
      expect(
        worldstatePlacementObservationEqual(left, changed),
        `expected ${field} to participate in semantic equality`,
      ).toBe(false);
    }
  });
});
