"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { WorldstatePlacementObservation } from "@/components/worldstate/placement-observation";
import type { WorldstatePresentationState } from "@/components/worldstate/presentation";
import { WorldstateWorkbench } from "@/components/worldstate/worldstate-workbench";

import {
  createOpeningOnboardingState,
  deriveOpeningOnboardingView,
  reduceOpeningOnboarding,
  type OpeningOnboardingAction,
  type OpeningOnboardingMode,
} from "./opening-onboarding-controller";
import type { OpeningOnboardingStepId } from "./opening-onboarding-script";
import styles from "./opening-onboarding.module.css";
import {
  canStartSemanticAdoptionOnboarding,
  createSemanticAdoptionOnboardingState,
  deriveSemanticAdoptionOnboardingView,
  reduceSemanticAdoptionOnboarding,
  type SemanticAdoptionOnboardingAction,
} from "./semantic-adoption-onboarding-controller";
import {
  adoptedSemanticPlacementObserved,
  reviewableSemanticAdoptionObserved,
  type SemanticAdoptionOnboardingStepId,
} from "./semantic-adoption-onboarding-script";
import {
  canStartSourcePlacementOnboarding,
  createSourcePlacementOnboardingState,
  deriveSourcePlacementOnboardingView,
  reduceSourcePlacementOnboarding,
  type SourcePlacementOnboardingAction,
} from "./source-placement-onboarding-controller";
import {
  SOURCE_PLACEMENT_ONBOARDING_TARGETS,
  type SourcePlacementOnboardingStepId,
} from "./source-placement-onboarding-script";

type HighlightTarget =
  | "scope"
  | "outline"
  | "map"
  | "timeline"
  | "focus"
  | "goal"
  | "budget"
  | "capture"
  | "placement"
  | "evidence"
  | "decision";

const MODE_COPY: Readonly<
  Record<
    OpeningOnboardingMode,
    { readonly label: string; readonly detail: string; readonly posture: string }
  >
> = {
  interactive: {
    label: "Interactive",
    detail:
      "You make each presentation choice. Continue unlocks only after the workbench reports the matching state.",
    posture: "You stay in control",
  },
  watch_only: {
    label: "Watch only",
    detail:
      "The guide may select this project, a view, or an object. It cannot capture a source or cross an authority boundary.",
    posture: "Presentation commands only",
  },
};

function highlightForOpeningStep(
  stepId: OpeningOnboardingStepId | undefined,
): HighlightTarget | undefined {
  switch (stepId) {
    case "establish-project":
      return "scope";
    case "select-outline":
      return "outline";
    case "select-goal":
      return "goal";
    case "source-capture-handoff":
      return "capture";
    default:
      return undefined;
  }
}

function highlightForSemanticAdoptionStep(
  stepId: SemanticAdoptionOnboardingStepId | undefined,
): HighlightTarget | undefined {
  switch (stepId) {
    case "review-outline":
      return "outline";
    case "review-map":
      return "map";
    case "review-timeline":
      return "timeline";
    case "review-focus":
      return "focus";
    case "adopt-placement":
      return "decision";
    default:
      return undefined;
  }
}

function highlightForSourceStep(
  stepId: SourcePlacementOnboardingStepId | undefined,
  reviewReady: boolean,
): HighlightTarget | undefined {
  switch (stepId) {
    case "select-budget-context":
      return "budget";
    case "capture-source":
      return reviewReady ? "placement" : "capture";
    case "review-placement":
      return "evidence";
    default:
      return undefined;
  }
}

function ConsentSurface({
  onChooseMode,
  onSkip,
}: {
  readonly onChooseMode: (mode: OpeningOnboardingMode) => void;
  readonly onSkip: () => void;
}) {
  return (
    <div className={styles.consentShell}>
      <section
        aria-labelledby="opening-consent-heading"
        className={styles.consentRegion}
        data-morphic-region="onboarding-consent"
      >
        <header className={styles.consentHeader}>
          <span className={styles.kicker}>Opening chapter · consent</span>
          <h1 id="opening-consent-heading">See the project before changing it.</h1>
          <p className={styles.consentLead}>
            This short guide establishes the seeded home-move sandbox, its
            structure, and its governing cost goal. It stops before source
            capture. No project change or agent run is authorized here.
          </p>
        </header>

        <div
          aria-label="Opening guide truth"
          className={styles.truthLane}
          data-morphic-lane="sandbox-truth"
          data-state-surface="diagnostic-status-surface"
        >
          <div className={styles.truthFact}>
            <span>Environment</span>
            <strong>Disposable seeded sandbox</strong>
          </div>
          <div className={styles.truthFact}>
            <span>Opening authority</span>
            <strong>Presentation only</strong>
          </div>
          <div className={styles.truthFact}>
            <span>Audio</span>
            <strong>Unavailable · captions provided</strong>
          </div>
        </div>

        <div className={styles.modeLane} data-morphic-lane="mode-choice">
          <div className={styles.modeIntro}>
            <span className={styles.laneLabel}>Choose how to enter</span>
            <p>You can pause or skip at any point.</p>
          </div>
          <div
            className={styles.modeChoices}
            data-action-cluster="onboarding-mode-choice"
          >
            {(Object.keys(MODE_COPY) as OpeningOnboardingMode[]).map(
              (mode) => {
                const copy = MODE_COPY[mode];
                const descriptionId = `opening-mode-${mode}-description`;
                return (
                  <button
                    aria-describedby={descriptionId}
                    aria-label={copy.label}
                    className={styles.modeChoice}
                    data-onboarding-action={`choose-${mode}`}
                    data-primary={mode === "interactive" ? "true" : "false"}
                    key={mode}
                    onClick={() => onChooseMode(mode)}
                    type="button"
                  >
                    <span className={styles.modeName}>{copy.label}</span>
                    <small id={descriptionId}>{copy.detail}</small>
                    <span className={styles.modePosture}>{copy.posture}</span>
                  </button>
                );
              },
            )}
            <button
              aria-describedby="opening-mode-skip-description"
              aria-label="Skip"
              className={styles.modeChoice}
              data-onboarding-action="skip"
              data-primary="false"
              onClick={onSkip}
              type="button"
            >
              <span className={styles.modeName}>Skip</span>
              <small id="opening-mode-skip-description">
                Open the unchanged workbench without presentation guidance. The
                normal sandbox initializes only in its existing host boundary.
              </small>
              <span className={styles.modePosture}>No guide commands</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function observedValue(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function observedViewLabel(value: string | undefined): string {
  const observed = observedValue(value, "Loading…");
  return value ? `${observed[0].toUpperCase()}${observed.slice(1)}` : observed;
}

function sourceFact(observation: WorldstatePlacementObservation | null): string {
  if (!observation) return "Loading…";
  if (observation.sourceId) return "Saved";
  if (
    observation.operationState === "capturing" ||
    observation.persistenceState === "saving"
  ) {
    return "Saving…";
  }
  return "Draft only";
}

function interpretationFact(
  observation: WorldstatePlacementObservation | null,
): string {
  if (!observation) return "Loading…";
  if (observation.operationState === "capturing") return "Saving source…";
  if (observation.operationState === "placing") {
    return "Finding where this fits…";
  }
  if (observation.operationState === "persisting_placement") {
    return "Saving receipt…";
  }

  switch (observation.state) {
    case "idle":
      return "Not requested";
    case "loading":
      return "Finding where this fits…";
    case "reviewable":
      return "Reviewable · provisional";
    case "needs_clarification":
      return "Clarification needed";
    case "failed":
      return "Failed · source retained";
    case "stale":
      return "Stale · blocked";
    case "adopted":
      return "Already adopted";
  }
}

function canonicalFact(
  observation: WorldstatePlacementObservation | null,
  baselineRevisionId: string | null,
): string {
  if (!observation?.headRevisionId) return "Loading…";
  if (!baselineRevisionId) return `Current · ${observation.headRevisionId}`;
  return observation.headRevisionId === baselineRevisionId
    ? `Unchanged · ${observation.headRevisionId}`
    : `Changed · ${observation.headRevisionId}`;
}

function focusWorkbench(frame: HTMLDivElement | null) {
  frame
    ?.querySelector<HTMLElement>("[data-presentation-focus-target='workbench']")
    ?.focus();
}

export function OpeningOnboardingExperience() {
  const [onboarding, setOnboarding] = useState(createOpeningOnboardingState);
  const [sourceOnboarding, setSourceOnboarding] = useState(
    createSourcePlacementOnboardingState,
  );
  const [adoptionOnboarding, setAdoptionOnboarding] = useState(
    createSemanticAdoptionOnboardingState,
  );
  const [presentation, setPresentation] =
    useState<WorldstatePresentationState | null>(null);
  const [placement, setPlacement] =
    useState<WorldstatePlacementObservation | null>(null);
  const [workbenchBusy, setWorkbenchBusy] = useState(false);
  const openingGuideHeadingRef = useRef<HTMLHeadingElement>(null);
  const openingCompletionHeadingRef = useRef<HTMLHeadingElement>(null);
  const sourceGuideHeadingRef = useRef<HTMLHeadingElement>(null);
  const sourceCompletionHeadingRef = useRef<HTMLHeadingElement>(null);
  const adoptionGuideHeadingRef = useRef<HTMLHeadingElement>(null);
  const adoptionCompletionHeadingRef = useRef<HTMLHeadingElement>(null);
  const workbenchFrameRef = useRef<HTMLDivElement>(null);
  const focusReceiptOnSourceStepRef = useRef(false);
  const previousOpeningPhaseRef = useRef(onboarding.phase);
  const previousOpeningStepIdRef = useRef<OpeningOnboardingStepId | null>(null);
  const previousSourcePhaseRef = useRef(sourceOnboarding.phase);
  const previousSourceStepIdRef =
    useRef<SourcePlacementOnboardingStepId | null>(null);
  const previousAdoptionPhaseRef = useRef(adoptionOnboarding.phase);
  const previousAdoptionStepIdRef =
    useRef<SemanticAdoptionOnboardingStepId | null>(null);
  const openingView = useMemo(
    () => deriveOpeningOnboardingView(onboarding, presentation),
    [onboarding, presentation],
  );
  const sourceView = useMemo(
    () =>
      deriveSourcePlacementOnboardingView(sourceOnboarding, {
        placement,
        presentation,
      }),
    [placement, presentation, sourceOnboarding],
  );
  const adoptionView = useMemo(
    () =>
      deriveSemanticAdoptionOnboardingView(adoptionOnboarding, {
        placement,
        presentation,
      }),
    [adoptionOnboarding, placement, presentation],
  );
  const currentOpeningStepId = openingView.step?.id ?? null;
  const currentSourceStepId = sourceView.step?.id ?? null;
  const currentAdoptionStepId = adoptionView.step?.id ?? null;

  useEffect(() => {
    const previousPhase = previousOpeningPhaseRef.current;
    const previousStepId = previousOpeningStepIdRef.current;
    if (
      openingView.phase === "guiding" &&
      (previousPhase !== "guiding" ||
        previousStepId !== currentOpeningStepId)
    ) {
      openingGuideHeadingRef.current?.focus();
    } else if (
      openingView.phase === "complete" &&
      previousPhase === "guiding" &&
      sourceView.phase === "inactive"
    ) {
      openingCompletionHeadingRef.current?.focus();
    } else if (
      openingView.phase === "skipped" &&
      previousPhase !== "skipped"
    ) {
      focusWorkbench(workbenchFrameRef.current);
    }
    previousOpeningPhaseRef.current = openingView.phase;
    previousOpeningStepIdRef.current = currentOpeningStepId;
  }, [currentOpeningStepId, openingView.phase, sourceView.phase]);

  useEffect(() => {
    const previousPhase = previousSourcePhaseRef.current;
    const previousStepId = previousSourceStepIdRef.current;
    if (
      sourceView.phase === "guiding" &&
      (previousPhase !== "guiding" || previousStepId !== currentSourceStepId)
    ) {
      if (
        focusReceiptOnSourceStepRef.current &&
        currentSourceStepId === "review-placement"
      ) {
        focusReceiptOnSourceStepRef.current = false;
        workbenchFrameRef.current
          ?.querySelector<HTMLElement>(
            "[data-placement-focus-target='receipt']",
          )
          ?.focus();
      } else {
        sourceGuideHeadingRef.current?.focus();
      }
    } else if (
      sourceView.phase === "complete" &&
      previousPhase === "guiding"
    ) {
      sourceCompletionHeadingRef.current?.focus();
    } else if (
      sourceView.phase === "skipped" &&
      previousPhase !== "skipped"
    ) {
      focusWorkbench(workbenchFrameRef.current);
    }
    previousSourcePhaseRef.current = sourceView.phase;
    previousSourceStepIdRef.current = currentSourceStepId;
  }, [currentSourceStepId, sourceView.phase]);

  useEffect(() => {
    const previousPhase = previousAdoptionPhaseRef.current;
    const previousStepId = previousAdoptionStepIdRef.current;
    if (
      adoptionView.phase === "guiding" &&
      (previousPhase !== "guiding" ||
        previousStepId !== currentAdoptionStepId)
    ) {
      adoptionGuideHeadingRef.current?.focus();
    } else if (
      adoptionView.phase === "complete" &&
      previousPhase === "guiding"
    ) {
      adoptionCompletionHeadingRef.current?.focus();
    } else if (
      adoptionView.phase === "skipped" &&
      previousPhase !== "skipped"
    ) {
      focusWorkbench(workbenchFrameRef.current);
    }
    previousAdoptionPhaseRef.current = adoptionView.phase;
    previousAdoptionStepIdRef.current = currentAdoptionStepId;
  }, [adoptionView.phase, currentAdoptionStepId]);

  const dispatchOpening = (action: OpeningOnboardingAction) => {
    setOnboarding((current) => reduceOpeningOnboarding(current, action));
  };

  const dispatchSource = (action: SourcePlacementOnboardingAction) => {
    setSourceOnboarding((current) =>
      reduceSourcePlacementOnboarding(current, action),
    );
  };

  const dispatchAdoption = (action: SemanticAdoptionOnboardingAction) => {
    setAdoptionOnboarding((current) =>
      reduceSemanticAdoptionOnboarding(current, action),
    );
  };

  if (openingView.phase === "consent") {
    return (
      <div
        className={styles.experience}
        data-morphic-root="onboarding-experience"
        data-onboarding-chapter="opening"
        data-onboarding-phase="consent"
      >
        <ConsentSurface
          onChooseMode={(mode) =>
            dispatchOpening({ type: "choose_mode", mode })
          }
          onSkip={() => dispatchOpening({ type: "skip" })}
        />
      </div>
    );
  }

  const openingStep = openingView.step;
  const sourceStep = sourceView.step;
  const adoptionStep = adoptionView.step;
  const openingGuideActive =
    openingView.phase === "guiding" && openingStep !== null;
  const sourceGuideActive =
    sourceView.phase === "guiding" && sourceStep !== null;
  const adoptionGuideActive =
    adoptionView.phase === "guiding" && adoptionStep !== null;
  const sourceHasStarted = sourceView.phase !== "inactive";
  const sourceComplete = sourceView.phase === "complete";
  const sourceClosed = sourceView.phase === "skipped";
  const adoptionHasStarted = adoptionView.phase !== "inactive";
  const adoptionComplete = adoptionView.phase === "complete";
  const adoptionClosed = adoptionView.phase === "skipped";
  const openingClosed = openingView.phase === "skipped";
  const guideActive =
    openingGuideActive || sourceGuideActive || adoptionGuideActive;
  const openingCompletionVisible =
    openingView.phase === "complete" && sourceView.phase === "inactive";
  const sourceCompletionVisible =
    sourceComplete && adoptionView.phase === "inactive";
  const adoptionCompletionVisible = adoptionComplete;
  const canContinueOpening =
    openingView.canContinue && presentation !== null;
  const canStartSource =
    canStartSourcePlacementOnboarding(placement) && !workbenchBusy;
  const canContinueSource = sourceView.canContinue;
  const canStartAdoption =
    canStartSemanticAdoptionOnboarding({
      placement,
      placementHandoff: sourceView.handoff,
    }) && !workbenchBusy;
  const canContinueAdoption = adoptionView.canContinue;
  const sourceReviewReady =
    sourceStep?.id === "capture-source" && canContinueSource;
  const sourceRequestPending =
    placement?.operationState === "capturing" ||
    placement?.operationState === "placing" ||
    placement?.operationState === "persisting_placement";
  const workbenchMutationAccess =
    openingClosed || sourceClosed || adoptionClosed
      ? "enabled"
      : adoptionComplete || adoptionStep?.id === "adopt-placement"
        ? "guided-adoption"
        : adoptionGuideActive
          ? "presentation-only"
          : sourceGuideActive || sourceComplete
            ? "guided-capture"
            : "presentation-only";
  const activePresentationCommand = adoptionGuideActive
    ? adoptionView.presentationCommand
    : sourceGuideActive
      ? sourceView.presentationCommand
      : openingGuideActive
        ? openingView.presentationCommand
        : null;
  const highlight: HighlightTarget | undefined = adoptionComplete
    ? "decision"
    : adoptionGuideActive
      ? highlightForSemanticAdoptionStep(adoptionStep?.id)
      : sourceComplete
        ? "decision"
        : sourceGuideActive
          ? highlightForSourceStep(sourceStep?.id, sourceReviewReady)
          : highlightForOpeningStep(openingStep?.id);
  const activeChapter = adoptionHasStarted
    ? "semantic-adoption"
    : sourceHasStarted
      ? "source-placement"
      : "opening";
  const activePhase = adoptionHasStarted
    ? adoptionView.phase
    : sourceHasStarted
      ? sourceView.phase
      : openingView.phase;
  const activeStep = adoptionHasStarted
    ? adoptionStep?.id
    : sourceHasStarted
      ? sourceStep?.id
      : openingStep?.id;

  const openingPrerequisiteMessage = !presentation
    ? "Waiting for the workbench to report its current project, view, and selection."
    : openingView.paused
      ? "Guidance is paused. Resume to continue from this same step."
      : openingView.prerequisiteSatisfied
        ? "This presentation state is visible in the workbench. Continue when ready."
        : openingView.mode === "watch_only"
          ? `Applying a presentation-only command. ${openingStep?.prerequisite ?? ""}`
          : (openingStep?.prerequisite ??
            "Complete the visible presentation step.");

  let sourcePrerequisiteMessage =
    sourceStep?.prerequisite ?? "Complete the visible source-placement step.";
  if (!presentation || !placement) {
    sourcePrerequisiteMessage =
      "Waiting for the workbench to report selection, persistence, and placement truth.";
  } else if (sourceView.paused) {
    sourcePrerequisiteMessage = sourceRequestPending
      ? "Guidance is paused. The source request already in flight will continue; resume to inspect its result."
      : "Guidance is paused. Resume to continue from this same step.";
  } else if (sourceStep?.id === "select-budget-context") {
    sourcePrerequisiteMessage = sourceView.prerequisiteSatisfied
      ? "Budget is selected in the workbench. Continue when ready."
      : sourceView.mode === "watch_only"
        ? `Applying a presentation-only command. ${sourceStep.prerequisite}`
        : sourceStep.prerequisite;
  } else if (sourceStep?.id === "capture-source") {
    if (placement.operationState === "capturing") {
      sourcePrerequisiteMessage =
        "Saving the exact source. Do not repeat the capture action.";
    } else if (
      placement.operationState === "placing" ||
      placement.operationState === "persisting_placement" ||
      placement.state === "loading"
    ) {
      sourcePrerequisiteMessage =
        "Source saved. Finding where this fits; canonical worldstate remains unchanged.";
    } else if (sourceReviewReady) {
      sourcePrerequisiteMessage =
        "A provisional receipt is ready. Review placement moves focus only; it does not adopt the candidate.";
    } else if (placement.state === "failed") {
      sourcePrerequisiteMessage = placement.retryable
        ? placement.requestSelectedNodeId ===
          SOURCE_PLACEMENT_ONBOARDING_TARGETS.budgetId
          ? "Placement failed, but the source and exact Budget request remain saved. Retry from the preserved source in the workbench or exit the guide."
          : "Placement failed from a request outside the required Budget context. Exact retry would preserve that context, so exit the guide to inspect the evidence."
        : "Placement failed and exact retry is unavailable. The source remains saved; exit the guide to inspect the evidence.";
    } else if (placement.state === "needs_clarification") {
      sourcePrerequisiteMessage =
        "The manager needs clarification. Nothing was adopted; exit the guide to retain and inspect the saved evidence.";
    } else if (placement.state === "stale") {
      sourcePrerequisiteMessage =
        "The receipt is stale against the current revision. Adoption stays blocked; exit the guide to inspect the saved evidence.";
    } else if (placement.state === "reviewable") {
      sourcePrerequisiteMessage =
        placement.requestSelectedNodeId !==
          SOURCE_PLACEMENT_ONBOARDING_TARGETS.budgetId
          ? "The durable request was captured outside the required Budget context. This receipt cannot complete the chapter; exit to inspect it without adoption."
          : "The provisional receipt does not satisfy the exact current lineage required by this chapter. Exit to inspect it without adoption.";
    }
  } else if (sourceStep?.id === "review-placement" && canContinueSource) {
    sourcePrerequisiteMessage =
      "The receipt and its evidence are visible. Finish this chapter before the separate adoption decision becomes available.";
  }

  const sourceContinueLabel =
    sourceStep?.id === "capture-source"
      ? sourceReviewReady
        ? "Review placement"
        : "Waiting for placement"
      : sourceStep?.id === "review-placement"
        ? "Finish source chapter"
        : "Continue";
  const sourceExitTruth = placement?.sourceId
    ? "Exiting keeps the saved source and any placement evidence. It does not adopt them; the normal host gates return after the current operation settles."
    : "Exiting before capture saves nothing and restores the normal workbench gates.";
  const canonicalLabel = canonicalFact(
    placement,
    sourceView.baselineRevisionId,
  );
  const canonicalTruth = !placement?.headRevisionId
    ? "loading"
    : placement.headRevisionId === sourceView.baselineRevisionId
      ? "unchanged"
      : "changed";
  const openingCompletionMessage = workbenchBusy
    ? "The workbench is still reporting its state. Guided placement and replay wait until it is idle. Close guide restores the normal host gates without performing an action."
    : !placement
      ? "Waiting for the workbench to report durable placement state. Start guided placement remains unavailable; Replay opening or Close guide are available."
      : placement.state === "adopted"
        ? "This sandbox already contains an adopted placement, so a fresh guided-placement chapter is unavailable. Replay opening remains presentation-only; Close guide restores normal host gates."
        : placement.state === "needs_clarification"
          ? "The saved placement needs clarification, which this chapter cannot resolve. Replay opening remains presentation-only; Close guide restores the normal host inspection gates."
          : placement.state === "stale"
            ? "The saved placement is stale against the canonical head, so guided review cannot resume. Replay opening remains presentation-only; Close guide restores normal host gates."
            : placement.state === "failed" && !placement.retryable
              ? "The saved placement failed and exact retry is unavailable. Replay opening remains presentation-only; Close guide restores the normal host inspection gates."
        : !canStartSource
          ? "The current placement does not have an actionable capture, exact Budget retry, or complete current Budget receipt. Replay opening remains presentation-only; Close guide restores normal host gates."
          : "Opening changed presentation only. Start guided placement allows one user-owned source capture and, only if needed, an exact-source retry while adoption and agent work stay locked; Replay remains presentation-only; Close guide restores normal host gates.";

  const continueSource = () => {
    if (sourceStep?.id === "capture-source" && sourceReviewReady) {
      focusReceiptOnSourceStepRef.current = true;
    }
    dispatchSource({
      type: "continue",
      placement,
      presentation,
    });
  };

  const adoptionReviewable = reviewableSemanticAdoptionObserved(
    placement,
    adoptionView.placementHandoff,
  );
  const adoptionObserved = adoptedSemanticPlacementObserved(
    placement,
    adoptionView.placementHandoff,
  );
  let adoptionPrerequisiteMessage =
    adoptionStep?.prerequisite ??
    "Complete the visible semantic-adoption review step.";
  if (!presentation || !placement) {
    adoptionPrerequisiteMessage =
      "Waiting for the Workbench to report projection, placement, persistence, and canonical truth.";
  } else if (adoptionView.paused) {
    adoptionPrerequisiteMessage =
      placement.operationState === "accepting"
        ? "Guidance is paused. The already-requested semantic commit will continue; resume to inspect its durable result."
        : "Guidance is paused. Resume to continue from this same evidence state.";
  } else if (adoptionStep?.id === "adopt-placement") {
    if (
      placement.operationState === "accepting" ||
      placement.persistenceState === "saving"
    ) {
      adoptionPrerequisiteMessage =
        "Saving the human semantic commit. No completion is inferred until the accepted revision is durable.";
    } else if (adoptionObserved) {
      adoptionPrerequisiteMessage =
        "The exact placement is adopted in the new canonical revision. Finish this chapter when ready.";
    } else if (placement.state === "stale") {
      adoptionPrerequisiteMessage =
        "The pending delta is stale against the canonical head. Adoption remains blocked and this guide cannot silently rebase it.";
    } else if (placement.persistenceState === "conflict") {
      adoptionPrerequisiteMessage =
        "The browser ledger changed elsewhere. Reload and inspect the durable state before any semantic commit.";
    } else if (placement.state === "adopted") {
      adoptionPrerequisiteMessage =
        "An adopted placement is visible, but its revision or frozen lineage does not match this chapter. Completion remains blocked.";
    } else if (adoptionReviewable) {
      adoptionPrerequisiteMessage =
        "The exact pending delta is still reviewable. Use the Workbench’s separate Adopt this placement action; the guide cannot click it for you.";
    } else {
      adoptionPrerequisiteMessage =
        "The frozen placement no longer satisfies the exact commit gate. Exit to inspect the host evidence without widening authority.";
    }
  } else if (!adoptionReviewable) {
    adoptionPrerequisiteMessage =
      placement.state === "stale"
        ? "The pending placement became stale. Projection guidance and semantic commit are blocked."
        : "The current placement no longer matches the frozen reviewable handoff. This chapter cannot continue.";
  } else if (adoptionView.prerequisiteSatisfied) {
    adoptionPrerequisiteMessage =
      "The same provisional candidate and exact pending lineage are visible in this projection. Continue when ready.";
  } else if (adoptionView.mode === "watch_only") {
    adoptionPrerequisiteMessage = `Applying presentation-only commands. ${adoptionStep?.prerequisite ?? ""}`;
  }

  const adoptionContinueLabel =
    adoptionStep?.id === "adopt-placement"
      ? adoptionObserved
        ? "Finish adoption chapter"
        : "Waiting for adoption"
      : "Continue";
  const adoptionCanonicalLabel = canonicalFact(
    placement,
    adoptionView.placementHandoff?.headRevisionId ?? null,
  );
  const adoptionExitTruth = adoptionObserved
    ? "The accepted revision remains durable. Closing the guide grants no additional authority; it only restores ordinary host gates."
    : "Closing leaves the exact pending placement unchanged and restores ordinary host gates. It does not adopt anything.";
  const continueAdoption = () => {
    dispatchAdoption({
      type: "continue",
      placement,
      presentation,
    });
  };

  return (
    <div
      className={styles.experience}
      data-highlight={highlight}
      data-morphic-root="onboarding-experience"
      data-onboarding-chapter={activeChapter}
      data-onboarding-mode={
        adoptionHasStarted
          ? (adoptionView.mode ?? undefined)
          : sourceHasStarted
            ? (sourceView.mode ?? undefined)
            : (openingView.mode ?? undefined)
      }
      data-onboarding-phase={activePhase}
      data-onboarding-step={activeStep}
    >
      <div className={styles.guideShell}>
        {openingGuideActive ? (
          <section
            aria-labelledby="opening-guide-heading"
            className={styles.guideRegion}
            data-morphic-region="onboarding-guide"
          >
            <div
              className={styles.chapterLane}
              data-morphic-lane="chapter-status"
              data-state-surface={
                openingView.paused
                  ? "warning-status-surface"
                  : "diagnostic-status-surface"
              }
            >
              <span className={styles.laneLabel}>Opening orientation</span>
              <div className={styles.progressLine}>
                <span className={styles.progressPill}>
                  Step {openingView.stepNumber} of {openingView.stepCount}
                </span>
                <span className={styles.modePill}>
                  {openingView.mode === "watch_only"
                    ? "Watch only"
                    : "Interactive"}
                </span>
                {openingView.paused ? (
                  <span className={styles.pausedPill}>Paused</span>
                ) : null}
              </div>
              <p className={styles.chapterSummary}>
                Presentation only while this guide is active · ledger,
                provider, and authority-increasing actions stay locked.
              </p>
            </div>

            <div className={styles.captionLane} data-morphic-lane="captions">
              <div aria-live="polite" className={styles.guideCopy}>
                <h2
                  id="opening-guide-heading"
                  ref={openingGuideHeadingRef}
                  tabIndex={-1}
                >
                  {openingStep.title}
                </h2>
                {openingView.captionsVisible ? (
                  <p className={styles.caption}>{openingStep.caption}</p>
                ) : (
                  <p className={styles.captionHidden}>
                    Captions hidden. Use Show captions to restore them.
                  </p>
                )}
              </div>
              <p
                className={styles.audioTruth}
                data-audio-state={openingView.audioState}
              >
                Narration audio is unavailable in this build.
              </p>
              <div
                aria-label="Observed presentation state"
                className={styles.stateFacts}
              >
                <span className={styles.stateFact}>
                  <span>Project</span>
                  <strong
                    data-presentation-id={presentation?.projectId}
                    title={presentation?.projectId}
                  >
                    {observedValue(presentation?.projectLabel, "Loading…")}
                  </strong>
                </span>
                <span className={styles.stateFact}>
                  <span>View</span>
                  <strong data-presentation-view={presentation?.view}>
                    {observedViewLabel(presentation?.view)}
                  </strong>
                </span>
                <span className={styles.stateFact}>
                  <span>Selection</span>
                  <strong
                    data-presentation-id={presentation?.selectedObjectId}
                    title={presentation?.selectedObjectId}
                  >
                    {observedValue(
                      presentation?.selectedObjectLabel,
                      "Loading…",
                    )}
                  </strong>
                </span>
              </div>
            </div>

            <div
              className={styles.controlLane}
              data-action-cluster="onboarding-presentation-controls"
              data-morphic-lane="playback-controls"
            >
              <div>
                <div className={styles.secondaryControls}>
                  <button
                    aria-pressed={openingView.captionsVisible}
                    className={styles.secondaryButton}
                    data-onboarding-action="toggle-captions"
                    onClick={() =>
                      dispatchOpening({
                        type: "set_captions",
                        visible: !openingView.captionsVisible,
                      })
                    }
                    type="button"
                  >
                    {openingView.captionsVisible
                      ? "Hide captions"
                      : "Show captions"}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    data-onboarding-action={
                      openingView.paused ? "resume" : "pause"
                    }
                    onClick={() =>
                      dispatchOpening({
                        type: openingView.paused ? "resume" : "pause",
                      })
                    }
                    type="button"
                  >
                    {openingView.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    data-onboarding-action="skip"
                    onClick={() => dispatchOpening({ type: "skip" })}
                    type="button"
                  >
                    Skip guide
                  </button>
                </div>
                <p
                  aria-live="polite"
                  className={styles.prerequisite}
                  id="opening-guide-prerequisite"
                >
                  {openingPrerequisiteMessage}
                </p>
              </div>
              <button
                aria-describedby="opening-guide-prerequisite"
                className={styles.continueButton}
                data-onboarding-action="continue"
                disabled={!canContinueOpening}
                onClick={() =>
                  dispatchOpening({ type: "continue", presentation })
                }
                type="button"
              >
                {openingView.stepNumber === openingView.stepCount
                  ? "Finish opening"
                  : "Continue"}
              </button>
            </div>
          </section>
        ) : null}

        {openingCompletionVisible ? (
          <section
            aria-labelledby="opening-completion-heading"
            className={styles.completionRegion}
            data-completion-kind="opening"
            data-morphic-region="onboarding-completion"
            data-state-surface="diagnostic-status-surface"
          >
            <div className={styles.completionCopy} role="status">
              <h2
                id="opening-completion-heading"
                ref={openingCompletionHeadingRef}
                tabIndex={-1}
              >
                Opening complete · choose the next boundary
              </h2>
              <span id="opening-next-step-status">
                {openingCompletionMessage}
              </span>
            </div>
            <div
              className={styles.completionActions}
              data-action-cluster="opening-completion-choice"
            >
              <button
                aria-describedby="opening-next-step-status"
                className={styles.startButton}
                data-onboarding-action="start-guided-placement"
                disabled={!canStartSource}
                onClick={() =>
                  dispatchSource({
                    type: "start",
                    captionsVisible: openingView.captionsVisible,
                    mode: openingView.mode ?? "interactive",
                    placement,
                  })
                }
                type="button"
              >
                Start guided placement
              </button>
              <button
                aria-describedby="opening-next-step-status"
                className={styles.replayButton}
                data-onboarding-action="replay"
                disabled={workbenchBusy}
                onClick={() => dispatchOpening({ type: "replay" })}
                type="button"
              >
                Replay opening
              </button>
              <button
                aria-describedby="opening-next-step-status"
                className={styles.secondaryButton}
                data-onboarding-action="close"
                onClick={() => dispatchOpening({ type: "skip" })}
                type="button"
              >
                Close guide
              </button>
            </div>
          </section>
        ) : null}

        {sourceGuideActive ? (
          <section
            aria-labelledby="source-placement-guide-heading"
            className={styles.guideRegion}
            data-morphic-region="onboarding-guide"
            data-onboarding-guide="source-placement"
          >
            <div
              className={styles.chapterLane}
              data-morphic-lane="chapter-status"
              data-state-surface={
                sourceView.paused
                  ? "warning-status-surface"
                  : sourceStep.id === "review-placement"
                    ? "provisional-status-surface"
                    : "diagnostic-status-surface"
              }
            >
              <span className={styles.laneLabel}>Source placement</span>
              <div className={styles.progressLine}>
                <span className={styles.progressPill}>
                  Step {sourceView.stepNumber} of {sourceView.stepCount}
                </span>
                <span className={styles.modePill}>
                  {sourceView.mode === "watch_only"
                    ? "Guided · capture stays yours"
                    : "Interactive"}
                </span>
                {sourceView.paused ? (
                  <span className={styles.pausedPill}>Paused</span>
                ) : null}
              </div>
              <p className={styles.chapterSummary}>
                Capture and exact placement retry only · adoption, reset, and
                agent work stay locked through this chapter.
              </p>
            </div>

            <div className={styles.captionLane} data-morphic-lane="captions">
              <div aria-live="polite" className={styles.guideCopy}>
                <h2
                  id="source-placement-guide-heading"
                  ref={sourceGuideHeadingRef}
                  tabIndex={-1}
                >
                  {sourceStep.title}
                </h2>
                {sourceView.captionsVisible ? (
                  <p className={styles.caption}>{sourceStep.caption}</p>
                ) : (
                  <p className={styles.captionHidden}>
                    Captions hidden. Use Show captions to restore them.
                  </p>
                )}
              </div>
              <p
                className={styles.audioTruth}
                data-audio-state={sourceView.audioState}
              >
                Narration audio is unavailable in this build.
              </p>
              <div
                aria-label="Observed source placement state"
                className={styles.stateFacts}
                data-morphic-lane="source-placement-truth"
              >
                <span className={styles.stateFact}>
                  <span>Source</span>
                  <strong
                    data-truth-state={placement?.sourceId ? "saved" : "draft"}
                    title={placement?.sourceId ?? "No durable source yet"}
                  >
                    {sourceFact(placement)}
                  </strong>
                </span>
                <span className={styles.stateFact}>
                  <span>Interpretation</span>
                  <strong
                    data-truth-state={placement?.state ?? "loading"}
                    title={placement?.managerLabel}
                  >
                    {interpretationFact(placement)}
                  </strong>
                </span>
                <span className={styles.stateFact}>
                  <span>Canonical</span>
                  <strong
                    data-truth-state={canonicalTruth}
                    title={placement?.headRevisionId ?? undefined}
                  >
                    {canonicalLabel}
                  </strong>
                </span>
              </div>
            </div>

            <div
              className={styles.controlLane}
              data-action-cluster="onboarding-source-placement-controls"
              data-morphic-lane="playback-controls"
            >
              <div>
                <div className={styles.secondaryControls}>
                  <button
                    aria-pressed={sourceView.captionsVisible}
                    className={styles.secondaryButton}
                    data-onboarding-action="toggle-captions"
                    onClick={() =>
                      dispatchSource({
                        type: "set_captions",
                        visible: !sourceView.captionsVisible,
                      })
                    }
                    type="button"
                  >
                    {sourceView.captionsVisible
                      ? "Hide captions"
                      : "Show captions"}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    data-onboarding-action={
                      sourceView.paused ? "resume" : "pause"
                    }
                    onClick={() =>
                      dispatchSource({
                        type: sourceView.paused ? "resume" : "pause",
                      })
                    }
                    type="button"
                  >
                    {sourceView.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    aria-describedby="source-guide-exit-truth"
                    className={styles.secondaryButton}
                    data-onboarding-action="skip"
                    onClick={() => dispatchSource({ type: "skip" })}
                    type="button"
                  >
                    Exit source guide
                  </button>
                </div>
                <p
                  aria-live="polite"
                  className={styles.prerequisite}
                  id="source-guide-prerequisite"
                >
                  {sourcePrerequisiteMessage}
                </p>
                <p className={styles.exitTruth} id="source-guide-exit-truth">
                  {sourceExitTruth}
                </p>
              </div>
              <button
                aria-describedby="source-guide-prerequisite"
                className={styles.continueButton}
                data-onboarding-action="continue"
                disabled={!canContinueSource}
                onClick={continueSource}
                type="button"
              >
                {sourceContinueLabel}
              </button>
            </div>
          </section>
        ) : null}

        {sourceCompletionVisible ? (
          <section
            aria-labelledby="source-placement-completion-heading"
            className={styles.completionRegion}
            data-completion-kind="source-placement"
            data-morphic-region="onboarding-completion"
            data-state-surface="provisional-status-surface"
          >
            <div className={styles.completionCopy} role="status">
              <h2
                id="source-placement-completion-heading"
                ref={sourceCompletionHeadingRef}
                tabIndex={-1}
              >
                Source placement reviewed · decision remains separate
              </h2>
              <span id="source-placement-completion-status">
                The exact source and provisional placement evidence are saved.
                Canonical revision {sourceView.baselineRevisionId ?? "unknown"} is
                unchanged. Continue begins a separate evidence review before the
                human adoption gate; agent work remains locked. Review again changes
                presentation only, and Close guide restores ordinary host gates
                without adopting anything.
              </span>
            </div>
            <div
              className={styles.completionActions}
              data-action-cluster="source-placement-completion-choice"
            >
              <button
                aria-describedby="source-placement-completion-status"
                className={styles.replayButton}
                data-onboarding-action="replay-review"
                disabled={workbenchBusy}
                onClick={() => {
                  focusReceiptOnSourceStepRef.current = true;
                  dispatchSource({ type: "replay_review" });
                }}
                type="button"
              >
                Review placement again
              </button>
              <button
                aria-describedby="source-placement-completion-status"
                className={styles.startButton}
                data-onboarding-action="start-semantic-adoption"
                disabled={!canStartAdoption}
                onClick={() =>
                  dispatchAdoption({
                    type: "start",
                    mode: sourceView.mode ?? "interactive",
                    captionsVisible: sourceView.captionsVisible,
                    placementHandoff: sourceView.handoff,
                    placement,
                  })
                }
                type="button"
              >
                Continue to adoption review
              </button>
              <button
                aria-describedby="source-placement-completion-status"
                className={styles.secondaryButton}
                data-onboarding-action="close"
                onClick={() => dispatchSource({ type: "skip" })}
                type="button"
              >
                Close guide
              </button>
            </div>
          </section>
        ) : null}

        {adoptionGuideActive ? (
          <section
            aria-labelledby="semantic-adoption-guide-heading"
            className={styles.guideRegion}
            data-morphic-region="onboarding-guide"
            data-onboarding-guide="semantic-adoption"
          >
            <div
              className={styles.chapterLane}
              data-morphic-lane="chapter-status"
              data-state-surface={
                adoptionView.paused
                  ? "warning-status-surface"
                  : adoptionObserved
                    ? "authoritative-status-surface"
                    : "provisional-status-surface"
              }
            >
              <span className={styles.laneLabel}>Semantic adoption</span>
              <div className={styles.progressLine}>
                <span className={styles.progressPill}>
                  Step {adoptionView.stepNumber} of {adoptionView.stepCount}
                </span>
                <span className={styles.modePill}>
                  {adoptionView.mode === "watch_only"
                    ? "Watch only · commit stays yours"
                    : "Interactive"}
                </span>
                {adoptionView.paused ? (
                  <span className={styles.pausedPill}>Paused</span>
                ) : null}
              </div>
              <p className={styles.chapterSummary}>
                Same candidate across every projection · only the separate human
                semantic commit may advance the canonical revision; agent work stays
                locked.
              </p>
            </div>

            <div className={styles.captionLane} data-morphic-lane="captions">
              <div aria-live="polite" className={styles.guideCopy}>
                <h2
                  id="semantic-adoption-guide-heading"
                  ref={adoptionGuideHeadingRef}
                  tabIndex={-1}
                >
                  {adoptionStep.title}
                </h2>
                {adoptionView.captionsVisible ? (
                  <p className={styles.caption}>{adoptionStep.caption}</p>
                ) : (
                  <p className={styles.captionHidden}>
                    Captions hidden. Use Show captions to restore them.
                  </p>
                )}
              </div>
              <p
                className={styles.audioTruth}
                data-audio-state={adoptionView.audioState}
              >
                Narration audio is unavailable in this build.
              </p>
              <div
                aria-label="Observed semantic adoption state"
                className={styles.stateFacts}
                data-morphic-lane="semantic-adoption-truth"
              >
                <span className={styles.stateFact}>
                  <span>Candidate</span>
                  <strong
                    data-truth-state={placement?.state ?? "loading"}
                    data-worldstate-id={
                      adoptionView.placementHandoff?.candidateId ?? undefined
                    }
                    title={
                      adoptionView.placementHandoff?.candidateId ?? undefined
                    }
                  >
                    {adoptionObserved
                      ? "Adopted"
                      : adoptionReviewable
                        ? "Same · provisional"
                        : "Mismatch · blocked"}
                  </strong>
                </span>
                <span className={styles.stateFact}>
                  <span>Projection</span>
                  <strong data-presentation-view={presentation?.view}>
                    {observedViewLabel(presentation?.view)}
                  </strong>
                </span>
                <span className={styles.stateFact}>
                  <span>Canonical</span>
                  <strong
                    data-truth-state={adoptionObserved ? "accepted" : "pending"}
                    title={placement?.headRevisionId ?? undefined}
                  >
                    {adoptionCanonicalLabel}
                  </strong>
                </span>
              </div>
            </div>

            <div
              className={styles.controlLane}
              data-action-cluster="onboarding-semantic-adoption-controls"
              data-morphic-lane="playback-controls"
            >
              <div>
                <div className={styles.secondaryControls}>
                  <button
                    aria-pressed={adoptionView.captionsVisible}
                    className={styles.secondaryButton}
                    data-onboarding-action="toggle-captions"
                    onClick={() =>
                      dispatchAdoption({
                        type: "set_captions",
                        visible: !adoptionView.captionsVisible,
                      })
                    }
                    type="button"
                  >
                    {adoptionView.captionsVisible
                      ? "Hide captions"
                      : "Show captions"}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    data-onboarding-action={
                      adoptionView.paused ? "resume" : "pause"
                    }
                    onClick={() =>
                      dispatchAdoption({
                        type: adoptionView.paused ? "resume" : "pause",
                      })
                    }
                    type="button"
                  >
                    {adoptionView.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    aria-describedby="semantic-adoption-exit-truth"
                    className={styles.secondaryButton}
                    data-onboarding-action="skip"
                    onClick={() => dispatchAdoption({ type: "skip" })}
                    type="button"
                  >
                    Exit adoption guide
                  </button>
                </div>
                <p
                  aria-live="polite"
                  className={styles.prerequisite}
                  id="semantic-adoption-prerequisite"
                >
                  {adoptionPrerequisiteMessage}
                </p>
                <p
                  className={styles.exitTruth}
                  id="semantic-adoption-exit-truth"
                >
                  {adoptionExitTruth}
                </p>
              </div>
              <button
                aria-describedby="semantic-adoption-prerequisite"
                className={styles.continueButton}
                data-onboarding-action="continue"
                disabled={!canContinueAdoption}
                onClick={continueAdoption}
                type="button"
              >
                {adoptionContinueLabel}
              </button>
            </div>
          </section>
        ) : null}

        {adoptionCompletionVisible ? (
          <section
            aria-labelledby="semantic-adoption-completion-heading"
            className={styles.completionRegion}
            data-completion-kind="semantic-adoption"
            data-morphic-region="onboarding-completion"
            data-state-surface="authoritative-status-surface"
          >
            <div className={styles.completionCopy} role="status">
              <h2
                id="semantic-adoption-completion-heading"
                ref={adoptionCompletionHeadingRef}
                tabIndex={-1}
              >
                Semantic update adopted · agent authority remains separate
              </h2>
              <span id="semantic-adoption-completion-status">
                The original source, exact placement, and accepted revision{
                  " "
                }
                {adoptionView.adoptedHandoff?.acceptedRevisionId ?? "unknown"}
                {" "}remain linked. No agent brief or run was created. Close guide
                restores ordinary host gates without granting or using any later
                authority.
              </span>
            </div>
            <div
              className={styles.completionActions}
              data-action-cluster="semantic-adoption-completion-choice"
            >
              <button
                aria-describedby="semantic-adoption-completion-status"
                className={styles.startButton}
                data-onboarding-action="close"
                onClick={() => dispatchAdoption({ type: "skip" })}
                type="button"
              >
                Close guide
              </button>
            </div>
          </section>
        ) : null}

        <div
          className={styles.workbenchFrame}
          data-guide-active={guideActive ? "true" : "false"}
          ref={workbenchFrameRef}
        >
          <WorldstateWorkbench
            mutationAccess={workbenchMutationAccess}
            onOperationBusyChange={setWorkbenchBusy}
            onPlacementObservationChange={setPlacement}
            onPresentationStateChange={setPresentation}
            presentationCommand={activePresentationCommand ?? undefined}
          />
        </div>
      </div>
    </div>
  );
}
