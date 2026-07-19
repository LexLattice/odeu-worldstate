"use client";

import {
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { createBrowserAgentGateway } from "@/adapters/codex/browser";
import {
  createBrowserArtifactPromotionGateway,
  createBrowserArtifactPromotionStatusGetter,
} from "@/adapters/artifact-promotion/browser";
import {
  createBrowserAgentRuntimeCapabilityGetter,
  createBrowserLiveAuthorizationGateway,
  createBrowserLiveRunStatusGetter,
} from "@/adapters/codex/browser-live-authorization";
import { createBrowserLiveEvidenceGateway } from "@/adapters/live-evidence";
import { createBrowserPlacementGateway } from "@/adapters/manager/browser";
import { createBrowserReplayEvidenceGateway } from "@/adapters/replay-evidence";
import { createBrowserWorldstateLedgerStore } from "@/adapters/storage/worldstate-client";
import {
  clearMemoryOnlyOperatorCredential,
  setMemoryOnlyOperatorCredential,
} from "@/adapters/operator-authorization/browser";
import {
  createWorldstateSession,
  type WorldstateSession,
  type WorldstateSessionIdKind,
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
import type {
  WorldstatePresentationCommand,
  WorldstatePresentationState,
} from "./presentation";
import { ProjectionSurface } from "./projections";
import type {
  PlacementSurface,
  ProjectionView,
  WorkSurface,
  WorkSurfaceState,
  WorkbenchViewModel,
} from "./types";
import { buildWorkbenchViewModel } from "./view-model";
import styles from "./worldstate-workbench.module.css";

const DEFAULT_SOURCE =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";
const SELECTION_STORAGE_KEY = "odeu.worldstate.project-home-move.selection";

let fallbackId = 0;

function nextBrowserId(kind: WorldstateSessionIdKind) {
  const identity = globalThis.crypto?.randomUUID?.() ?? `local-${++fallbackId}`;
  return `${kind}:${identity}`;
}

function createDefaultWorldstateSession(): WorldstateSession {
  return createWorldstateSession({
    store: createBrowserWorldstateLedgerStore(),
    placementGateway: createBrowserPlacementGateway(),
    agentGateway: createBrowserAgentGateway(),
    agentRuntimeCapabilityGetter: createBrowserAgentRuntimeCapabilityGetter(),
    liveAuthorizationGateway: createBrowserLiveAuthorizationGateway(),
    liveRunStatusGetter: createBrowserLiveRunStatusGetter(),
    liveEvidenceGateway: createBrowserLiveEvidenceGateway(),
    replayEvidenceGateway: createBrowserReplayEvidenceGateway(),
    artifactPromotionGateway: createBrowserArtifactPromotionGateway(),
    artifactPromotionStatusGetter: createBrowserArtifactPromotionStatusGetter(),
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

type DelegationOperationState =
  | "idle"
  | "preparing_brief"
  | "authorizing_run"
  | "dispatching_run"
  | "persisting_run_result"
  | "validating_evidence"
  | "persisting_validation"
  | "proposing_reconciliation"
  | "integrating_result"
  | "proposing_promotion"
  | "authorizing_promotion"
  | "promoting_artifact"
  | "persisting_promotion_receipt";

function delegationOperationState(
  operation: WorldstateSessionOperationState,
): DelegationOperationState {
  switch (operation as string) {
    case "preparing_brief":
    case "authorizing_run":
    case "dispatching_run":
    case "persisting_run_result":
    case "validating_evidence":
    case "persisting_validation":
    case "proposing_reconciliation":
    case "integrating_result":
    case "proposing_promotion":
    case "authorizing_promotion":
    case "promoting_artifact":
    case "persisting_promotion_receipt":
      return operation as DelegationOperationState;
    default:
      return "idle";
  }
}

function workStateLabel(state: WorkSurfaceState): string {
  const labels: Record<WorkSurfaceState, string> = {
    ineligible: "Unavailable",
    eligible: "Ready to prepare",
    preparing: "Preparing brief",
    previewable: "Brief ready",
    authorizing: "Authorizing replay",
    dispatching: "Replay in flight",
    persisting_result: "Saving result",
    queued: "Queued",
    received: "Received",
    working: "Working",
    blocked: "Blocked",
    outcome_unknown: "Outcome unknown",
    returned: "Returned · unverified",
    failed: "Failed",
    cancelled: "Cancelled",
    quarantined: "Exchange quarantined",
    stale: "Stale",
  };
  return labels[state];
}

function workStateSurface(state: WorkSurfaceState): string {
  if (
    state === "stale" ||
    state === "blocked" ||
    state === "outcome_unknown" ||
    state === "quarantined"
  ) {
    return "warning-status-surface";
  }
  if (state === "returned" || state === "previewable") {
    return "provisional-status-surface";
  }
  return "diagnostic-status-surface";
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

function workStatus(work: WorkSurface): {
  state: string;
  label: string;
  detail: string;
  surface: string;
} {
  if (work.state === "returned") {
    return {
      state: "returned-unverified",
      label: "Returned",
      detail: "Worker claim · unverified",
      surface: "provisional-status-surface",
    };
  }
  if (work.state === "stale") {
    return {
      state: "stale",
      label: "Out of date",
      detail: "Revision changed",
      surface: "warning-status-surface",
    };
  }
  if (work.state === "outcome_unknown") {
    return {
      state: "outcome-unknown",
      label: "Outcome unknown",
      detail: "No terminal outcome or closure",
      surface: "warning-status-surface",
    };
  }
  if (work.state === "quarantined") {
    return {
      state: "quarantined",
      label: "Quarantined",
      detail: "Exact exchange rejected",
      surface: "warning-status-surface",
    };
  }
  if (work.state === "blocked" || work.state === "failed") {
    return {
      state: work.state,
      label: work.state === "blocked" ? "Blocked" : "Failed",
      detail: "No canonical change",
      surface: "warning-status-surface",
    };
  }
  if (work.state === "ineligible") {
    return {
      state: "unavailable",
      label: "Unavailable",
      detail: "Not dispatched",
      surface: "diagnostic-status-surface",
    };
  }
  return {
    state: work.state,
    label: workStateLabel(work.state),
    detail:
      work.run?.id ?? work.brief?.id ?? "Accepted task · no worker authority",
    surface:
      work.state === "previewable"
        ? "provisional-status-surface"
        : "diagnostic-status-surface",
  };
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

function safeStoredSelection(
  nodes: WorkbenchViewModel["nodes"],
): string | null {
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
  mutationAccess?: "enabled" | "presentation-only";
  presentationCommand?: WorldstatePresentationCommand;
  onOperationBusyChange?: (busy: boolean) => void;
  onPresentationStateChange?: (
    state: WorldstatePresentationState,
  ) => void;
  onSelectionChange?: (worldstateId: string) => void;
  onSemanticCommit?: () => void;
  onViewChange?: (view: ProjectionView) => void;
  onAgentDispatch?: () => void;
  onEvidenceValidate?: () => void;
  onReconciliationPropose?: () => void;
  onResultIntegrate?: () => void;
  onArtifactPromotionPropose?: () => void;
  onArtifactPromote?: () => void;
}

function MutationAccessNotice({ id }: { readonly id: string }) {
  return (
    <div
      className={styles.mutationAccessNotice}
      data-morphic-lane="presentation-only-access"
      data-state-surface="diagnostic-status-surface"
      id={id}
      role="status"
    >
      <ShieldIcon />
      <span>
        <strong>Presentation-only opening</strong>
        <small>
          Finish or skip the opening guide to restore durable, provider, and
          authority-increasing actions. Current evidence and eligibility are
          unchanged.
        </small>
      </span>
    </div>
  );
}

export function WorldstateWorkbench({
  initialView,
  session,
  autoInitialize = true,
  mutationAccess = "enabled",
  presentationCommand,
  onOperationBusyChange,
  onPresentationStateChange,
  onSelectionChange,
  onSemanticCommit,
  onAgentDispatch,
  onEvidenceValidate,
  onReconciliationPropose,
  onResultIntegrate,
  onArtifactPromotionPropose,
  onArtifactPromote,
  onViewChange,
}: WorldstateWorkbenchProps = {}) {
  const [ownedSession] = useState(createDefaultWorldstateSession);
  const mutationAccessDescriptionId = useId();
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
  const handledPresentationCommandIds = useRef(new Set<string>());
  const localOperationPendingRef = useRef(false);
  const onOperationBusyChangeRef = useRef(onOperationBusyChange);
  const onPresentationStateChangeRef = useRef(onPresentationStateChange);
  const [selectedView, setSelectedView] = useState<ProjectionView | undefined>(
    initialView,
  );
  const [selectedId, setSelectedId] = useState<string>(HOME_MOVE_IDS.budget);
  const [draft, setDraft] = useState(DEFAULT_SOURCE);
  const [operatorCredentialDraft, setOperatorCredentialDraft] = useState("");
  const [operatorCredentialReady, setOperatorCredentialReady] = useState(false);
  const [localOperationPending, setLocalOperationPending] = useState(false);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [announcement, setAnnouncement] = useState(
    "Loading the durable browser ledger.",
  );
  const activeView = selectedView ?? (narrowDefault ? "focus" : "outline");
  const busy = localOperationPending || snapshot.operationState !== "idle";
  const mutationsDisabled = mutationAccess !== "enabled";
  const validatingEvidence =
    snapshot.operationState === "validating_evidence" ||
    snapshot.operationState === "persisting_validation";
  const proposingReconciliation =
    snapshot.operationState === "proposing_reconciliation";
  const integratingResult = snapshot.operationState === "integrating_result";
  const proposingPromotion =
    snapshot.operationState === "proposing_promotion";
  const promotingArtifact =
    snapshot.operationState === "authorizing_promotion" ||
    snapshot.operationState === "promoting_artifact" ||
    snapshot.operationState === "persisting_promotion_receipt";

  useEffect(() => {
    if (!autoInitialize || initializedSession.current === activeSession) return;
    initializedSession.current = activeSession;
    void activeSession.initialize().catch((error: unknown) => {
      setAnnouncement(
        error instanceof Error
          ? error.message
          : "The browser ledger could not load.",
      );
    });
  }, [activeSession, autoInitialize]);

  useEffect(
    () => () => {
      clearMemoryOnlyOperatorCredential();
    },
    [],
  );

  useEffect(() => {
    onOperationBusyChangeRef.current = onOperationBusyChange;
    onPresentationStateChangeRef.current = onPresentationStateChange;
  }, [onOperationBusyChange, onPresentationStateChange]);

  useEffect(() => {
    onOperationBusyChangeRef.current?.(busy);
  }, [busy]);

  const runTrackedOperation = (
    operation: () => Promise<void>,
  ): Promise<void> | null => {
    if (localOperationPendingRef.current) return null;
    localOperationPendingRef.current = true;
    setLocalOperationPending(true);

    let pending: Promise<void>;
    try {
      pending = operation();
    } catch (error) {
      localOperationPendingRef.current = false;
      setLocalOperationPending(false);
      return Promise.reject(error);
    }

    return pending.finally(() => {
      localOperationPendingRef.current = false;
      setLocalOperationPending(false);
    });
  };

  const model = useMemo(() => {
    if (!snapshot.ledger || !snapshot.state) return null;
    const projected = buildWorkbenchViewModel({
      ledger: snapshot.ledger,
      state: snapshot.state,
      projectLabel: snapshot.document?.projectLabel,
      persistence: {
        state: snapshot.persistenceState,
        detail:
          snapshot.persistenceDetail ?? "Browser persistence state is unknown.",
      },
      placementOperation: {
        state: placementOperationState(snapshot.operationState),
        sourceId: snapshot.activeSourceId,
      },
      workOperation: {
        state: delegationOperationState(snapshot.operationState),
        activeBriefId: snapshot.activeBriefId,
        activeRunId: snapshot.activeRunId,
        activeAgentRequestId: snapshot.activeAgentRequestId,
        activeClosureId: snapshot.activeClosureId,
        activeValidationRequestId: snapshot.activeValidationRequestId,
        activeReconciliationDeltaId: snapshot.activeReconciliationDeltaId,
        activeIntegratedRevisionId: snapshot.activeIntegratedRevisionId,
        activeArtifactPromotionId: snapshot.activeArtifactPromotionId,
        hostAttestedArtifactPromotionReceiptDigests:
          snapshot.hostAttestedArtifactPromotionReceiptDigests,
        error:
          snapshot.error &&
          (snapshot.error.scope === "delegation" ||
            snapshot.error.scope === "validation" ||
            snapshot.error.scope === "reconciliation" ||
            snapshot.error.scope === "integration" ||
            snapshot.error.scope === "artifact_promotion")
            ? {
                code: snapshot.error.code,
                message: snapshot.error.message,
              }
            : null,
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

    if (visibleCandidateId && visibleCandidateId !== lastCandidateId.current) {
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
    if (
      !model ||
      !presentationCommand ||
      handledPresentationCommandIds.current.has(presentationCommand.id)
    ) {
      return;
    }

    let active = true;
    queueMicrotask(() => {
      if (
        !active ||
        handledPresentationCommandIds.current.has(presentationCommand.id)
      ) {
        return;
      }
      handledPresentationCommandIds.current.add(presentationCommand.id);

      switch (presentationCommand.type) {
        case "select_project":
          if (presentationCommand.projectId !== model.projectId) return;
          setAnnouncement(`${model.project} is the active project.`);
          return;
        case "select_view":
          setSelectedView(presentationCommand.view);
          onViewChange?.(presentationCommand.view);
          setAnnouncement(
            `${presentationCommand.view[0].toUpperCase()}${presentationCommand.view.slice(1)} view selected.`,
          );
          return;
        case "select_object": {
          const selected = model.nodes.find(
            (node) => node.id === presentationCommand.objectId,
          );
          if (!selected) return;
          setSelectedId(selected.id);
          onSelectionChange?.(selected.id);
          setAnnouncement(`Selected ${selected.label}.`);
        }
      }
    });

    return () => {
      active = false;
    };
  }, [model, onSelectionChange, onViewChange, presentationCommand]);

  const presentationState = useMemo<WorldstatePresentationState | null>(
    () =>
      model
        ? {
            projectId: model.projectId,
            projectLabel: model.project,
            view: activeView,
            selectedObjectId: selectedId,
            selectedObjectLabel:
              model.nodes.find((node) => node.id === selectedId)?.label ??
              selectedId,
          }
        : null,
    [activeView, model, selectedId],
  );

  useEffect(() => {
    if (presentationState) {
      onPresentationStateChangeRef.current?.(presentationState);
    }
  }, [presentationState]);

  useEffect(() => {
    if (!model) return;
    const placementMessages: Record<PlacementSurface["state"], string> = {
      idle: "The sandbox is ready. Capture a source to request placement.",
      loading:
        "The source is durable. Placement evidence is still being saved.",
      reviewable:
        "A persisted placement is ready for human review. Canonical state is unchanged.",
      needs_clarification:
        "The manager persisted a clarification request. No update can be committed.",
      failed:
        "The placement attempt failed. The captured source remains durable.",
      stale:
        "The placement is stale and cannot be committed against the current revision.",
      adopted: "The placement is adopted in the durable canonical revision.",
    };
    const liveRuntime = model.work.runtime.effectiveMode === "live";
    const runLabel = liveRuntime ? "live Codex run" : "fixture replay";
    const workMessages: Record<WorkSurfaceState, string> = {
      ineligible: "Adopt a placement before preparing agent work.",
      eligible:
        "The accepted task can now be projected into a bounded agent brief.",
      preparing:
        "The agent brief is being compiled and saved without dispatching work.",
      previewable:
        "The durable brief is ready for evidence and authority review.",
      authorizing: `One ${runLabel} is being authorized and saved.`,
      dispatching: `The bounded ${runLabel} request is in flight.`,
      persisting_result: `The exact ${runLabel} result, lifecycle, and any lawful closure are being saved.`,
      queued: `The ${runLabel} is durably queued.`,
      received: `The ${runLabel} received the immutable brief.`,
      working: `The ${runLabel} is presenting its bounded work result.`,
      blocked:
        "The worker is blocked; its report is preserved without a closure.",
      outcome_unknown:
        "The run outcome is unknown; no terminal outcome or closure is inferred.",
      returned: "A worker closure is staged for review and remains unverified.",
      failed: "The worker run failed without changing canonical worldstate.",
      cancelled:
        "The worker run was cancelled without changing canonical worldstate.",
      quarantined:
        "The exact exchange was quarantined; its report and closure are not projected.",
      stale: "The work evidence is based on an older canonical revision.",
    };
    const validationMessage = validatingEvidence
      ? "Independent evidence validation is in progress. Canonical worldstate remains unchanged."
      : model.work.validation
        ? model.work.validation.verdict === "verified"
          ? model.work.validation.consumedByRevisionId
            ? `Independent validation evidence was consumed by ${model.work.validation.consumedByRevisionId}.`
            : "Independent validation recorded current evidence for every required check. A separate reconciliation proposal may now be prepared."
          : model.work.validation.verdict === "stale"
            ? "Independent validation is stale. Canonical worldstate remains unchanged."
            : "Independent validation did not satisfy every required check. Canonical worldstate remains unchanged."
        : null;
    const reconciliationMessage = proposingReconciliation
      ? "The reconciliation candidate is being saved without canonical mutation."
      : integratingResult
        ? "The reviewed reconciliation candidate is being committed at the human integration boundary."
        : model.work.reconciliation.state === "integrated"
          ? `The reviewed result is integrated in ${model.work.reconciliation.candidate?.acceptedRevisionId ?? "a canonical revision"}.`
          : model.work.reconciliation.state === "candidate"
            ? "A reconciliation candidate is staged for human review. Canonical worldstate is unchanged."
            : model.work.reconciliation.state === "blocked" ||
                model.work.reconciliation.state === "stale" ||
                model.work.reconciliation.state === "failed"
              ? model.work.reconciliation.integrationGateReason
              : null;
    const promotionMessage = proposingPromotion
      ? "The artifact-promotion proposal is being saved; no Git ref is moving."
      : promotingArtifact
        ? "The separate human promotion boundary is verifying the exact candidate and target-ref outcome."
        : model.work.artifactPromotion.state === "promoted" ||
            model.work.artifactPromotion.state === "stale" ||
            model.work.artifactPromotion.state === "failed" ||
            model.work.artifactPromotion.state === "outcome_unknown"
          ? model.work.artifactPromotion.gateReason
          : null;
    const message =
      model.placement.state === "adopted"
        ? (promotionMessage ??
          reconciliationMessage ??
          validationMessage ??
          workMessages[model.work.state])
        : placementMessages[model.placement.state];
    let active = true;
    queueMicrotask(() => {
      if (active) setAnnouncement(message);
    });
    return () => {
      active = false;
    };
  }, [
    integratingResult,
    model,
    promotingArtifact,
    proposingPromotion,
    proposingReconciliation,
    validatingEvidence,
  ]);

  const selectObject = (id: string) => {
    setSelectedId(id);
    storeSelection(id);
    onSelectionChange?.(id);
    const label = model?.nodes.find((node) => node.id === id)?.label ?? id;
    setAnnouncement(`Selected ${label}.`);
  };

  const authorizeOperator = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutationsDisabled || busy || !operatorCredentialDraft) return;
    try {
      setMemoryOnlyOperatorCredential(operatorCredentialDraft);
      setOperatorCredentialDraft("");
      setOperatorCredentialReady(true);
      setAnnouncement(
        "Transient operator authority is available in page memory only. Recovering any server-held status now.",
      );
      const operation = runTrackedOperation(() => activeSession.initialize());
      if (!operation) return;
      void operation.catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error
            ? error.message
            : "Operator status recovery could not complete.",
        );
      });
    } catch (error) {
      setOperatorCredentialReady(false);
      setAnnouncement(
        error instanceof Error
          ? error.message
          : "The transient operator credential is invalid.",
      );
    }
  };

  const clearOperatorAuthority = () => {
    clearMemoryOnlyOperatorCredential();
    setOperatorCredentialDraft("");
    setOperatorCredentialReady(false);
    setAnnouncement("Transient operator authority was cleared from page memory.");
  };

  const submitSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const source = draft.trim();
    if (mutationsDisabled || !source || busy) return;
    setAnnouncement("Capturing the source before placement begins.");
    const operation = runTrackedOperation(() =>
      activeSession.captureAndPlace(source, selectedId),
    );
    if (!operation) return;
    void operation.catch((error: unknown) => {
      setAnnouncement(
        error instanceof Error ? error.message : "Placement could not start.",
      );
    });
  };

  const retryPlacement = () => {
    if (mutationsDisabled || busy) return;
    setAnnouncement("Retrying placement from the existing durable source.");
    const operation = runTrackedOperation(() => activeSession.retryPlacement());
    if (!operation) return;
    void operation.catch((error: unknown) => {
      setAnnouncement(
        error instanceof Error ? error.message : "Placement retry failed.",
      );
    });
  };

  const acceptPlacement = () => {
    if (mutationsDisabled || busy || !model?.placement.canAccept) return;
    const before = snapshot.state?.canonical.head.id;
    setAnnouncement("Saving the human semantic commit.");
    const operation = runTrackedOperation(() =>
      activeSession.acceptActivePlacement(),
    );
    if (!operation) return;
    void operation
      .then(() => {
        const after = activeSession.getSnapshot().state?.canonical.head.id;
        if (before && after && before !== after) onSemanticCommit?.();
      })
      .catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error ? error.message : "Semantic commit failed.",
        );
      });
  };

  const prepareAgentBrief = () => {
    if (mutationsDisabled || busy || !model?.work.canPrepare) return;
    setAnnouncement(
      "Preparing a durable agent brief. This does not authorize or dispatch a worker.",
    );
    const operation = runTrackedOperation(() =>
      activeSession.prepareActiveAgentBrief(),
    );
    if (!operation) return;
    void operation.catch((error: unknown) => {
      setAnnouncement(
        error instanceof Error
          ? error.message
          : "Agent brief preparation failed.",
      );
    });
  };

  const authorizeFixtureReplay = () => {
    if (
      mutationsDisabled ||
      busy ||
      (!model?.work.canAuthorize && !model?.work.canRetryDispatch)
    ) {
      return;
    }
    const retryingExactDispatch = model.work.canRetryDispatch;
    setAnnouncement(
      retryingExactDispatch
        ? "Retrying the exact durable live request after the private server confirmed execution never started. No new authority is created."
        : `Authorizing one ${model.work.runtime.effectiveMode === "live" ? "live run" : "fixture replay"} from the displayed immutable brief.`,
    );
    const operation = runTrackedOperation(() =>
      activeSession[
        retryingExactDispatch
          ? "retryActiveLiveDispatch"
          : "authorizeAndDispatchActiveBrief"
      ](),
    );
    if (!operation) return;
    void operation
      .then(() => {
        if (activeSession.getSnapshot().activeRunId) {
          onAgentDispatch?.();
        }
      })
      .catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error ? error.message : "Agent dispatch failed.",
        );
      });
  };

  const validateReplayEvidence = () => {
    if (mutationsDisabled || busy || !model?.work.canValidate) return;
    setAnnouncement(
      "Running an independent validator against the displayed evidence contract.",
    );
    const operation = runTrackedOperation(() =>
      activeSession.validateActiveEvidence(),
    );
    if (!operation) return;
    void operation
      .then(() => {
        onEvidenceValidate?.();
        setAnnouncement(
          "Independent validation evidence is durable. Canonical worldstate remains unchanged.",
        );
      })
      .catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error
            ? error.message
            : "Independent evidence validation failed.",
        );
      });
  };

  const proposeReconciliation = () => {
    if (
      mutationsDisabled ||
      busy ||
      !model?.work.reconciliation.canPropose
    ) {
      return;
    }
    setAnnouncement(
      "Preparing an evidence-bound reconciliation candidate. Canonical worldstate will remain unchanged.",
    );
    const operation = runTrackedOperation(() =>
      activeSession.proposeActiveReconciliation(),
    );
    if (!operation) return;
    void operation
      .then(() => {
        const next = activeSession.getSnapshot();
        if (next.activeReconciliationDeltaId) {
          onReconciliationPropose?.();
          setAnnouncement(
            "The reconciliation candidate is durable for review. Canonical worldstate remains unchanged.",
          );
          return;
        }
        setAnnouncement(
          next.error?.scope === "reconciliation"
            ? next.error.message
            : "No reconciliation candidate was recorded. Canonical worldstate remains unchanged.",
        );
      })
      .catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error
            ? error.message
            : "The reconciliation candidate could not be prepared.",
        );
      });
  };

  const integrateReconciliation = () => {
    if (
      mutationsDisabled ||
      busy ||
      !model?.work.reconciliation.canIntegrate
    ) {
      return;
    }
    const before = snapshot.state?.canonical.head.id;
    setAnnouncement(
      "Committing the reviewed reconciliation candidate as a human-governed revision.",
    );
    const operation = runTrackedOperation(() =>
      activeSession.integrateActiveReconciliation(),
    );
    if (!operation) return;
    void operation
      .then(() => {
        const next = activeSession.getSnapshot();
        const after = next.state?.canonical.head.id;
        if (before && after && before !== after) {
          onResultIntegrate?.();
          setAnnouncement(`The reviewed result is integrated in ${after}.`);
          return;
        }
        setAnnouncement(
          next.error?.scope === "integration"
            ? next.error.message
            : "No canonical integration revision was recorded.",
        );
      })
      .catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error
            ? error.message
            : "The reviewed result could not be integrated.",
        );
      });
  };

  const proposeArtifactPromotion = () => {
    if (
      mutationsDisabled ||
      busy ||
      !model?.work.artifactPromotion.canPropose
    ) {
      return;
    }
    setAnnouncement(
      "Preparing the exact artifact-promotion proposal. No authoritative Git ref will move.",
    );
    const operation = runTrackedOperation(() =>
      activeSession.proposeActiveArtifactPromotion(),
    );
    if (!operation) return;
    void operation
      .then(() => {
        const next = activeSession.getSnapshot();
        if (next.activeArtifactPromotionId) {
          onArtifactPromotionPropose?.();
          setAnnouncement(
            "The promotion proposal is durable for separate human review; no Git ref was moved.",
          );
          return;
        }
        setAnnouncement(
          next.error?.scope === "artifact_promotion"
            ? next.error.message
            : "No artifact-promotion proposal was recorded.",
        );
      })
      .catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error
            ? error.message
            : "The artifact-promotion proposal could not be prepared.",
        );
      });
  };

  const promoteArtifact = () => {
    if (
      mutationsDisabled ||
      busy ||
      !model?.work.artifactPromotion.canPromote
    ) {
      return;
    }
    setAnnouncement(
      "Authorizing one exact target-ref promotion. The server will recheck private run evidence and independent validation before CAS.",
    );
    const operation = runTrackedOperation(() =>
      activeSession.promoteActiveArtifact(),
    );
    if (!operation) return;
    void operation
      .then(() => {
        const next = activeSession.getSnapshot();
        const promotionId = next.activeArtifactPromotionId;
        const status = promotionId
          ? next.state?.operational.artifactPromotions[promotionId]?.status
          : null;
        if (status === "promoted") {
          onArtifactPromote?.();
          setAnnouncement(
            "A signed server receipt confirms the authoritative ref now names the reviewed candidate.",
          );
          return;
        }
        setAnnouncement(
          next.error?.scope === "artifact_promotion"
            ? next.error.message
            : "No authoritative promotion outcome was established.",
        );
      })
      .catch((error: unknown) => {
        setAnnouncement(
          error instanceof Error
            ? error.message
            : "The artifact promotion could not be completed.",
        );
      });
  };

  const resetSandbox = () => {
    if (mutationsDisabled || busy) return;
    if (!resetConfirming) {
      setResetConfirming(true);
      setAnnouncement("Reset requires one more explicit confirmation.");
      return;
    }

    setResetConfirming(false);
    const operation = runTrackedOperation(() => activeSession.resetSandbox());
    if (!operation) return;
    void operation
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
        setAnnouncement(
          error instanceof Error ? error.message : "Sandbox reset failed.",
        );
      });
  };

  if (!model) {
    const failed =
      snapshot.persistenceState === "unavailable" ||
      snapshot.persistenceState === "corrupt";
    return (
      <main
        aria-describedby={
          mutationsDisabled ? mutationAccessDescriptionId : undefined
        }
        aria-label="Worldstate workbench"
        className={styles.workbench}
        data-morphic-root="worldstate-workbench"
        data-mutation-access={mutationAccess}
        data-persistence-state={snapshot.persistenceState}
        data-presentation-focus-target="workbench"
        tabIndex={-1}
      >
        {mutationsDisabled ? (
          <MutationAccessNotice id={mutationAccessDescriptionId} />
        ) : null}
        <section aria-live="polite" className={styles.loadingShell}>
          <strong>
            {failed ? "Browser ledger unavailable" : "Loading your worldstate"}
          </strong>
          <span>
            {snapshot.persistenceDetail ??
              "Opening IndexedDB and validating the project ledger."}
          </span>
          {failed ? (
            <button
              aria-describedby={
                mutationsDisabled ? mutationAccessDescriptionId : undefined
              }
              className={styles.resetButton}
              data-confirming={resetConfirming ? "true" : "false"}
              disabled={busy || mutationsDisabled}
              onClick={resetSandbox}
              type="button"
            >
              {resetConfirming
                ? "Confirm local sandbox reset"
                : "Reset local sandbox"}
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
      aria-describedby={
        mutationsDisabled ? mutationAccessDescriptionId : undefined
      }
      aria-label="Worldstate workbench"
      className={styles.workbench}
      data-morphic-root="worldstate-workbench"
      data-mutation-access={mutationAccess}
      data-persistence-state={model.persistence.state}
      data-presentation-focus-target="workbench"
      data-runtime-mode={model.runtime.mode}
      data-selected-object-id={selectedId}
      data-view={activeView}
      data-worldstate-revision={model.revision}
      tabIndex={-1}
    >
      <a className={styles.skipLink} href="#primary-projection">
        Skip to project projection
      </a>

      {mutationsDisabled ? (
        <MutationAccessNotice id={mutationAccessDescriptionId} />
      ) : null}

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

        <div
          className={styles.runtimeCluster}
          data-morphic-lane="runtime-truth"
        >
          <span
            className={styles.runtimeBadge}
            data-runtime-mode={model.runtime.mode}
          >
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
            mutationsDisabled={mutationsDisabled}
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

        <aside
          aria-label="Interpretation and evidence"
          className={styles.inspectorColumn}
        >
          <PlacementReceipt placement={model.placement} />
          <EvidencePanel model={model} />
          <GovernancePanel placement={model.placement} work={model.work} />
          <CommitPanel
            busy={busy}
            mutationAccessDescriptionId={
              mutationsDisabled ? mutationAccessDescriptionId : undefined
            }
            mutationsDisabled={mutationsDisabled}
            onAccept={acceptPlacement}
            onRetry={retryPlacement}
            placement={model.placement}
          />
        </aside>

        <WorkPanel
          busy={busy}
          integratingResult={integratingResult}
          mutationAccessDescriptionId={
            mutationsDisabled ? mutationAccessDescriptionId : undefined
          }
          mutationsDisabled={mutationsDisabled}
          onClearOperatorAuthority={clearOperatorAuthority}
          onOperatorCredentialChange={setOperatorCredentialDraft}
          onOperatorCredentialSubmit={authorizeOperator}
          onAuthorize={authorizeFixtureReplay}
          onIntegrate={integrateReconciliation}
          onPromoteArtifact={promoteArtifact}
          onProposePromotion={proposeArtifactPromotion}
          onProposeReconciliation={proposeReconciliation}
          onValidate={validateReplayEvidence}
          onPrepare={prepareAgentBrief}
          proposingReconciliation={proposingReconciliation}
          proposingPromotion={proposingPromotion}
          promotingArtifact={promotingArtifact}
          operatorCredentialDraft={operatorCredentialDraft}
          operatorCredentialReady={operatorCredentialReady}
          operatorCredentialRequired={
            snapshot.agentRuntimeCapability?.effectiveMode === "live" ||
            model.work.runtime.effectiveMode === "live" ||
            model.work.artifactPromotion.state !== "unavailable"
          }
          validatingEvidence={validatingEvidence}
          work={model.work}
        />
      </div>

      <StatusRegion
        busy={busy}
        model={model}
        mutationAccessDescriptionId={
          mutationsDisabled ? mutationAccessDescriptionId : undefined
        }
        mutationsDisabled={mutationsDisabled}
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
  mutationsDisabled: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function SourceCapture({
  placement,
  draft,
  busy,
  mutationsDisabled,
  onDraftChange,
  onSubmit,
}: SourceCaptureProps) {
  const sourceCaptureGateId = useId();
  if (!placement.sourceText) {
    return (
      <form
        className={styles.captureComposer}
        data-gate-state={mutationsDisabled ? "opening" : "ready"}
        onSubmit={onSubmit}
      >
        <label>
          <span className={styles.regionKicker}>Capture a source</span>
          <textarea
            aria-describedby={
              mutationsDisabled ? sourceCaptureGateId : undefined
            }
            aria-label="Source text"
            disabled={busy}
            maxLength={4000}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Describe the idea or request you want placed in this project."
            value={draft}
          />
        </label>
        <button
          aria-describedby={
            mutationsDisabled ? sourceCaptureGateId : undefined
          }
          className={styles.captureButton}
          disabled={busy || mutationsDisabled || !draft.trim()}
          type="submit"
        >
          {busy ? "Saving source…" : "Capture & place"}
        </button>
        {mutationsDisabled ? (
          <p className={styles.captureGate} id={sourceCaptureGateId}>
            Finish or skip the opening guide before saving this source. Draft
            text stays in this page until then.
          </p>
        ) : null}
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
        <div
          className={styles.placementPath}
          data-morphic-lane="placement-receipt"
        >
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
          <div data-delegation-profile-id={placement.delegationProfileId ?? "none"}>
            <dt>
              {placement.state === "adopted"
                ? "Accepted delegation profile"
                : "Delegation profile proposal"}
            </dt>
            <dd>
              {placement.delegationProfileId
                ? `${placement.delegationProfileId}${
                    placement.state === "adopted"
                      ? " · accepted, not run authority"
                      : ""
                  }`
                : placement.state === "adopted"
                  ? "None accepted · no executable delegation"
                  : "None · no registered delegation"}
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
        <div
          className={styles.receiptContext}
          data-evidence-anchor="placement-context"
        >
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
  const work = workStatus(model.work);
  const placementRecordCount = [
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
          {String(placementRecordCount).padStart(2, "0")} placement{" "}
          {placementRecordCount === 1 ? "record" : "records"}
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
          data-state={work.state}
          data-state-family="work"
          data-state-surface={work.surface}
        >
          <span>Work</span>
          <strong>{work.label}</strong>
          <small>{work.detail}</small>
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
          <span>
            {adopted ? "Adopted" : placement.deltaId ? "Pending" : "None"}
          </span>
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

function GovernancePanel({
  placement,
  work,
}: {
  placement: PlacementSurface;
  work: WorkSurface;
}) {
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
        <div
          data-authority-state={work.authority.state}
          data-state-surface={workStateSurface(work.state)}
        >
          <span>Agent authority</span>
          <strong>{work.authority.label}</strong>
          <small>{work.authority.detail}</small>
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
  mutationAccessDescriptionId?: string;
  mutationsDisabled: boolean;
  onAccept: () => void;
  onRetry: () => void;
}

function CommitPanel({
  placement,
  busy,
  mutationAccessDescriptionId,
  mutationsDisabled,
  onAccept,
  onRetry,
}: CommitPanelProps) {
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
              aria-describedby={mutationAccessDescriptionId}
              className={styles.retryButton}
              disabled={busy || mutationsDisabled}
              onClick={onRetry}
              type="button"
            >
              Retry from preserved source
            </button>
          </div>
        ) : null}
        <button
          aria-describedby={mutationAccessDescriptionId}
          className={styles.commitButton}
          data-semantic-action="accept-placement"
          disabled={busy || mutationsDisabled || !placement.canAccept}
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

interface WorkPanelProps {
  work: WorkSurface;
  busy: boolean;
  mutationAccessDescriptionId?: string;
  mutationsDisabled: boolean;
  onPrepare: () => void;
  onAuthorize: () => void;
  onValidate: () => void;
  onProposeReconciliation: () => void;
  onIntegrate: () => void;
  onProposePromotion: () => void;
  onPromoteArtifact: () => void;
  onOperatorCredentialSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onOperatorCredentialChange: (value: string) => void;
  onClearOperatorAuthority: () => void;
  validatingEvidence: boolean;
  proposingReconciliation: boolean;
  integratingResult: boolean;
  proposingPromotion: boolean;
  promotingArtifact: boolean;
  operatorCredentialDraft: string;
  operatorCredentialReady: boolean;
  operatorCredentialRequired: boolean;
}

export function WorkPanel({
  work,
  busy,
  mutationAccessDescriptionId,
  mutationsDisabled,
  onPrepare,
  onAuthorize,
  onValidate,
  onProposeReconciliation,
  onIntegrate,
  onProposePromotion,
  onPromoteArtifact,
  onOperatorCredentialSubmit,
  onOperatorCredentialChange,
  onClearOperatorAuthority,
  validatingEvidence,
  proposingReconciliation,
  integratingResult,
  proposingPromotion,
  promotingArtifact,
  operatorCredentialDraft,
  operatorCredentialReady,
  operatorCredentialRequired,
}: WorkPanelProps) {
  const brief = work.brief;
  const run = work.run;
  const exchangeEvidence = work.exchangeEvidence;
  const normalizationFailure = work.normalizationFailure;
  const result = work.result;
  const validation = work.validation;
  const reconciliation = work.reconciliation;
  const artifactPromotion = work.artifactPromotion;
  const candidate = reconciliation.candidate;
  const liveMode =
    work.runtime.effectiveMode === "live" || run?.mode === "live";
  const preparing = work.state === "preparing";
  const authorizing = work.state === "authorizing";
  const dispatching = work.state === "dispatching";
  const persistingResult = work.state === "persisting_result";
  const absentResultTitle =
    work.state === "quarantined"
      ? "Worker result quarantined"
      : run?.status === "outcome_unknown"
        ? "Outcome unknown · no closure inferred"
        : "No staged closure yet";
  const prepareLabel = preparing
    ? "Preparing brief…"
    : brief
      ? "Brief prepared"
      : "Prepare agent brief";
  const authorizeLabel = authorizing
    ? liveMode
      ? "Authorizing live run…"
      : "Authorizing replay…"
    : dispatching
      ? liveMode
        ? "Live Codex run in flight…"
        : "Fixture replay in flight…"
      : persistingResult
        ? liveMode
          ? "Saving live result…"
          : "Saving replay result…"
        : work.canRetryDispatch
          ? "Retry exact live dispatch"
          : run
          ? work.authority.state === "used"
            ? `${liveMode ? "Live" : "Replay"} authority used`
            : `${liveMode ? "Live run" : "Fixture replay"} authorized`
          : `Authorize ${liveMode ? "live run" : "fixture replay"}`;
  const validationLabel = validation
    ? "Evidence validation recorded"
    : validatingEvidence
      ? "Validating evidence…"
      : work.errorCode === "validation_outcome_unobserved"
        ? "Retry exact validation request"
      : "Run independent validation";
  const validationState =
    validation?.verdict ??
    (validatingEvidence
      ? "validating"
      : work.canValidate
        ? "ready"
        : "unavailable");
  const validationSurface =
    validation?.verdict === "verified"
      ? "provisional-status-surface"
      : validation?.verdict === "not_verified" ||
          validation?.verdict === "stale"
        ? "warning-status-surface"
        : "diagnostic-status-surface";
  const validationVerdictLabel =
    validation?.verdict === "verified"
      ? "Required evidence verified"
      : validation?.verdict === "stale"
        ? "Validation stale"
        : validation?.verdict === "not_verified"
          ? "Evidence not verified"
          : validatingEvidence
            ? "Validation in progress"
            : "Not validated";
  const reconciliationStateLabel: Record<
    WorkSurface["reconciliation"]["state"],
    string
  > = {
    unavailable: "Unavailable",
    eligible: "Ready to prepare",
    proposing: "Preparing candidate",
    candidate: "Candidate · no change yet",
    blocked: "Candidate blocked",
    stale: "Candidate stale",
    integrating: "Integrating",
    integrated: "Integrated",
    failed: "Candidate unavailable",
  };
  const candidateSurface =
    reconciliation.state === "integrated"
      ? "authoritative-status-surface"
      : reconciliation.state === "blocked" ||
          reconciliation.state === "stale" ||
          reconciliation.state === "failed"
        ? "warning-status-surface"
        : reconciliation.state === "candidate"
          ? "provisional-status-surface"
          : "diagnostic-status-surface";
  const workStatusLabel =
    liveMode && work.state === "authorizing"
      ? "Authorizing live run"
      : liveMode && work.state === "dispatching"
        ? "Live run in flight"
        : liveMode && work.state === "persisting_result"
          ? "Saving live result"
          : workStateLabel(work.state);

  return (
    <section
      aria-labelledby="work-heading"
      className={styles.workRegion}
      data-morphic-region="work"
      data-mutation-access={mutationsDisabled ? "presentation-only" : "enabled"}
      data-state={work.state}
      data-state-family="work"
      data-state-surface={workStateSurface(work.state)}
    >
      <div className={styles.workIntro}>
        <div>
          <span className={styles.regionKicker}>Bounded agent work</span>
          <h2 id="work-heading">Review first, authorize separately</h2>
        </div>
        <span className={styles.postureBadge} data-state={work.state}>
          <i /> {workStatusLabel}
        </span>
      </div>

      {operatorCredentialRequired ? (
        <form
          className={styles.operatorAuthority}
          data-authority-boundary="transient-operator"
          data-morphic-lane="operator-authorization"
          data-state={operatorCredentialReady ? "available" : "required"}
          onSubmit={onOperatorCredentialSubmit}
        >
          <div>
            <span className={styles.boundaryLabel}>
              <ShieldIcon /> Transient operator authority
            </span>
            <p>
              Required for live authorization, private status, independent live
              validation, and artifact promotion. It remains in page memory only
              and is sent only as an Authorization header.
            </p>
          </div>
          {operatorCredentialReady ? (
            <button
              className={styles.retryButton}
              disabled={busy}
              onClick={onClearOperatorAuthority}
              type="button"
            >
              Clear operator authority
            </button>
          ) : (
            <div className={styles.operatorCredentialEntry}>
              <label htmlFor="odeu-operator-credential">
                Operator bearer
              </label>
              <input
                aria-describedby={mutationAccessDescriptionId}
                autoComplete="off"
                data-persistence="memory-only"
                disabled={mutationsDisabled}
                id="odeu-operator-credential"
                minLength={32}
                onChange={(event) =>
                  onOperatorCredentialChange(event.target.value)
                }
                required
                spellCheck={false}
                type="password"
                value={operatorCredentialDraft}
              />
              <button
                aria-describedby={mutationAccessDescriptionId}
                className={styles.retryButton}
                disabled={
                  busy || mutationsDisabled || operatorCredentialDraft.length < 32
                }
                type="submit"
              >
                Use in this page only
              </button>
            </div>
          )}
        </form>
      ) : null}

      <div
        className={styles.briefPreparation}
        data-action-cluster="brief-preparation"
        data-gate="prepare-agent-brief"
        data-gate-state={
          brief ? "satisfied" : work.canPrepare ? "ready" : "blocked"
        }
        data-morphic-lane="brief-preparation"
      >
        <div>
          <span className={styles.boundaryLabel}>
            <SparkIcon /> 01 · Preview boundary
          </span>
          <strong>{work.targetLabel ?? "No accepted task available"}</strong>
          <p>{work.prepareGateReason}</p>
        </div>
        <button
          aria-describedby={mutationAccessDescriptionId}
          className={styles.previewButton}
          data-semantic-action="prepare-agent-brief"
          disabled={busy || mutationsDisabled || !work.canPrepare}
          onClick={onPrepare}
          type="button"
        >
          {brief ? <CheckIcon /> : <SparkIcon />}
          {prepareLabel}
        </button>
      </div>

      {work.errorMessage ? (
        <div className={styles.workWarning} data-state="failed" role="alert">
          <strong>{work.errorCode ?? "delegation_failed"}</strong>
          <p>{work.errorMessage}</p>
        </div>
      ) : null}

      {brief ? (
        <div className={styles.briefReview} data-evidence-anchor="agent-brief">
          <article
            className={styles.workStep}
            data-morphic-lane="brief-contract"
          >
            <div className={styles.stepHeader}>
              <span>02</span>
              <div>
                <small>Immutable brief contract</small>
                <h3>{brief.goal}</h3>
              </div>
              <span
                className={styles.statusToken}
                data-state={brief.stale ? "stale" : "ready"}
              >
                {brief.stale ? "Stale" : "Current"}
              </span>
            </div>
            <dl className={styles.briefBindings}>
              <div>
                <dt>Brief</dt>
                <dd>{brief.id}</dd>
              </div>
              <div>
                <dt>Worldstate base</dt>
                <dd>{brief.baseRevisionId}</dd>
              </div>
              <div>
                <dt>Artifact base</dt>
                <dd>{brief.artifactBaseRef}</dd>
              </div>
              <div>
                <dt>Agent profile</dt>
                <dd>{brief.agentProfile}</dd>
              </div>
              <div data-delegation-profile-id={brief.delegationProfileId ?? "none"}>
                <dt>Delegation contract</dt>
                <dd>
                  {brief.delegationProfileId ??
                    "Legacy unbound brief · not executable"}
                </dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>{brief.environment}</dd>
              </div>
            </dl>
            <div className={styles.doneMeans} data-evidence-anchor="done-means">
              <strong>Done means…</strong>
              <ol>
                {brief.doneMeans.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ol>
            </div>
          </article>

          <div
            className={styles.contextProjection}
            data-morphic-lane="context-disclosure"
          >
            <section data-evidence-anchor="shared-with-agent">
              <strong>Shared with agent · {brief.sharedContext.length}</strong>
              <small>{brief.sharedRelationCount} bounded relation(s)</small>
              <ul>
                {brief.sharedContext.map((item) => (
                  <li key={item.id}>
                    <b>{item.label}</b>
                    <span>
                      {item.kind} · {item.summary}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section data-evidence-anchor="kept-private">
              <strong>
                Kept private / out of scope · {brief.omittedContext.length}
              </strong>
              <small>
                These local omission receipts are not sent to the worker.
              </small>
              {brief.omittedContext.length ? (
                <ul>
                  {brief.omittedContext.map((item) => (
                    <li data-omission-reason={item.reason} key={item.id}>
                      <b>{item.label}</b>
                      <span>
                        {item.reason === "private" ? "Private" : "Out of scope"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No active context was omitted.</p>
              )}
            </section>
          </div>

          <div className={styles.briefEvidenceGrid}>
            <section
              className={styles.authorityContract}
              data-evidence-anchor="agent-authority-envelope"
              data-morphic-lane="delegation-authority"
            >
              <div>
                <strong>Allowed</strong>
                <ul>
                  {brief.allowedActions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Denied</strong>
                <ul>
                  {brief.deniedActions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Requires confirmation</strong>
                {brief.confirmationRequired.length ? (
                  <ul>
                    {brief.confirmationRequired.map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                ) : (
                  <p>No additional confirmation classes.</p>
                )}
              </div>
            </section>

            <section
              className={styles.evidenceContract}
              data-evidence-anchor="expected-result-evidence"
              data-morphic-lane="evidence-contract"
            >
              <strong>Expected result evidence</strong>
              <ul>
                {brief.evidenceRequirements.map((requirement) => (
                  <li key={requirement.id}>
                    <span>{requirement.kind}</span>
                    <div>
                      <b>{requirement.label}</b>
                      {requirement.command ? (
                        <code>{requirement.command}</code>
                      ) : null}
                    </div>
                    <em>{requirement.required ? "Required" : "Optional"}</em>
                  </li>
                ))}
              </ul>
              {brief.expectedArtifacts.length ? (
                <div className={styles.expectedArtifacts}>
                  <b>Expected artifacts</b>
                  <span>{brief.expectedArtifacts.join(" · ")}</span>
                </div>
              ) : null}
              <p>
                {brief.blockIntegrationWithoutEvidence
                  ? "Missing required evidence must block later integration."
                  : "Evidence remains reviewable even when policy would not block integration."}
              </p>
            </section>
          </div>

          {brief.unknowns.length || brief.constraints.length ? (
            <div
              className={styles.briefCaveats}
              data-evidence-anchor="brief-caveats"
            >
              {brief.unknowns.length ? (
                <div>
                  <strong>Unknowns</strong>
                  <ul>
                    {brief.unknowns.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {brief.constraints.length ? (
                <div>
                  <strong>Constraints</strong>
                  <ul>
                    {brief.constraints.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div>
                <strong>Escalation</strong>
                <p>{brief.escalationPath}</p>
              </div>
            </div>
          ) : (
            <div className={styles.escalationPath}>
              <strong>Escalation</strong>
              <p>{brief.escalationPath}</p>
            </div>
          )}
        </div>
      ) : null}

      <div
        className={styles.delegationCluster}
        data-action-cluster="agent-delegation"
        data-gate="dispatch-agent"
        data-gate-state={
          work.canAuthorize || work.canRetryDispatch
            ? "ready"
            : run
              ? "satisfied"
              : "blocked"
        }
        data-morphic-lane="dispatch-boundary"
      >
        <div>
          <span className={styles.boundaryLabel}>
            <ShieldIcon /> 03 · One-run authority boundary
          </span>
          <strong>
            {liveMode ? "Guarded live Codex" : "Fixture replay only"}
          </strong>
          <p>{work.dispatchGateReason}</p>
        </div>
        <button
          aria-describedby={mutationAccessDescriptionId}
          className={styles.dispatchButton}
          data-semantic-action={
            liveMode ? "authorize-live-codex-run" : "authorize-fixture-replay"
          }
          disabled={
            busy ||
            mutationsDisabled ||
            (!work.canAuthorize && !work.canRetryDispatch)
          }
          onClick={onAuthorize}
          type="button"
        >
          {run ? <CheckIcon /> : <ShieldIcon />}
          {authorizeLabel}
        </button>
      </div>

      {run ? (
        <div className={styles.runReview} data-evidence-anchor="agent-run">
          <div
            className={styles.replayNotice}
            data-morphic-lane="runtime-identity"
            data-runtime-mode={work.runtime.mode}
          >
            <HistoryIcon />
            <span>
              <strong>{work.runtime.label}</strong>
              <span>
                Run {run.id} · requested{" "}
                {work.runtime.requestedMode ?? run.mode} · effective{" "}
                {work.runtime.effectiveMode ?? "pending"} ·{" "}
                {work.runtime.status}
              </span>
              <code>
                {work.runtime.replayIdentity ??
                  (liveMode
                    ? "Live provider identity retained in exact exchange"
                    : "Replay identity pending exact exchange")}
              </code>
            </span>
          </div>

          <section
            className={styles.lifecyclePanel}
            data-morphic-lane="worker-observation"
          >
            <div className={styles.stepHeader}>
              <span>04</span>
              <div>
                <small>Durable worker observation</small>
                <h3>Lifecycle · {run.status}</h3>
              </div>
              <span className={styles.statusToken} data-state={run.status}>
                {run.mode}
              </span>
            </div>
            <ol className={styles.workerEvents}>
              {run.lifecycle.map((event) => (
                <li
                  data-state={
                    [
                      "blocked",
                      "outcome_unknown",
                      "failed",
                      "cancelled",
                    ].includes(event.status)
                      ? event.status
                      : "complete"
                  }
                  key={event.id}
                >
                  <i />
                  <span>
                    <b>{event.status}</b>
                    <small>{event.message}</small>
                  </span>
                  <time>{event.at}</time>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}

      {exchangeEvidence ? (
        <section
          className={styles.exchangeEvidence}
          data-evidence-anchor="exact-codex-exchange"
          data-morphic-lane="exact-exchange-evidence"
          data-state={exchangeEvidence.disposition}
          data-state-surface={
            exchangeEvidence.disposition === "quarantined"
              ? "warning-status-surface"
              : "diagnostic-status-surface"
          }
        >
          <div className={styles.exchangeEvidenceHeader}>
            <div>
              <span className={styles.regionKicker}>
                Exact Codex exchange evidence
              </span>
              <h3>{exchangeEvidence.sourceId}</h3>
            </div>
            <span
              className={styles.statusToken}
              data-state={exchangeEvidence.disposition}
            >
              {exchangeEvidence.disposition === "quarantined"
                ? "Rejected · quarantined"
                : "Binding coherent"}
            </span>
          </div>

          <dl className={styles.exchangeBindings}>
            <div>
              <dt>Request</dt>
              <dd>{exchangeEvidence.requestId}</dd>
            </div>
            <div>
              <dt>Requested run</dt>
              <dd>{exchangeEvidence.requestRunId}</dd>
            </div>
            <div>
              <dt>Requested brief</dt>
              <dd>{exchangeEvidence.requestBriefId}</dd>
            </div>
            <div>
              <dt>Source revision</dt>
              <dd>{exchangeEvidence.sourceRevisionId}</dd>
            </div>
            <div>
              <dt>Artifact base</dt>
              <dd>{exchangeEvidence.artifactBaseRef}</dd>
            </div>
          </dl>

          <div className={styles.exchangeRuntimeEvidence}>
            <span>{exchangeEvidence.responseKind} response</span>
            <strong>
              {exchangeEvidence.requestedMode} requested ·{" "}
              {exchangeEvidence.effectiveMode ?? "no effective mode"} effective
              · {exchangeEvidence.runtimeStatus}
            </strong>
            <small>
              {exchangeEvidence.provider} · recorded{" "}
              {exchangeEvidence.recordedAt}
            </small>
            {exchangeEvidence.replayIdentity ? (
              <code>{exchangeEvidence.replayIdentity}</code>
            ) : null}
          </div>

          {exchangeEvidence.disposition === "quarantined" ? (
            <div className={styles.quarantineNotice} role="alert">
              <ShieldIcon />
              <div>
                <strong>Rejected by the immutable coherence gate</strong>
                <p>
                  The exact source remains inspectable. Worker report, claims,
                  SDK observations, and closure are not projected from it.
                </p>
                <ul>
                  {exchangeEvidence.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className={styles.coherenceNotice}>
              Run, request, revision, artifact base, and response bindings are
              coherent. This is an integrity decision, not independent
              validation.
            </p>
          )}
        </section>
      ) : null}

      {normalizationFailure ? (
        <section
          className={styles.normalizationFailure}
          data-evidence-anchor="codex-normalization-failure"
          data-failure-code={normalizationFailure.code}
          data-morphic-lane="normalization-failure-evidence"
          data-state="outcome_unknown"
          data-state-surface="warning-status-surface"
        >
          <div className={styles.exchangeEvidenceHeader}>
            <div>
              <span className={styles.regionKicker}>
                {normalizationFailure.code === "coherence_rejected"
                  ? "Rejected normalization evidence"
                  : "Normalization state conflict"}
              </span>
              <h3>{normalizationFailure.sourceId}</h3>
            </div>
            <span className={styles.statusToken} data-state="outcome_unknown">
              Outcome unknown
            </span>
          </div>
          <dl className={styles.normalizationBindings}>
            <div>
              <dt>Code</dt>
              <dd>{normalizationFailure.code}</dd>
            </div>
            <div>
              <dt>Request</dt>
              <dd>{normalizationFailure.requestId}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>{normalizationFailure.runId}</dd>
            </div>
            <div>
              <dt>Brief</dt>
              <dd>{normalizationFailure.briefId}</dd>
            </div>
          </dl>
          <div className={styles.normalizationMessage} role="alert">
            <strong>
              {normalizationFailure.code === "coherence_rejected"
                ? "Response normalization was rejected"
                : "Response normalization conflicted with durable state"}
            </strong>
            <p>{normalizationFailure.message}</p>
            <small>
              Recorded {normalizationFailure.recordedAt}. No closure or verified
              outcome is inferred from this failure.
            </small>
          </div>
        </section>
      ) : null}

      {run && !result ? (
        <div className={styles.emptyResult} data-morphic-lane="closure-review">
          <strong>{absentResultTitle}</strong>
          <p>{work.reason}</p>
        </div>
      ) : null}

      {result ? (
        <article
          className={styles.resultReview}
          data-evidence-anchor="staged-worker-result"
          data-morphic-lane="closure-review"
          data-state={result.stale ? "stale" : result.outcome}
          data-state-surface={
            result.stale
              ? "warning-status-surface"
              : "provisional-status-surface"
          }
        >
          <div className={styles.resultHeader}>
            <div>
              <span className={styles.regionKicker}>
                05 ·{" "}
                {result.closureId
                  ? "Staged closure witness"
                  : run?.status === "outcome_unknown"
                    ? "Exact worker report · no normalized closure"
                    : "Worker report"}
              </span>
              <h3>{result.summary}</h3>
            </div>
            <span
              className={styles.statusToken}
              data-state={result.stale ? "stale" : result.outcome}
            >
              {result.stale
                ? "Stale"
                : run?.status === "outcome_unknown"
                  ? `reported ${result.outcome}`
                  : result.outcome}
            </span>
          </div>

          <div className={styles.claimWarning} data-state="unverified">
            <ShieldIcon />
            <span>
              <strong>
                {result.claimedDone
                  ? "Worker claims Done criteria are satisfied"
                  : "No completion claim"}
              </strong>
              <small>
                {run?.status === "outcome_unknown"
                  ? "The exact report is preserved, but normalization did not establish a terminal outcome or closure."
                  : "Returned is not verified. Claims and observations remain separate below."}
              </small>
            </span>
          </div>

          <div className={styles.resultColumns}>
            <section data-evidence-anchor="worker-claims">
              <strong>Worker claims</strong>
              {result.claimedEffects.length ? (
                <ul>
                  {result.claimedEffects.map((effect) => (
                    <li key={effect}>{effect}</li>
                  ))}
                </ul>
              ) : (
                <p>No effect claims were returned.</p>
              )}

              <div className={styles.resultArtifacts}>
                {result.claimedArtifacts.map((artifact) => (
                  <div key={`${artifact.path}:${artifact.reference}`}>
                    <span>{artifact.kind}</span>
                    <strong>{artifact.path}</strong>
                    <small>{artifact.summary}</small>
                    <code>{artifact.reference}</code>
                  </div>
                ))}
              </div>

              <div className={styles.claimedChecks}>
                <strong>Claimed checks</strong>
                {result.claimedChecks.length ? (
                  result.claimedChecks.map((check) => (
                    <div data-claim-status={check.status} key={check.id}>
                      <span>{check.status}</span>
                      <b>{check.label}</b>
                      <small>{check.detail}</small>
                      <code>{check.reference}</code>
                    </div>
                  ))
                ) : (
                  <p>No check claims were returned.</p>
                )}
              </div>
            </section>

            <section data-evidence-anchor="sdk-observations">
              <strong>SDK observations · not validation</strong>
              <small>
                Repository paths are shown only when they match the signed
                candidate manifest; raw command text is withheld.
              </small>
              {result.observedFiles.length || result.observedCommands.length ? (
                <div className={styles.sdkObservations}>
                  {result.observedFiles.map((file) => (
                    <div key={`${file.id}:${file.path}`}>
                      <span>file · {file.status}</span>
                      <b>{file.path}</b>
                      <small>
                        {file.kind} observed by SDK item {file.id}
                      </small>
                    </div>
                  ))}
                  {result.observedCommands.map((command) => (
                    <div key={`${command.id}:${command.command}`}>
                      <span>command · {command.status}</span>
                      <code>{command.command}</code>
                      <small>
                        Exit {command.exitCode ?? "not reported"} · SDK item{" "}
                        {command.id}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.observationEmpty}>
                  No SDK file or command observations were recorded by this
                  {liveMode ? "live run" : "fixture replay"}.
                </p>
              )}
            </section>
          </div>

          {result.artifactCandidate ? (
            <section
              className={styles.artifactCandidateEvidence}
              data-artifact-authority="staged-not-authoritative"
              data-evidence-anchor="sealed-artifact-candidate"
              data-morphic-lane="staged-artifact-candidate"
            >
              <div className={styles.exchangeEvidenceHeader}>
                <div>
                  <span className={styles.regionKicker}>
                    Sealed artifact candidate
                  </span>
                  <h3>{result.artifactCandidate.id}</h3>
                </div>
                <span className={styles.statusToken} data-state="returned">
                  Staged · not authoritative
                </span>
              </div>
              <dl className={styles.normalizationBindings}>
                <div>
                  <dt>Base commit</dt>
                  <dd>
                    {result.artifactCandidate.baseCommit ?? "Bound in closure"}
                  </dd>
                </div>
                <div>
                  <dt>Candidate commit</dt>
                  <dd>{result.artifactCandidate.commit}</dd>
                </div>
                <div>
                  <dt>Candidate tree</dt>
                  <dd>{result.artifactCandidate.tree ?? "Bound in closure"}</dd>
                </div>
                <div>
                  <dt>Target ref</dt>
                  <dd>
                    {result.artifactCandidate.targetRef ??
                      "Withheld until exact exchange is available"}
                  </dd>
                </div>
                <div>
                  <dt>Manifest</dt>
                  <dd>
                    {result.artifactCandidate.manifestDigest ??
                      "Bound in closure"}
                  </dd>
                </div>
                <div>
                  <dt>Patch</dt>
                  <dd>
                    {result.artifactCandidate.patchDigest ?? "Bound in closure"}
                  </dd>
                </div>
              </dl>
              {result.artifactCandidate.changedPaths.length ? (
                <div className={styles.resultArtifacts}>
                  {result.artifactCandidate.changedPaths.map((change) => (
                    <div key={change.path}>
                      <span>{change.status}</span>
                      <strong>{change.path}</strong>
                      <small>Candidate blob</small>
                      <code>{change.blob ?? "deleted"}</code>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className={styles.coherenceNotice}>
                This signed candidate is retained for review and independent
                validation. It becomes authoritative only through the later,
                separate human promotion boundary.
              </p>
            </section>
          ) : null}

          {result.failures.length || result.unresolved.length ? (
            <div className={styles.resultCaveats}>
              {result.failures.length ? (
                <div data-state="failed">
                  <strong>Failures</strong>
                  <ul>
                    {result.failures.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result.unresolved.length ? (
                <div data-state="open">
                  <strong>Unresolved</strong>
                  <ul>
                    {result.unresolved.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <section
            aria-labelledby="independent-validation-heading"
            className={styles.validationLane}
            data-evidence-anchor="independent-validation"
            data-morphic-lane="independent-validation"
            data-state={validationState}
            data-state-surface={validationSurface}
          >
            <div className={styles.validationHeader}>
              <div>
                <span className={styles.regionKicker}>
                  06 · Independent evidence
                </span>
                <h3 id="independent-validation-heading">
                  Validate the evidence contract
                </h3>
              </div>
              <span className={styles.statusToken} data-state={validationState}>
                {validationVerdictLabel}
              </span>
            </div>

            <div
              className={styles.validationAction}
              data-action-cluster="evidence-validation"
              data-gate="validate-result"
              data-gate-state={
                validation
                  ? "satisfied"
                  : validatingEvidence
                    ? "pending"
                    : work.canValidate
                      ? "ready"
                      : "blocked"
              }
            >
              <div>
                <strong>Independent system validator</strong>
                <p id="validation-gate-reason">
                  {validatingEvidence
                    ? "The independent validator is recording observations against the immutable brief evidence contract."
                    : work.validationGateReason}
                </p>
              </div>
              <button
                aria-describedby={
                  mutationAccessDescriptionId
                    ? `validation-gate-reason ${mutationAccessDescriptionId}`
                    : "validation-gate-reason"
                }
                className={styles.validationButton}
                data-semantic-action={
                  liveMode
                    ? "validate-sealed-live-candidate"
                    : "validate-replay-evidence"
                }
                disabled={busy || mutationsDisabled || !work.canValidate}
                onClick={onValidate}
                type="button"
              >
                {validation ? <CheckIcon /> : <SparkIcon />}
                {validationLabel}
              </button>
            </div>

            {validation ? (
              <div className={styles.validationGrid}>
                <section
                  className={styles.independentObservations}
                  data-evidence-anchor="independent-observations"
                >
                  <div className={styles.validationSubhead}>
                    <strong>Independent observations</strong>
                    <small>
                      {validation.observations.length} recorded against brief{" "}
                      {validation.briefId}
                    </small>
                  </div>
                  <ul>
                    {validation.observations.map((observation) => (
                      <li
                        data-observation-freshness={observation.freshness}
                        data-observation-requirement-id={
                          observation.requirementId
                        }
                        data-observation-result={observation.result}
                        key={observation.requirementId}
                      >
                        <div className={styles.observationHeader}>
                          <span>{observation.result}</span>
                          <em>{observation.freshness}</em>
                        </div>
                        <strong>{observation.label}</strong>
                        <small>
                          {observation.kind} ·{" "}
                          {observation.required ? "Required" : "Optional"}
                        </small>
                        {observation.command ? (
                          <>
                            <code>{observation.command}</code>
                            <div
                              className={styles.observationExecutionPosture}
                              data-declared-command-executed={
                                observation.execution
                                  ?.declaredCommandExecuted ?? "not-established"
                              }
                              data-execution-kind={
                                observation.execution?.kind ?? "not-established"
                              }
                            >
                              <b>
                                {observation.execution?.kind ===
                                "sandboxed_candidate"
                                  ? "Sandboxed candidate execution"
                                  : observation.execution
                                    ? "Fixture-equivalent evidence"
                                    : "Command execution not established"}
                              </b>
                              <span>
                                {observation.execution?.kind ===
                                "sandboxed_candidate"
                                  ? `Declared command executed · exit ${observation.execution.exitCode ?? "not observed"} · ${observation.execution.termination ?? "termination not observed"} · runner ${observation.execution.runnerId}`
                                  : observation.execution
                                    ? `Declared command not executed · ${observation.execution.passedCount}/${observation.execution.totalCount} registered cases passed · runner ${observation.execution.runnerId}`
                                    : "This validation record does not establish that the displayed command was executed."}
                              </span>
                            </div>
                          </>
                        ) : null}
                        {observation.verifierDetail ? (
                          <p
                            className={styles.observationVerifierDetail}
                            data-verifier-detail="true"
                          >
                            {observation.verifierDetail}
                          </p>
                        ) : null}
                        <div className={styles.observationReferences}>
                          <b>Evidence references</b>
                          {observation.evidenceRefs.length ? (
                            <ul>
                              {observation.evidenceRefs.map((reference) => (
                                <li key={reference}>
                                  <code>{reference}</code>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span>No evidence reference recorded.</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>

                <aside
                  className={styles.validationVerdict}
                  data-state-family="validation"
                  data-state-surface={validationSurface}
                  data-validation-verdict={validation.verdict}
                >
                  <span>Validation verdict</span>
                  <strong>{validationVerdictLabel}</strong>
                  <p>
                    {validation.verdict === "verified"
                      ? validation.consumedByRevisionId
                        ? `${validation.requiredPassed}/${validation.requiredTotal} required checks were independently observed and consumed by ${validation.consumedByRevisionId}.`
                        : `${validation.requiredPassed}/${validation.requiredTotal} required checks independently observed on current bases.`
                      : validation.verdict === "stale"
                        ? `${validation.requiredPassed}/${validation.requiredTotal} required checks passed, but at least one observation is stale.`
                        : `${validation.requiredPassed}/${validation.requiredTotal} required checks passed with current evidence.`}
                  </p>
                  <p>
                    {validation.verdict === "verified"
                      ? validation.consumedByRevisionId
                        ? "The accepted revision preserves this exact evidence lineage; it does not turn fixture verification into live or causal authorship proof."
                        : "Evidence contract satisfied. This does not integrate or change canonical worldstate."
                      : "Evidence contract is not satisfied. Canonical worldstate is unchanged."}
                  </p>
                  <dl>
                    <div>
                      <dt>Validator</dt>
                      <dd>
                        {validation.validator.label} ·{" "}
                        {validation.validator.kind} · {validation.validator.id}
                      </dd>
                    </div>
                    <div>
                      <dt>Observed</dt>
                      <dd>{validation.observedAt}</dd>
                    </div>
                    <div>
                      <dt>Validation</dt>
                      <dd>{validation.id}</dd>
                    </div>
                    <div>
                      <dt>Evidence source</dt>
                      <dd>{validation.evidenceSourceId}</dd>
                    </div>
                    <div>
                      <dt>Closure</dt>
                      <dd>{validation.closureId}</dd>
                    </div>
                    <div>
                      <dt>Worldstate base</dt>
                      <dd>{validation.baseRevisionId}</dd>
                    </div>
                    {validation.consumedByRevisionId ? (
                      <div>
                        <dt>Consumed by revision</dt>
                        <dd>{validation.consumedByRevisionId}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {validation.issues.length ? (
                    <div className={styles.validationIssues} role="alert">
                      <strong>Unmet validation conditions</strong>
                      <ul>
                        {validation.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </aside>
              </div>
            ) : (
              <div className={styles.validationEmpty}>
                <strong>Independent observations not recorded</strong>
                <p>
                  {validatingEvidence
                    ? "Validation is in progress; no verdict is projected until durable observations exist."
                    : work.validationGateReason}
                </p>
              </div>
            )}
          </section>
        </article>
      ) : null}

      {result ? (
        <section
          aria-labelledby="reconciliation-heading"
          className={styles.reconciliationCandidate}
          data-action-cluster="result-reconciliation"
          data-evidence-anchor="reconciliation-candidate"
          data-gate="prepare-reconciliation"
          data-gate-state={
            candidate
              ? "satisfied"
              : proposingReconciliation
                ? "pending"
                : reconciliation.canPropose
                  ? "ready"
                  : "blocked"
          }
          data-morphic-lane="reconciliation-boundary"
          data-reconciliation-delta-id={candidate?.id ?? "none"}
          data-reconciliation-disposition={candidate?.disposition ?? "absent"}
          data-state={reconciliation.state}
          data-state-family="reconciliation"
          data-state-surface={candidateSurface}
        >
          <div className={styles.reconciliationHeader}>
            <div>
              <span className={styles.regionKicker}>
                07 · Candidate reconciliation
              </span>
              <h3 id="reconciliation-heading">
                Review what would enter canonical worldstate
              </h3>
            </div>
            <span
              className={styles.statusToken}
              data-state={reconciliation.state}
            >
              {reconciliationStateLabel[reconciliation.state]}
            </span>
          </div>

          <div className={styles.reconciliationProposalAction}>
            <div>
              <strong>Deterministic evidence-bound proposal</strong>
              <p>{reconciliation.proposalGateReason}</p>
            </div>
            <button
              aria-describedby={mutationAccessDescriptionId}
              className={styles.reconciliationProposalButton}
              data-semantic-action="prepare-reconciliation-delta"
              disabled={
                busy || mutationsDisabled || !reconciliation.canPropose
              }
              onClick={onProposeReconciliation}
              type="button"
            >
              {candidate ? <CheckIcon /> : <SparkIcon />}
              {candidate
                ? reconciliation.state === "integrated"
                  ? "Candidate integrated"
                  : "Candidate prepared"
                : proposingReconciliation
                  ? "Preparing candidate…"
                  : "Prepare reconciliation proposal"}
            </button>
          </div>

          {candidate ? (
            <>
              <dl className={styles.reconciliationBindings}>
                <div>
                  <dt>Candidate</dt>
                  <dd>{candidate.id}</dd>
                </div>
                <div>
                  <dt>Worldstate base</dt>
                  <dd>{candidate.baseRevisionId}</dd>
                </div>
                <div>
                  <dt>Closure</dt>
                  <dd>{candidate.closureId}</dd>
                </div>
                <div>
                  <dt>Validation</dt>
                  <dd>{candidate.validationId}</dd>
                </div>
                <div>
                  <dt>Proposed by</dt>
                  <dd>
                    {candidate.proposedBy.label} · {candidate.proposedBy.kind}
                  </dd>
                </div>
              </dl>

              <div className={styles.reconciliationGrid}>
                <section
                  className={styles.reconciliationConsequences}
                  data-evidence-anchor="reconciliation-consequences"
                >
                  <div className={styles.reconciliationSubhead}>
                    <strong>Canonical consequences</strong>
                    <small>
                      Candidate only · no change until human integration
                    </small>
                  </div>
                  <p className={styles.visibleConsequence}>
                    {candidate.visibleConsequence}
                  </p>
                  <ol>
                    {candidate.consequences.map((consequence) => (
                      <li
                        data-delta-operation={consequence.operation}
                        data-target-worldstate-id={consequence.targetId}
                        key={consequence.id}
                      >
                        <span>{consequence.operation}</span>
                        <strong>{consequence.summary}</strong>
                        <small>{consequence.targetLabel}</small>
                        <ul>
                          {consequence.details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ol>
                </section>

                <aside
                  className={styles.integrationGateEvidence}
                  data-evidence-anchor="integration-gate-evidence"
                  data-integration-allowed={reconciliation.gate.allowed}
                  data-integration-verified={reconciliation.gate.verified}
                >
                  <div className={styles.reconciliationSubhead}>
                    <strong>Integration gate evidence</strong>
                    <small>
                      {reconciliation.gate.verified
                        ? "Allowed · verified"
                        : reconciliation.gate.allowed
                          ? "Allowed · not verified"
                          : "Blocked"}
                    </small>
                  </div>
                  <ul>
                    {reconciliation.gate.checks.map((check) => (
                      <li
                        data-gate-check={check.status}
                        data-gate-requirement={check.id}
                        key={check.id}
                      >
                        <div>
                          <strong>{check.label}</strong>
                          <span>{check.status}</span>
                        </div>
                        <p>{check.detail}</p>
                        <ul>
                          {check.evidenceRefs.map((reference) => (
                            <li key={reference}>
                              <code>{reference}</code>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </aside>
              </div>

              <div className={styles.reconciliationCaveats}>
                <section>
                  <strong>Why this candidate exists</strong>
                  <ul>
                    {candidate.rationale.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
                <section
                  data-state={candidate.uncertainty.length ? "open" : "clear"}
                >
                  <strong>Uncertainty retained</strong>
                  {candidate.uncertainty.length ? (
                    <ul>
                      {candidate.uncertainty.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>No additional uncertainty was recorded.</p>
                  )}
                </section>
                <section>
                  <strong>Alternatives</strong>
                  <ul>
                    {candidate.alternatives.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              </div>

              <div
                className={styles.artifactPromotionCaveat}
                data-artifact-promotion={candidate.artifactPromotion}
                data-causal-execution-established={
                  candidate.causalExecutionEstablished
                }
                data-causal-authorship-established={
                  candidate.causalAuthorshipEstablished
                }
                data-verification-scope={candidate.verificationScope}
              >
                <ShieldIcon />
                <div>
                  <strong>
                    Semantic integration only · artifact promotion not performed
                  </strong>
                  <p>
                    Verification scope is {candidate.verificationScope}.{" "}
                    {candidate.causalExecutionEstablished
                      ? "Independent execution against the exact sealed live candidate is established. Causal model authorship, deployment, and authoritative file promotion remain unclaimed."
                      : "The candidate does not establish live execution, causal repository authorship, deployment, or file promotion."}
                  </p>
                  <code>{candidate.artifactBaseRef}</code>
                </div>
              </div>
            </>
          ) : (
            <div className={styles.reconciliationEmpty}>
              <strong>No reconciliation candidate is projected</strong>
              <p>{reconciliation.proposalGateReason}</p>
            </div>
          )}
        </section>
      ) : null}

      {result ? (
        <section
          aria-labelledby="integration-heading"
          className={styles.integrationBoundary}
          data-action-cluster="result-integration"
          data-authority-boundary="human-semantic-commit"
          data-gate="integrate-result"
          data-gate-state={
            reconciliation.state === "integrated"
              ? "satisfied"
              : integratingResult
                ? "pending"
                : reconciliation.state === "stale"
                  ? "stale"
                  : reconciliation.canIntegrate
                    ? "ready"
                    : "blocked"
          }
          data-morphic-lane="integration-boundary"
          data-state={reconciliation.state}
          data-state-family="integration"
          data-state-surface={
            reconciliation.state === "integrated"
              ? "authoritative-status-surface"
              : reconciliation.state === "stale" ||
                  reconciliation.state === "blocked" ||
                  reconciliation.state === "failed"
                ? "warning-status-surface"
                : "diagnostic-status-surface"
          }
        >
          <div>
            <span className={styles.boundaryLabel}>
              <ShieldIcon /> 08 · Human integration boundary
            </span>
            <h3 id="integration-heading">Commit the reviewed candidate</h3>
            <p>{reconciliation.integrationGateReason}</p>
            <small>
              This decision changes semantic worldstate only. Artifact promotion
              remains not performed.
            </small>
          </div>
          <button
            aria-describedby={mutationAccessDescriptionId}
            className={styles.integrateButton}
            data-semantic-action="integrate-reconciliation-delta"
            disabled={
              busy || mutationsDisabled || !reconciliation.canIntegrate
            }
            onClick={onIntegrate}
            type="button"
          >
            {reconciliation.state === "integrated" ? (
              <CheckIcon />
            ) : (
              <ShieldIcon />
            )}
            {reconciliation.state === "integrated"
              ? "Result integrated"
              : integratingResult
                ? "Integrating reviewed result…"
                : "Integrate reviewed result"}
          </button>
        </section>
      ) : null}

      {result ? (
        <section
          aria-labelledby="artifact-promotion-heading"
          className={styles.artifactPromotionBoundary}
          data-action-cluster="artifact-promotion"
          data-authority-boundary="human-artifact-promotion"
          data-evidence-anchor="artifact-promotion-gate"
          data-gate="promote-artifact"
          data-gate-state={
            artifactPromotion.state === "promoted"
              ? "satisfied"
              : artifactPromotion.state === "stale"
                ? "stale"
                : artifactPromotion.canPropose || artifactPromotion.canPromote
                  ? "ready"
                  : "blocked"
          }
          data-morphic-lane="artifact-promotion-boundary"
          data-state={artifactPromotion.state}
          data-state-family="artifact-promotion"
          data-state-surface={
            artifactPromotion.state === "promoted"
              ? "authoritative-status-surface"
              : artifactPromotion.state === "stale" ||
                  artifactPromotion.state === "unattested" ||
                  artifactPromotion.state === "failed" ||
                  artifactPromotion.state === "outcome_unknown"
                ? "warning-status-surface"
                : "diagnostic-status-surface"
          }
        >
          <div className={styles.artifactPromotionHeader}>
            <div>
              <span className={styles.boundaryLabel}>
                <ShieldIcon /> 09 · Human artifact-promotion boundary
              </span>
              <h3 id="artifact-promotion-heading">
                Promote one reviewed Git candidate
              </h3>
              <p>{artifactPromotion.gateReason}</p>
              <small>
                This boundary never changes semantic worldstate. Only an exact
                completed receipt re-attested from the private host journal may
                render authoritative historical evidence.
              </small>
            </div>
            <span
              className={styles.statusToken}
              data-state={
                artifactPromotion.state === "promoted"
                  ? "returned"
                  : artifactPromotion.state === "stale" ||
                      artifactPromotion.state === "unattested" ||
                      artifactPromotion.state === "failed" ||
                      artifactPromotion.state === "outcome_unknown"
                    ? "blocked"
                    : "queued"
              }
            >
              {artifactPromotion.state === "promoted"
                ? "Promotion receipt host-attested"
                : artifactPromotion.state.replaceAll("_", " ")}
            </span>
          </div>

          {artifactPromotion.candidate ? (
            <div className={styles.artifactPromotionBindings}>
              <div>
                <span>Candidate</span>
                <code>{artifactPromotion.candidate.candidateId}</code>
              </div>
              <div>
                <span>Target ref</span>
                <code>{artifactPromotion.candidate.targetRef}</code>
                {artifactPromotion.candidate.observedAt ? (
                  <small>
                    Receipt observation: {artifactPromotion.candidate.observedAt}
                  </small>
                ) : null}
              </div>
              <div>
                <span>Compare-and-swap</span>
                <code>
                  {artifactPromotion.candidate.expectedBaseCommit} →{" "}
                  {artifactPromotion.candidate.candidateCommit}
                </code>
              </div>
              <div>
                <span>Tree · manifest · patch</span>
                <code>{artifactPromotion.candidate.candidateTree}</code>
                <code>{artifactPromotion.candidate.manifestDigest}</code>
                <code>{artifactPromotion.candidate.patchDigest}</code>
              </div>
              <div className={styles.artifactPromotionPaths}>
                <span>Reviewed changed paths</span>
                <ul>
                  {artifactPromotion.candidate.changedPaths.map((entry) => (
                    <li key={`${entry.status}:${entry.path}`}>
                      <span>{entry.status}</span>
                      <code>{entry.path}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <div className={styles.artifactPromotionActions}>
            <button
              aria-describedby={mutationAccessDescriptionId}
              className={styles.integrateButton}
              data-semantic-action="propose-artifact-promotion"
              disabled={
                busy || mutationsDisabled || !artifactPromotion.canPropose
              }
              onClick={onProposePromotion}
              type="button"
            >
              <ShieldIcon />
              {proposingPromotion
                ? "Preparing promotion proposal…"
                : artifactPromotion.candidate
                  ? "Promotion proposed"
                  : "Prepare promotion proposal"}
            </button>
            <button
              aria-describedby={mutationAccessDescriptionId}
              className={styles.promoteArtifactButton}
              data-semantic-action="promote-reviewed-artifact"
              disabled={
                busy || mutationsDisabled || !artifactPromotion.canPromote
              }
              onClick={onPromoteArtifact}
              type="button"
            >
              {artifactPromotion.state === "promoted" ? (
                <CheckIcon />
              ) : (
                <ShieldIcon />
              )}
              {artifactPromotion.state === "promoted"
                ? "Candidate promoted"
                : promotingArtifact
                  ? "Verifying and promoting…"
                  : artifactPromotion.state === "authorized"
                    ? "Recover or retry authorized promotion"
                    : "Authorize exact ref promotion"}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

interface StatusRegionProps {
  busy: boolean;
  model: WorkbenchViewModel;
  mutationAccessDescriptionId?: string;
  mutationsDisabled: boolean;
  selectedLabel: string;
  resetConfirming: boolean;
  onReset: () => void;
}

function StatusRegion({
  busy,
  model,
  mutationAccessDescriptionId,
  mutationsDisabled,
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
          aria-describedby={mutationAccessDescriptionId}
          className={styles.resetButton}
          data-confirming={resetConfirming ? "true" : "false"}
          disabled={busy || mutationsDisabled}
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
