"use client";

import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { createBrowserPlacementGateway } from "@/adapters/manager/browser";
import { createBrowserWorldstateLedgerStore } from "@/adapters/storage/worldstate-client";
import {
  createWorldstateSession,
  type WorldstateSession,
  type WorldstateSessionOperationState,
  type WorldstateSessionSnapshot,
} from "@/application/worldstate-session";
import { HOME_MOVE_IDS } from "@/fixtures";

import {
  CheckIcon,
  ChevronIcon,
  HistoryIcon,
  LinkIcon,
  ShieldIcon,
  SparkIcon,
} from "./icons";
import { ProjectionSurface } from "./projections";
import type {
  PlacementSurface,
  ProjectionView,
  WorkbenchViewModel,
} from "./types";
import { buildWorkbenchViewModel } from "./view-model";
import styles from "./worldstate-workbench.module.css";

const DEFAULT_SOURCE =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";
const SELECTION_STORAGE_KEY = "odeu.worldstate.project-home-move.selection";

let fallbackId = 0;

function nextBrowserId(kind: "source" | "request" | "event" | "command") {
  const identity = globalThis.crypto?.randomUUID?.() ?? `local-${++fallbackId}`;
  return `${kind}:${identity}`;
}

function createDefaultWorldstateSession(): WorldstateSession {
  return createWorldstateSession({
    store: createBrowserWorldstateLedgerStore(),
    placementGateway: createBrowserPlacementGateway(),
    now: () => new Date().toISOString(),
    nextId: nextBrowserId,
  });
}

function subscribeToNarrowViewport(onChange: () => void) {
  if (!window.matchMedia) return () => undefined;
  const media = window.matchMedia("(max-width: 560px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isNarrowViewport() {
  return window.matchMedia?.("(max-width: 560px)").matches ?? false;
}

function placementOperationState(
  operation: WorldstateSessionOperationState,
): "idle" | "loading" {
  return operation === "capturing" ||
    operation === "placing" ||
    operation === "persisting_placement"
    ? "loading"
    : "idle";
}

function placementPosture(state: PlacementSurface["state"]) {
  if (state === "reviewable") return "suggested";
  return state;
}

function placementStateLabel(state: PlacementSurface["state"]): string {
  const labels: Record<PlacementSurface["state"], string> = {
    idle: "Awaiting source",
    loading: "Interpreting · source saved",
    reviewable: "Suggested · no change yet",
    needs_clarification: "Clarification needed",
    failed: "Placement failed",
    stale: "Stale · commit blocked",
    adopted: "Adopted",
  };
  return labels[state];
}

function placementStateSurface(
  state: PlacementSurface["state"],
):
  | "authoritative-status-surface"
  | "provisional-status-surface"
  | "warning-status-surface"
  | "diagnostic-status-surface" {
  if (state === "adopted") return "authoritative-status-surface";
  if (state === "reviewable") return "provisional-status-surface";
  if (state === "needs_clarification" || state === "stale") {
    return "warning-status-surface";
  }
  return "diagnostic-status-surface";
}

function placementUncertainties(placement: PlacementSurface): string[] {
  return Array.from(
    new Set(
      [placement.clarificationQuestion, ...placement.uncertainty].filter(
        (item): item is string => Boolean(item),
      ),
    ),
  );
}

function knowledgeStatus(placement: PlacementSurface): {
  state: string;
  label: string;
  detail: string;
  surface: string;
} {
  const hasOpenKnowledge = placementUncertainties(placement).length > 0;

  switch (placement.state) {
    case "idle":
      return {
        state: "supported",
        label: "Supported",
        detail: "Canonical ledger only",
        surface: "diagnostic-status-surface",
      };
    case "loading":
      return {
        state: "loading",
        label: "Loading",
        detail: "Manager evidence pending",
        surface: "diagnostic-status-surface",
      };
    case "reviewable":
      return hasOpenKnowledge
        ? {
            state: "open",
            label: "Open",
            detail: "Uncertainty retained",
            surface: "warning-status-surface",
          }
        : {
            state: "draft",
            label: "Draft",
            detail: "Manager interpretation",
            surface: "provisional-status-surface",
          };
    case "needs_clarification":
      return {
        state: "open",
        label: "Open",
        detail: "Clarification required",
        surface: "warning-status-surface",
      };
    case "failed":
      return {
        state: "challenged",
        label: "Challenged",
        detail: "Placement evidence failed",
        surface: "diagnostic-status-surface",
      };
    case "stale":
      return {
        state: "out-of-date",
        label: "Out of date",
        detail: "Base revision changed",
        surface: "warning-status-surface",
      };
    case "adopted":
      return hasOpenKnowledge
        ? {
            state: "open",
            label: "Open",
            detail: "Uncertainty retained",
            surface: "warning-status-surface",
          }
        : {
            state: "supported",
            label: "Supported",
            detail: "Receipt linked to revision",
            surface: "diagnostic-status-surface",
          };
  }
}

function governanceStatus(placement: PlacementSurface): {
  state: string;
  label: string;
  detail: string;
  surface: string;
} {
  switch (placement.state) {
    case "adopted":
      return {
        state: "adopted",
        label: "Adopted",
        detail: "Revision recorded",
        surface: "authoritative-status-surface",
      };
    case "reviewable":
      return {
        state: "suggested",
        label: "Suggested",
        detail: "Human commit required",
        surface: "provisional-status-surface",
      };
    case "idle":
      return {
        state: "not-granted",
        label: "Not granted",
        detail: "No placement to adopt",
        surface: "diagnostic-status-surface",
      };
    case "loading":
      return {
        state: "not-granted",
        label: "Not granted",
        detail: "Placement still in progress",
        surface: "diagnostic-status-surface",
      };
    case "needs_clarification":
      return {
        state: "not-granted",
        label: "Not granted",
        detail: "Clarification blocks commit",
        surface: "warning-status-surface",
      };
    case "failed":
      return {
        state: "not-granted",
        label: "Not granted",
        detail: "Failure blocks commit",
        surface: "diagnostic-status-surface",
      };
    case "stale":
      return {
        state: "not-granted",
        label: "Not granted",
        detail: "Revision change blocks commit",
        surface: "warning-status-surface",
      };
  }
}

function withSessionPlacementTruth(
  placement: PlacementSurface,
  snapshot: Pick<
    WorldstateSessionSnapshot,
    "error" | "operationState" | "persistenceDetail" | "retry"
  >,
): PlacementSurface {
  const retryable =
    snapshot.operationState === "idle" &&
    snapshot.retry?.operation === "placement";

  if (!snapshot.error) {
    if (!retryable || !["idle", "failed"].includes(placement.state)) {
      return placement;
    }

    if (placement.state === "failed") {
      return { ...placement, retryable: true, canAccept: false };
    }

    return {
      ...placement,
      state: "failed",
      errorCode: "placement_incomplete",
      errorMessage:
        "The persisted placement request has no matching manager exchange.",
      retryable: true,
      canAccept: false,
      gateReason:
        "The durable placement request can be retried; no semantic commit is available.",
    };
  }

  if (
    placement.state === "adopted" ||
    snapshot.error.scope === "reset" ||
    snapshot.error.scope === "persistence"
  ) {
    return placement;
  }

  const stale = snapshot.error.code === "stale_delta";
  if (snapshot.error.scope === "semantic_commit") {
    if (stale) {
      return {
        ...placement,
        state: "stale",
        errorCode: snapshot.error.code,
        errorMessage: snapshot.error.message,
        retryable: false,
        canAccept: false,
      };
    }

    if (placement.state !== "reviewable") return placement;
    const canRetryCommit = snapshot.error.retryable;
    return {
      ...placement,
      errorCode: snapshot.error.code,
      errorMessage: snapshot.error.message,
      retryable: false,
      canAccept: canRetryCommit,
      gateReason: canRetryCommit
        ? "The prior semantic commit was not saved. Retry the same reviewed delta."
        : "The semantic commit could not be saved. Reload before trying again.",
    };
  }

  return {
    ...placement,
    state: stale ? "stale" : "failed",
    errorCode: snapshot.error.code,
    errorMessage: snapshot.error.message,
    retryable: retryable && snapshot.error.retryable,
    canAccept: false,
    gateReason: retryable
      ? "The durable source is preserved. Retry placement; semantic commit remains unavailable."
      : stale
        ? placement.gateReason
        : `${snapshot.persistenceDetail ?? "The operation failed."} Semantic commit remains unavailable.`,
  };
}

function safeStoredSelection(nodes: WorkbenchViewModel["nodes"]): string | null {
  try {
    const stored = window.localStorage.getItem(SELECTION_STORAGE_KEY);
    return stored && nodes.some((node) => node.id === stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeSelection(selection: string) {
  try {
    window.localStorage.setItem(SELECTION_STORAGE_KEY, selection);
  } catch {
    // Selection is presentation state; the durable ledger remains authoritative.
  }
}

export interface WorldstateWorkbenchProps {
  initialView?: ProjectionView;
  session?: WorldstateSession;
  autoInitialize?: boolean;
  onSelectionChange?: (worldstateId: string) => void;
  onSemanticCommit?: () => void;
  onViewChange?: (view: ProjectionView) => void;
  /** Retained for API compatibility; agent execution is intentionally unavailable. */
  onAgentDispatch?: () => void;
  /** Retained for API compatibility; result integration is intentionally unavailable. */
  onResultIntegrate?: () => void;
}

export function WorldstateWorkbench({
  initialView,
  session,
  autoInitialize = true,
  onSelectionChange,
  onSemanticCommit,
  onViewChange,
}: WorldstateWorkbenchProps = {}) {
  const [ownedSession] = useState(createDefaultWorldstateSession);
  const activeSession = session ?? ownedSession;
  const snapshot = useSyncExternalStore(
    activeSession.subscribe,
    activeSession.getSnapshot,
    activeSession.getSnapshot,
  );
  const narrowDefault = useSyncExternalStore(
    subscribeToNarrowViewport,
    isNarrowViewport,
    () => false,
  );
  const initializedSession = useRef<WorldstateSession | null>(null);
  const selectionHydrated = useRef(false);
  const lastCandidateId = useRef<string | null>(null);
  const [selectedView, setSelectedView] = useState<ProjectionView | undefined>(
    initialView,
  );
  const [selectedId, setSelectedId] = useState<string>(HOME_MOVE_IDS.budget);
  const [draft, setDraft] = useState(DEFAULT_SOURCE);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [announcement, setAnnouncement] = useState(
    "Loading the durable browser ledger.",
  );
  const activeView = selectedView ?? (narrowDefault ? "focus" : "outline");
  const busy = snapshot.operationState !== "idle";

  useEffect(() => {
    if (!autoInitialize || initializedSession.current === activeSession) return;
    initializedSession.current = activeSession;
    void activeSession.initialize().catch((error: unknown) => {
      setAnnouncement(
        error instanceof Error ? error.message : "The browser ledger could not load.",
      );
    });
  }, [activeSession, autoInitialize]);

  const model = useMemo(() => {
    if (!snapshot.ledger || !snapshot.state) return null;
    const projected = buildWorkbenchViewModel({
      ledger: snapshot.ledger,
      state: snapshot.state,
      projectLabel: snapshot.document?.projectLabel,
      persistence: {
        state: snapshot.persistenceState,
        detail: snapshot.persistenceDetail ?? "Browser persistence state is unknown.",
      },
      placementOperation: {
        state: placementOperationState(snapshot.operationState),
        sourceId: snapshot.activeSourceId,
      },
      runtimeFallback: {
        mode: "unavailable",
        label: "Placement manager not observed yet",
      },
    });
    return {
      ...projected,
      placement: withSessionPlacementTruth(projected.placement, snapshot),
    };
  }, [snapshot]);

  useEffect(() => {
    if (!model) return;
    const visibleCandidateId =
      model.placement.candidateId &&
      model.nodes.some((node) => node.id === model.placement.candidateId)
        ? model.placement.candidateId
        : null;
    let active = true;
    const selectAfterRender = (selection: string) => {
      queueMicrotask(() => {
        if (active) setSelectedId(selection);
      });
    };

    if (!selectionHydrated.current) {
      const retryNodeId =
        snapshot.retry?.operation === "placement"
          ? snapshot.retry.selectedNodeId
          : null;
      const retrySelection =
        retryNodeId && model.nodes.some((node) => node.id === retryNodeId)
          ? retryNodeId
          : null;
      const initialSelection =
        visibleCandidateId ??
        retrySelection ??
        safeStoredSelection(model.nodes) ??
        (model.nodes.some((node) => node.id === HOME_MOVE_IDS.budget)
          ? HOME_MOVE_IDS.budget
          : model.projectNodeId);
      selectAfterRender(initialSelection);
      lastCandidateId.current = visibleCandidateId;
      selectionHydrated.current = true;
      return () => {
        active = false;
      };
    }

    if (
      visibleCandidateId &&
      visibleCandidateId !== lastCandidateId.current
    ) {
      lastCandidateId.current = visibleCandidateId;
      selectAfterRender(visibleCandidateId);
      storeSelection(visibleCandidateId);
      return () => {
        active = false;
      };
    }

    if (!model.nodes.some((node) => node.id === selectedId)) {
      selectAfterRender(model.projectNodeId);
      storeSelection(model.projectNodeId);
    }
    return () => {
      active = false;
    };
  }, [model, selectedId, snapshot.retry]);

  useEffect(() => {
    if (!model) return;
    const state = model.placement.state;
    const messages: Record<PlacementSurface["state"], string> = {
      idle: "The sandbox is ready. Capture a source to request placement.",
      loading: "The source is durable. Placement evidence is still being saved.",
      reviewable: "A persisted placement is ready for human review. Canonical state is unchanged.",
      needs_clarification: "The manager persisted a clarification request. No update can be committed.",
      failed: "The placement attempt failed. The captured source remains durable.",
      stale: "The placement is stale and cannot be committed against the current revision.",
      adopted: "The placement is adopted in the durable canonical revision.",
    };
    let active = true;
    queueMicrotask(() => {
      if (active) setAnnouncement(messages[state]);
    });
    return () => {
      active = false;
    };
  }, [model]);

  const selectObject = (id: string) => {
    setSelectedId(id);
    storeSelection(id);
    onSelectionChange?.(id);
    const label = model?.nodes.find((node) => node.id === id)?.label ?? id;
    setAnnouncement(`Selected ${label}.`);
  };

  const submitSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const source = draft.trim();
    if (!source || busy) return;
    setAnnouncement("Capturing the source before placement begins.");
    void activeSession.captureAndPlace(source, selectedId).catch((error: unknown) => {
      setAnnouncement(error instanceof Error ? error.message : "Placement could not start.");
    });
  };

  const retryPlacement = () => {
    if (busy) return;
    setAnnouncement("Retrying placement from the existing durable source.");
    void activeSession.retryPlacement().catch((error: unknown) => {
      setAnnouncement(error instanceof Error ? error.message : "Placement retry failed.");
    });
  };

  const acceptPlacement = () => {
    if (busy || !model?.placement.canAccept) return;
    const before = snapshot.state?.canonical.head.id;
    setAnnouncement("Saving the human semantic commit.");
    void activeSession
      .acceptActivePlacement()
      .then(() => {
        const after = activeSession.getSnapshot().state?.canonical.head.id;
        if (before && after && before !== after) onSemanticCommit?.();
      })
      .catch((error: unknown) => {
        setAnnouncement(error instanceof Error ? error.message : "Semantic commit failed.");
      });
  };

  const resetSandbox = () => {
    if (busy) return;
    if (!resetConfirming) {
      setResetConfirming(true);
      setAnnouncement("Reset requires one more explicit confirmation.");
      return;
    }

    setResetConfirming(false);
    void activeSession
      .resetSandbox()
      .then(() => {
        try {
          window.localStorage.removeItem(SELECTION_STORAGE_KEY);
        } catch {
          // The ledger reset is complete even when presentation storage is unavailable.
        }
        selectionHydrated.current = false;
        lastCandidateId.current = null;
        setSelectedId(HOME_MOVE_IDS.budget);
        setDraft(DEFAULT_SOURCE);
      })
      .catch((error: unknown) => {
        setAnnouncement(error instanceof Error ? error.message : "Sandbox reset failed.");
      });
  };

  if (!model) {
    const failed =
      snapshot.persistenceState === "unavailable" ||
      snapshot.persistenceState === "corrupt";
    return (
      <main
        className={styles.workbench}
        data-morphic-root="worldstate-workbench"
        data-persistence-state={snapshot.persistenceState}
      >
        <section aria-live="polite" className={styles.loadingShell}>
          <strong>{failed ? "Browser ledger unavailable" : "Loading your worldstate"}</strong>
          <span>
            {snapshot.persistenceDetail ?? "Opening IndexedDB and validating the project ledger."}
          </span>
          {failed ? (
            <button
              className={styles.resetButton}
              data-confirming={resetConfirming ? "true" : "false"}
              disabled={busy}
              onClick={resetSandbox}
              type="button"
            >
              {resetConfirming ? "Confirm local sandbox reset" : "Reset local sandbox"}
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  const selectedNode =
    model.nodes.find((node) => node.id === selectedId) ??
    model.nodes.find((node) => node.id === model.projectNodeId);

  return (
    <main
      className={styles.workbench}
      data-morphic-root="worldstate-workbench"
      data-persistence-state={model.persistence.state}
      data-runtime-mode={model.runtime.mode}
      data-selected-object-id={selectedId}
      data-view={activeView}
      data-worldstate-revision={model.revision}
    >
      <a className={styles.skipLink} href="#primary-projection">
        Skip to project projection
      </a>

      <header
        aria-label="World and project scope"
        className={styles.scopeRegion}
        data-morphic-region="scope"
      >
        <div className={styles.brandBlock} data-morphic-lane="world-navigation">
          <span aria-hidden="true" className={styles.brandSigil}>
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>ODEU</strong>
            <small>WORLDSTATE</small>
          </span>
        </div>

        <nav
          aria-label="Active worldstate scope"
          className={styles.scopeCrumbs}
          data-morphic-lane="active-scope"
        >
          <button type="button">{model.world}</button>
          <ChevronIcon />
          <button type="button">Projects</button>
          <ChevronIcon />
          <strong>{model.project}</strong>
        </nav>

        <div className={styles.runtimeCluster} data-morphic-lane="runtime-truth">
          <span className={styles.runtimeBadge} data-runtime-mode={model.runtime.mode}>
            <i /> {model.runtime.label}
          </span>
          <span aria-hidden="true" className={styles.iconButton}>
            <HistoryIcon />
          </span>
        </div>
      </header>

      <div className={styles.workbenchBody}>
        <div
          className={styles.primaryColumn}
          id="primary-projection"
          tabIndex={-1}
        >
          <SourceCapture
            busy={busy}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={submitSource}
            placement={model.placement}
          />
          <ProjectionSurface
            activeView={activeView}
            onSelect={selectObject}
            onViewChange={(view) => {
              setSelectedView(view);
              onViewChange?.(view);
              setAnnouncement(
                `${view[0].toUpperCase()}${view.slice(1)} view selected. ${selectedNode?.label ?? "Current object"} remains selected.`,
              );
            }}
            selectedId={selectedId}
            worldstate={model}
          />
        </div>

        <aside aria-label="Interpretation and evidence" className={styles.inspectorColumn}>
          <PlacementReceipt placement={model.placement} />
          <EvidencePanel model={model} />
          <GovernancePanel placement={model.placement} />
          <CommitPanel
            busy={busy}
            onAccept={acceptPlacement}
            onRetry={retryPlacement}
            placement={model.placement}
          />
        </aside>

        <WorkPanel reason={model.work.reason} />
      </div>

      <StatusRegion
        busy={busy}
        model={model}
        onReset={resetSandbox}
        resetConfirming={resetConfirming}
        selectedLabel={selectedNode?.label ?? selectedId}
      />

      <p aria-live="polite" className={styles.srOnly} role="status">
        {announcement}
      </p>
    </main>
  );
}

interface SourceCaptureProps {
  placement: PlacementSurface;
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function SourceCapture({
  placement,
  draft,
  busy,
  onDraftChange,
  onSubmit,
}: SourceCaptureProps) {
  if (!placement.sourceText) {
    return (
      <form className={styles.captureComposer} onSubmit={onSubmit}>
        <label>
          <span className={styles.regionKicker}>Capture a source</span>
          <textarea
            aria-label="Source text"
            disabled={busy}
            maxLength={4000}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Describe the idea or request you want placed in this project."
            value={draft}
          />
        </label>
        <button
          className={styles.captureButton}
          disabled={busy || !draft.trim()}
          type="submit"
        >
          {busy ? "Saving source…" : "Capture & place"}
        </button>
      </form>
    );
  }

  return (
    <section
      aria-label="Captured source"
      className={styles.sourceCapture}
      data-evidence-anchor="original-source"
      data-morphic-lane="source-capture"
      data-state="captured"
      data-state-family="source"
      data-state-surface="source-event-surface"
    >
      <span className={styles.sourceIcon}>
        <SparkIcon />
      </span>
      <div>
        <span className={styles.regionKicker}>
          Original source · {placement.sourceCapturedAt ?? "persisted"}
        </span>
        <blockquote>“{placement.sourceText}”</blockquote>
      </div>
      <span className={styles.immutableTag}>
        <LinkIcon /> Source preserved
      </span>
    </section>
  );
}

function PlacementReceipt({ placement }: { placement: PlacementSurface }) {
  const posture = placementPosture(placement.state);
  const uncertainties = placementUncertainties(placement);

  return (
    <section
      aria-labelledby="placement-heading"
      className={styles.receiptPanel}
      data-morphic-region="interpretation"
      data-state={posture}
      data-state-family="governance"
      data-state-surface={placementStateSurface(placement.state)}
    >
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.regionKicker}>Where this fits</span>
          <h2 id="placement-heading">Placement receipt</h2>
        </div>
        <span className={styles.postureBadge} data-state={posture}>
          <i /> {placementStateLabel(placement.state)}
        </span>
      </div>

      {placement.breadcrumb.length ? (
        <div className={styles.placementPath} data-morphic-lane="placement-receipt">
          {placement.breadcrumb.map((segment, index) => (
            <span key={`${segment}-${index}`}>
              {index > 0 ? <ChevronIcon /> : null}
              {index === placement.breadcrumb.length - 1 &&
              segment === placement.proposedTitle ? (
                <strong data-worldstate-id={placement.candidateId ?? undefined}>
                  {segment}
                </strong>
              ) : (
                <span>{segment}</span>
              )}
            </span>
          ))}
          {placement.proposedTitle &&
          placement.breadcrumb.at(-1) !== placement.proposedTitle ? (
            <>
              <ChevronIcon />
              <strong data-worldstate-id={placement.candidateId ?? undefined}>
                {placement.proposedTitle}
              </strong>
            </>
          ) : null}
        </div>
      ) : (
        <div className={styles.surfaceNotice} data-state={placement.state}>
          {placement.state === "idle"
            ? "No placement has been requested yet."
            : placement.gateReason}
        </div>
      )}

      {placement.proposedTitle ? (
        <dl className={styles.receiptFacts}>
          <div>
            <dt>Interpreted as</dt>
            <dd>
              {placement.proposedKind} · {placement.proposedTitle}
            </dd>
          </div>
          <div>
            <dt>Why here</dt>
            <dd>{placement.rationale ?? "No rationale was returned."}</dd>
          </div>
          <div>
            <dt>Expected effect</dt>
            <dd>{placement.visibleConsequence ?? placement.proposedSummary}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{placement.confidence ?? "Not reported"}</dd>
          </div>
        </dl>
      ) : null}

      {uncertainties.length ? (
        <div
          className={styles.openQuestion}
          data-evidence-anchor="material-uncertainty"
          data-state="open"
          data-state-family="knowledge"
          data-state-surface="warning-status-surface"
        >
          <span>?</span>
          <div>
            <strong>
              {placement.state === "needs_clarification"
                ? "Clarification required"
                : uncertainties.length === 1
                  ? "One question stays open"
                  : `${uncertainties.length} questions stay open`}
            </strong>
            <ul>
              {uncertainties.map((uncertainty) => (
                <li key={uncertainty}>{uncertainty}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {placement.affectedTitles.length ||
      placement.alternatives.length ||
      placement.conflicts.length ? (
        <div className={styles.receiptContext} data-evidence-anchor="placement-context">
          {placement.affectedTitles.length ? (
            <div>
              <strong>Affected context</strong>
              <ul>
                {placement.affectedTitles.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {placement.alternatives.length ? (
            <div>
              <strong>Alternative placement</strong>
              <ul>
                {placement.alternatives.map((alternative) => (
                  <li key={`${alternative.title}:${alternative.rationale}`}>
                    <b>{alternative.title}</b> — {alternative.rationale}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {placement.conflicts.length ? (
            <div>
              <strong>Conflicts</strong>
              <ul>
                {placement.conflicts.map((conflict) => (
                  <li
                    className={styles.conflictItem}
                    data-severity={conflict.severity}
                    key={`${conflict.title}:${conflict.reason}`}
                  >
                    <span className={styles.conflictSeverity}>
                      {conflict.severity === "material" ? "Material" : "Notice"}
                    </span>
                    <span>
                      <b>{conflict.title}</b> — {conflict.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {placement.errorMessage ? (
        <div
          className={styles.surfaceNotice}
          data-state={placement.state === "stale" ? "stale" : "failed"}
          role="alert"
        >
          <strong>{placement.errorCode ?? "placement_failed"}</strong>
          <p>{placement.errorMessage}</p>
        </div>
      ) : null}
    </section>
  );
}

function EvidencePanel({ model }: { model: WorkbenchViewModel }) {
  const placement = model.placement;
  const adopted = placement.state === "adopted";
  const knowledge = knowledgeStatus(placement);
  const governance = governanceStatus(placement);
  const linkedRecordCount = [
    model.revision,
    placement.sourceId,
    placement.exchangeId,
    placement.deltaId,
  ].filter(Boolean).length;

  return (
    <section
      aria-labelledby="evidence-heading"
      className={styles.evidencePanel}
      data-morphic-region="evidence"
      data-morphic-lane="evidence-chain"
    >
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.regionKicker}>Why the UI says this</span>
          <h2 id="evidence-heading">Evidence &amp; status</h2>
        </div>
        <span className={styles.evidenceCount}>
          {String(linkedRecordCount).padStart(2, "0")} linked{" "}
          {linkedRecordCount === 1 ? "record" : "records"}
        </span>
      </div>

      <div className={styles.statusFamilies}>
        <div
          data-state={knowledge.state}
          data-state-family="knowledge"
          data-state-surface={knowledge.surface}
        >
          <span>Knowledge</span>
          <strong>{knowledge.label}</strong>
          <small>{knowledge.detail}</small>
        </div>
        <div
          data-state={governance.state}
          data-state-family="governance"
          data-state-surface={governance.surface}
        >
          <span>Governance</span>
          <strong>{governance.label}</strong>
          <small>{governance.detail}</small>
        </div>
        <div
          data-state="unavailable"
          data-state-family="work"
          data-state-surface="diagnostic-status-surface"
        >
          <span>Work</span>
          <strong>Unavailable</strong>
          <small>Not dispatched</small>
        </div>
      </div>

      <ul className={styles.evidenceList}>
        <li data-evidence-anchor="source-utterance">
          <span className={styles.evidenceGlyph}>01</span>
          <div>
            <strong>Original source</strong>
            <small>{placement.sourceId ?? "No source captured yet"}</small>
          </div>
          <span>{placement.sourceId ? "Exact" : "Waiting"}</span>
        </li>
        <li data-evidence-anchor="placement-exchange">
          <span className={styles.evidenceGlyph}>02</span>
          <div>
            <strong>Manager exchange</strong>
            <small>
              {placement.receiptId ??
                placement.exchangeId ??
                "No persisted manager exchange yet"}
            </small>
          </div>
          <span>{placement.exchangeId ? "Persisted" : "Waiting"}</span>
        </li>
        <li data-evidence-anchor="pending-delta">
          <span className={styles.evidenceGlyph}>03</span>
          <div>
            <strong>Placement delta</strong>
            <small>{placement.deltaId ?? "No pending delta"}</small>
          </div>
          <span>{adopted ? "Adopted" : placement.deltaId ? "Pending" : "None"}</span>
        </li>
        <li data-evidence-anchor="canonical-head">
          <span className={styles.evidenceGlyph}>04</span>
          <div>
            <strong>Canonical head</strong>
            <small>{model.revision}</small>
          </div>
          <span>Current</span>
        </li>
      </ul>
    </section>
  );
}

function GovernancePanel({ placement }: { placement: PlacementSurface }) {
  const adopted = placement.state === "adopted";
  return (
    <section
      aria-labelledby="governance-heading"
      className={styles.governancePanel}
      data-morphic-region="governance"
      data-morphic-lane="authority-envelope"
    >
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.regionKicker}>Rules &amp; permissions</span>
          <h2 id="governance-heading">Authority envelope</h2>
        </div>
        <ShieldIcon />
      </div>
      <div className={styles.governanceGrid}>
        <div>
          <span>Worldstate change</span>
          <strong>{adopted ? "Granted once" : "Not granted"}</strong>
          <small>Only the displayed atomic placement</small>
        </div>
        <div>
          <span>Agent authority</span>
          <strong>Not granted</strong>
          <small>No brief, run, or worker permission exists</small>
        </div>
        <div>
          <span>External publishing</span>
          <strong>Disallowed</strong>
          <small>This slice only changes the local browser ledger</small>
        </div>
      </div>
    </section>
  );
}

interface CommitPanelProps {
  placement: PlacementSurface;
  busy: boolean;
  onAccept: () => void;
  onRetry: () => void;
}

function CommitPanel({ placement, busy, onAccept, onRetry }: CommitPanelProps) {
  return (
    <section
      aria-label="Semantic commit"
      className={styles.commitPanel}
      data-morphic-region="semantic-commit"
    >
      <div
        className={styles.commitBoundary}
        data-action-cluster="semantic-commit"
        data-gate="accept-delta"
        data-gate-state={
          placement.state === "adopted"
            ? "satisfied"
            : placement.canAccept
              ? "ready"
              : "blocked"
        }
        data-morphic-lane="semantic-commit-boundary"
      >
        <span className={styles.boundaryLabel}>
          <ShieldIcon /> Semantic commit boundary
        </span>
        <p>{placement.gateReason}</p>
        {placement.retryable ? (
          <div className={styles.secondaryActions}>
            <button
              className={styles.retryButton}
              disabled={busy}
              onClick={onRetry}
              type="button"
            >
              Retry from preserved source
            </button>
          </div>
        ) : null}
        <button
          className={styles.commitButton}
          data-semantic-action="accept-placement"
          disabled={busy || !placement.canAccept}
          onClick={onAccept}
          type="button"
        >
          {placement.state === "adopted" ? <CheckIcon /> : <ShieldIcon />}
          {placement.state === "adopted"
            ? "Placement adopted"
            : busy
              ? "Saving…"
              : placement.errorCode && placement.canAccept
                ? "Retry semantic commit"
                : "Adopt this placement"}
        </button>
      </div>
    </section>
  );
}

function WorkPanel({ reason }: { reason: string }) {
  return (
    <section
      aria-labelledby="work-heading"
      className={styles.workRegion}
      data-morphic-region="work"
      data-state="unavailable"
      data-state-family="work"
    >
      <div className={styles.workIntro}>
        <div>
          <span className={styles.regionKicker}>Bounded agent work</span>
          <h2 id="work-heading">Work remains a separate decision</h2>
        </div>
        <p>
          Semantic placement does not compile a brief, authorize a worker, or claim completion.
        </p>
      </div>
      <div
        className={styles.workUnavailable}
        data-action-cluster="agent-delegation"
        data-gate="dispatch-agent"
        data-gate-state="unavailable"
      >
        <span aria-hidden="true">—</span>
        <div>
          <strong>Agent execution unavailable in this slice</strong>
          <p>{reason}</p>
        </div>
      </div>
    </section>
  );
}

interface StatusRegionProps {
  busy: boolean;
  model: WorkbenchViewModel;
  selectedLabel: string;
  resetConfirming: boolean;
  onReset: () => void;
}

function StatusRegion({
  busy,
  model,
  selectedLabel,
  resetConfirming,
  onReset,
}: StatusRegionProps) {
  return (
    <footer className={styles.statusRegion} data-morphic-region="status">
      <div
        data-morphic-lane="revision-sync"
        data-state="current"
        data-state-family="revision"
        data-state-surface="authoritative-status-surface"
      >
        <span className={styles.statusLight} />
        <span>
          <small>Canonical revision</small>
          <strong>{model.revision}</strong>
        </span>
      </div>
      <div data-morphic-lane="selection-status">
        <span>
          <small>Selected context</small>
          <strong>{selectedLabel}</strong>
        </span>
      </div>
      <div
        data-morphic-lane="runtime-status"
        data-runtime-mode={model.runtime.mode}
        data-state={model.persistence.state}
        data-state-family="runtime"
        data-state-surface="diagnostic-status-surface"
      >
        <HistoryIcon />
        <span>
          <small>Persistence &amp; manager</small>
          <strong>
            {model.persistence.state} · {model.runtime.label}
          </strong>
          <em className={styles.persistenceDetail}>
            {model.persistence.detail}
          </em>
        </span>
      </div>
      <div className={styles.resetLane} data-morphic-lane="sandbox-reset">
        <button
          className={styles.resetButton}
          data-confirming={resetConfirming ? "true" : "false"}
          disabled={busy}
          onClick={onReset}
          type="button"
        >
          <HistoryIcon />
          {resetConfirming ? "Confirm reset" : "Reset sandbox"}
        </button>
      </div>
    </footer>
  );
}
