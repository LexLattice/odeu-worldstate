"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

type HighlightTarget = "scope" | "outline" | "goal" | "capture";

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

function highlightForStep(
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

export function OpeningOnboardingExperience() {
  const [onboarding, setOnboarding] = useState(createOpeningOnboardingState);
  const [presentation, setPresentation] =
    useState<WorldstatePresentationState | null>(null);
  const [workbenchBusy, setWorkbenchBusy] = useState(false);
  const guideHeadingRef = useRef<HTMLHeadingElement>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement>(null);
  const workbenchFrameRef = useRef<HTMLDivElement>(null);
  const previousPhaseRef = useRef(onboarding.phase);
  const previousStepIdRef = useRef<OpeningOnboardingStepId | null>(null);
  const view = useMemo(
    () => deriveOpeningOnboardingView(onboarding, presentation),
    [onboarding, presentation],
  );
  const currentStepId = view.step?.id ?? null;

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    const previousStepId = previousStepIdRef.current;
    if (
      view.phase === "guiding" &&
      (previousPhase !== "guiding" || previousStepId !== currentStepId)
    ) {
      guideHeadingRef.current?.focus();
    } else if (view.phase === "complete" && previousPhase === "guiding") {
      completionHeadingRef.current?.focus();
    } else if (view.phase === "skipped" && previousPhase !== "skipped") {
      workbenchFrameRef.current
        ?.querySelector<HTMLElement>(
          "[data-presentation-focus-target='workbench']",
        )
        ?.focus();
    }
    previousPhaseRef.current = view.phase;
    previousStepIdRef.current = currentStepId;
  }, [currentStepId, view.phase]);

  const dispatch = (action: OpeningOnboardingAction) => {
    setOnboarding((current) => reduceOpeningOnboarding(current, action));
  };

  if (view.phase === "consent") {
    return (
      <div
        className={styles.experience}
        data-morphic-root="onboarding-experience"
        data-onboarding-phase="consent"
      >
        <ConsentSurface
          onChooseMode={(mode) => dispatch({ type: "choose_mode", mode })}
          onSkip={() => dispatch({ type: "skip" })}
        />
      </div>
    );
  }

  const step = view.step;
  const guideActive = view.phase === "guiding" && step !== null;
  const highlight = highlightForStep(step?.id);
  const canContinue = view.canContinue && presentation !== null;
  const prerequisiteMessage = !presentation
    ? "Waiting for the workbench to report its current project, view, and selection."
    : view.paused
      ? "Guidance is paused. Resume to continue from this same step."
      : view.prerequisiteSatisfied
        ? "This presentation state is visible in the workbench. Continue when ready."
        : view.mode === "watch_only"
          ? `Applying a presentation-only command. ${step?.prerequisite ?? ""}`
          : (step?.prerequisite ?? "Complete the visible presentation step.");

  return (
    <div
      className={styles.experience}
      data-highlight={highlight}
      data-morphic-root="onboarding-experience"
      data-onboarding-mode={view.mode ?? undefined}
      data-onboarding-phase={view.phase}
      data-onboarding-step={step?.id}
    >
      <div className={styles.guideShell}>
        {guideActive ? (
          <section
            aria-labelledby="opening-guide-heading"
            className={styles.guideRegion}
            data-morphic-region="onboarding-guide"
          >
            <div
              className={styles.chapterLane}
              data-morphic-lane="chapter-status"
              data-state-surface={
                view.paused
                  ? "warning-status-surface"
                  : "diagnostic-status-surface"
              }
            >
              <span className={styles.laneLabel}>Opening orientation</span>
              <div className={styles.progressLine}>
                <span className={styles.progressPill}>
                  Step {view.stepNumber} of {view.stepCount}
                </span>
                <span className={styles.modePill}>
                  {view.mode === "watch_only" ? "Watch only" : "Interactive"}
                </span>
                {view.paused ? (
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
                <h2 id="opening-guide-heading" ref={guideHeadingRef} tabIndex={-1}>
                  {step.title}
                </h2>
                {view.captionsVisible ? (
                  <p className={styles.caption}>{step.caption}</p>
                ) : (
                  <p className={styles.captionHidden}>
                    Captions hidden. Use Show captions to restore them.
                  </p>
                )}
              </div>
              <p className={styles.audioTruth} data-audio-state={view.audioState}>
                Narration audio is unavailable in this build.
              </p>
              <div aria-label="Observed presentation state" className={styles.stateFacts}>
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
                    aria-pressed={view.captionsVisible}
                    className={styles.secondaryButton}
                    data-onboarding-action="toggle-captions"
                    onClick={() =>
                      dispatch({
                        type: "set_captions",
                        visible: !view.captionsVisible,
                      })
                    }
                    type="button"
                  >
                    {view.captionsVisible ? "Hide captions" : "Show captions"}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    data-onboarding-action={view.paused ? "resume" : "pause"}
                    onClick={() =>
                      dispatch({ type: view.paused ? "resume" : "pause" })
                    }
                    type="button"
                  >
                    {view.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    data-onboarding-action="skip"
                    onClick={() => dispatch({ type: "skip" })}
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
                  {prerequisiteMessage}
                </p>
              </div>
              <button
                aria-describedby="opening-guide-prerequisite"
                className={styles.continueButton}
                data-onboarding-action="continue"
                disabled={!canContinue}
                onClick={() =>
                  dispatch({ type: "continue", presentation })
                }
                type="button"
              >
                {view.stepNumber === view.stepCount
                  ? "Finish opening"
                  : "Continue"}
              </button>
            </div>
          </section>
        ) : null}

        {view.phase === "complete" ? (
          <section
            aria-label="Opening complete"
            className={styles.completionRegion}
            data-morphic-region="onboarding-completion"
            data-state-surface="diagnostic-status-surface"
          >
            <div className={styles.completionCopy} role="status">
              <h2 ref={completionHeadingRef} tabIndex={-1}>
                Opening complete · normal workbench available
              </h2>
              <span id="opening-replay-status">
                {workbenchBusy
                  ? "A workbench operation is still in flight. Replay unlocks after it settles so no ongoing write or provider call crosses into guidance."
                  : "The guide changed presentation only. Source capture, semantic commit, and agent authority remain separate workbench actions."}
              </span>
            </div>
            <div className={styles.completionActions}>
              <button
                aria-describedby="opening-replay-status"
                className={styles.replayButton}
                data-onboarding-action="replay"
                disabled={workbenchBusy}
                onClick={() => dispatch({ type: "replay" })}
                type="button"
              >
                Replay opening
              </button>
              <button
                className={styles.secondaryButton}
                data-onboarding-action="close"
                onClick={() => dispatch({ type: "skip" })}
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
            mutationAccess={guideActive ? "presentation-only" : "enabled"}
            onOperationBusyChange={setWorkbenchBusy}
            onPresentationStateChange={setPresentation}
            presentationCommand={view.presentationCommand ?? undefined}
          />
        </div>
      </div>
    </div>
  );
}
