"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import { DEMO_REPLAY_ID, demoWorldstate } from "./demo-data";
import {
  CheckIcon,
  ChevronIcon,
  HistoryIcon,
  LinkIcon,
  ShieldIcon,
  SparkIcon,
} from "./icons";
import { ProjectionSurface } from "./projections";
import type { ProjectionView } from "./types";
import styles from "./worldstate-workbench.module.css";

type CommitState = "suggested" | "adopted";
type RunState = "waiting" | "ready" | "returned" | "integrated";

function formatRevision(ordinal: number) {
  return `rev-${String(ordinal).padStart(3, "0")}`;
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

export interface WorldstateWorkbenchProps {
  initialView?: ProjectionView;
  onAgentDispatch?: () => void;
  onResultIntegrate?: () => void;
  onSelectionChange?: (worldstateId: string) => void;
  onSemanticCommit?: () => void;
  onViewChange?: (view: ProjectionView) => void;
}

export function WorldstateWorkbench({
  initialView,
  onAgentDispatch,
  onResultIntegrate,
  onSelectionChange,
  onSemanticCommit,
  onViewChange,
}: WorldstateWorkbenchProps = {}) {
  const narrowDefault = useSyncExternalStore(
    subscribeToNarrowViewport,
    isNarrowViewport,
    () => false,
  );
  const [selectedView, setSelectedView] = useState<ProjectionView | undefined>(initialView);
  const activeView = selectedView ?? (narrowDefault ? "focus" : "outline");
  const [selectedId, setSelectedId] = useState("idea-compare-quotes");
  const [commitState, setCommitState] = useState<CommitState>("suggested");
  const [runState, setRunState] = useState<RunState>("waiting");
  const [revisionOrdinal, setRevisionOrdinal] = useState(18);
  const [briefRevision, setBriefRevision] = useState<string>();
  const [announcement, setAnnouncement] = useState(
    "Suggested update is ready for review. No project state has changed.",
  );
  const revision = formatRevision(revisionOrdinal);
  const adopted = commitState === "adopted";
  const selectedNode = useMemo(
    () => demoWorldstate.nodes.find((node) => node.id === selectedId),
    [selectedId],
  );

  const acceptPlacement = () => {
    setBriefRevision(formatRevision(revisionOrdinal + 1));
    setCommitState("adopted");
    setRunState("ready");
    setRevisionOrdinal((current) => current + 1);
    setAnnouncement(
      "Suggested update adopted in a new canonical revision. No agent has been authorized.",
    );
    onSemanticCommit?.();
  };

  const undoPlacement = () => {
    setCommitState("suggested");
    setRunState("waiting");
    setBriefRevision(undefined);
    setRevisionOrdinal((current) => current + 1);
    setAnnouncement(
      "A compensating sandbox revision was created. History remains intact and the update is suggested again.",
    );
  };

  const dispatchReplay = () => {
    setRunState("returned");
    setAnnouncement(
      "Fixture replay result loaded. It is not a live or historical Codex run, and the canonical worldstate is unchanged.",
    );
    onAgentDispatch?.();
  };

  const integrateResult = () => {
    setRunState("integrated");
    setRevisionOrdinal((current) => current + 1);
    setAnnouncement(
      "Staged result integrated in a new canonical revision. Its source, brief, run, and evidence remain linked.",
    );
    onResultIntegrate?.();
  };

  return (
    <main
      className={styles.workbench}
      data-morphic-root="worldstate-workbench"
      data-runtime-mode="replay"
      data-selected-object-id={selectedId}
      data-view={activeView}
      data-worldstate-revision={revision}
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

        <nav aria-label="Active worldstate scope" className={styles.scopeCrumbs} data-morphic-lane="active-scope">
          <button type="button">{demoWorldstate.world}</button>
          <ChevronIcon />
          <button type="button">Projects</button>
          <ChevronIcon />
          <strong>{demoWorldstate.project}</strong>
        </nav>

        <div className={styles.runtimeCluster} data-morphic-lane="runtime-truth">
          <span className={styles.runtimeBadge} data-runtime-mode="sandbox">
            <i /> Sandbox fixture
          </span>
          <span className={styles.runtimeBadge} data-runtime-mode="replay">
            <HistoryIcon /> Fixture replay · {DEMO_REPLAY_ID}
          </span>
          <button aria-label="Open worldstate history" className={styles.iconButton} type="button">
            <HistoryIcon />
          </button>
        </div>
      </header>

      <div className={styles.workbenchBody}>
        <div className={styles.primaryColumn} id="primary-projection">
          <SourceCapture />
          <ProjectionSurface
            activeView={activeView}
            adopted={adopted}
            onSelect={(id) => {
              setSelectedId(id);
              onSelectionChange?.(id);
              setAnnouncement(`Selected ${demoWorldstate.nodes.find((node) => node.id === id)?.label ?? id}.`);
            }}
            onViewChange={(view) => {
              setSelectedView(view);
              onViewChange?.(view);
              setAnnouncement(
                `${view[0].toUpperCase()}${view.slice(1)} view selected. ${selectedNode?.label ?? "Current object"} remains selected.`,
              );
            }}
            selectedId={selectedId}
          />
        </div>

        <aside aria-label="Interpretation and evidence" className={styles.inspectorColumn}>
          <PlacementReceipt adopted={adopted} onAccept={acceptPlacement} />
          <EvidencePanel adopted={adopted} runState={runState} />
          <GovernancePanel adopted={adopted} runState={runState} />
        </aside>

        <WorkPanel
          adopted={adopted}
          briefRevision={briefRevision}
          onDispatch={dispatchReplay}
          onIntegrate={integrateResult}
          revision={revision}
          runState={runState}
        />
      </div>

      <StatusRegion
        adopted={adopted}
        onUndo={undoPlacement}
        revision={revision}
        runState={runState}
        selectedLabel={selectedNode?.label ?? selectedId}
      />

      <p aria-live="polite" className={styles.srOnly} role="status">
        {announcement}
      </p>
    </main>
  );
}

function SourceCapture() {
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
        <span className={styles.regionKicker}>Original idea · captured 09:21</span>
        <blockquote>
          “Ask Codex to add a simple moving-cost comparison tool to my relocation project.”
        </blockquote>
      </div>
      <span className={styles.immutableTag}>
        <LinkIcon /> Source preserved
      </span>
    </section>
  );
}

function PlacementReceipt({ adopted, onAccept }: { adopted: boolean; onAccept: () => void }) {
  return (
    <section
      aria-labelledby="placement-heading"
      className={styles.receiptPanel}
      data-morphic-region="interpretation"
      data-state={adopted ? "adopted" : "suggested"}
      data-state-family="governance"
      data-state-surface={adopted ? "authoritative-status-surface" : "provisional-status-surface"}
    >
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.regionKicker}>Where this fits</span>
          <h2 id="placement-heading">Placement receipt</h2>
        </div>
        <span className={styles.postureBadge} data-state={adopted ? "adopted" : "suggested"}>
          <i /> {adopted ? "Adopted" : "Suggested · no change yet"}
        </span>
      </div>

      <div className={styles.placementPath} data-morphic-lane="placement-receipt">
        <span>Plan our home move</span>
        <ChevronIcon />
        <span>Budget</span>
        <ChevronIcon />
        <strong data-worldstate-id="idea-compare-quotes">Compare provider quotes</strong>
      </div>

      <dl className={styles.receiptFacts}>
        <div>
          <dt>Interpreted as</dt>
          <dd>Idea that creates a small project artifact</dd>
        </div>
        <div>
          <dt>Why here</dt>
          <dd>It compares moving costs and supports the project’s €4,000 goal.</dd>
        </div>
        <div>
          <dt>Expected effect</dt>
          <dd>Add one idea and two proposed relations; preserve the source link.</dd>
        </div>
      </dl>

      <div
        className={styles.openQuestion}
        data-evidence-anchor="material-uncertainty"
        data-state="open"
        data-state-family="knowledge"
        data-state-surface="warning-status-surface"
      >
        <span>?</span>
        <div>
          <strong>One question stays open</strong>
          <p>Should recurring storage costs be compared separately?</p>
        </div>
      </div>

      <div className={styles.advisoryCluster} data-action-cluster="advisory-actions">
        <span>Explore the interpretation</span>
        <div>
          <button data-semantic-action="explain-placement" type="button">Explain reasoning</button>
          <button data-semantic-action="compare-alternative" type="button">Compare alternative</button>
        </div>
      </div>

      <div
        className={styles.commitBoundary}
        data-action-cluster="semantic-commit"
        data-gate="accept-delta"
        data-gate-state={adopted ? "satisfied" : "ready"}
        data-morphic-lane="semantic-commit-boundary"
      >
        <span className={styles.boundaryLabel}>
          <ShieldIcon /> Semantic commit boundary
        </span>
        <p>
          {adopted
            ? "This interpreted update is now part of the sandbox worldstate. No agent was started."
            : "Accept only this displayed update. Agent delegation remains a separate decision."}
        </p>
        <div className={styles.secondaryActions}>
          <button data-semantic-action="edit-placement" type="button">Edit placement</button>
          <button data-semantic-action="defer-delta" type="button">Defer</button>
          <button data-semantic-action="reject-delta" type="button">Reject</button>
        </div>
        <button
          className={styles.commitButton}
          data-semantic-action="accept-delta"
          disabled={adopted}
          onClick={onAccept}
          type="button"
        >
          <CheckIcon /> {adopted ? "Added to my worldstate" : "Add to my worldstate"}
        </button>
      </div>
    </section>
  );
}

function EvidencePanel({ adopted, runState }: { adopted: boolean; runState: RunState }) {
  const workStatus =
    runState === "integrated" ? "Verified" : runState === "returned" ? "Result staged" : "Planned";

  return (
    <section
      aria-labelledby="evidence-heading"
      className={styles.evidencePanel}
      data-morphic-region="evidence"
      data-morphic-lane="knowledge-evidence"
    >
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.regionKicker}>What supports this</span>
          <h2 id="evidence-heading">Evidence &amp; state</h2>
        </div>
        <span className={styles.evidenceCount}>3 anchors</span>
      </div>

      <div className={styles.statusFamilies}>
        <div data-state="draft" data-state-family="knowledge" data-state-surface="provisional-status-surface">
          <span>Knowledge</span>
          <strong>Draft</strong>
          <small>One open question</small>
        </div>
        <div
          data-state={adopted ? "adopted" : "suggested"}
          data-state-family="governance"
          data-state-surface={adopted ? "authoritative-status-surface" : "provisional-status-surface"}
        >
          <span>Governance</span>
          <strong>{adopted ? "Adopted" : "Suggested"}</strong>
          <small>{adopted ? "Revision recorded" : "Needs your approval"}</small>
        </div>
        <div data-state={workStatus.toLowerCase().replace(" ", "-")} data-state-family="work" data-state-surface="diagnostic-status-surface">
          <span>Work</span>
          <strong>{workStatus}</strong>
          <small>
            {runState === "integrated"
              ? "Required checks passed"
              : runState === "returned"
                ? "Result awaits integration"
                : "Not dispatched"}
          </small>
        </div>
      </div>

      <ul className={styles.evidenceList}>
        <li data-evidence-anchor="source-utterance">
          <span className={styles.evidenceGlyph}>01</span>
          <div><strong>Original utterance</strong><small>Immutable source event · 09:21</small></div>
          <span>Exact</span>
        </li>
        <li data-evidence-anchor="related-goal">
          <span className={styles.evidenceGlyph}>02</span>
          <div><strong>Goal under €4,000</strong><small>Canonical project goal · rev-012</small></div>
          <span>Current</span>
        </li>
        <li data-evidence-anchor="target-artifact">
          <span className={styles.evidenceGlyph}>03</span>
          <div><strong>Local planning page</strong><small>Restricted artifact · repo local</small></div>
          <span>Current</span>
        </li>
      </ul>
    </section>
  );
}

function GovernancePanel({ adopted, runState }: { adopted: boolean; runState: RunState }) {
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
          <small>Only the displayed atomic update</small>
        </div>
        <div>
          <span>Agent authority</span>
          <strong>{runState === "returned" || runState === "integrated" ? "Fixture brief only" : "Not granted"}</strong>
          <small>
            {runState === "returned" || runState === "integrated"
              ? "Replay evidence; no live worker"
              : "Requires a separate brief approval"}
          </small>
        </div>
        <div>
          <span>External publishing</span>
          <strong>Disallowed</strong>
          <small>Repo-local changes only</small>
        </div>
      </div>
    </section>
  );
}

interface WorkPanelProps {
  adopted: boolean;
  briefRevision?: string;
  runState: RunState;
  onDispatch: () => void;
  onIntegrate: () => void;
  revision: string;
}

function WorkPanel({ adopted, briefRevision, runState, onDispatch, onIntegrate, revision }: WorkPanelProps) {
  const hasReturnedResult = runState === "returned" || runState === "integrated";

  return (
    <section
      aria-labelledby="work-heading"
      className={styles.workRegion}
      data-morphic-region="work"
      data-state={runState}
      data-state-family="work"
    >
      <div className={styles.workIntro}>
        <div>
          <span className={styles.regionKicker}>Bounded agent work</span>
          <h2 id="work-heading">From accepted idea to evidence</h2>
        </div>
        <p>
          A semantic update, an agent run, and result integration are three different decisions.
        </p>
      </div>

      <div className={styles.workFlow}>
        <article className={styles.workStep} data-morphic-lane="agent-brief">
          <div className={styles.stepHeader}>
            <span>01</span>
            <div><small>Agent brief</small><h3>Moving-cost comparison</h3></div>
            <StatusToken state={adopted ? "ready" : "gated"} />
          </div>
          <p>Goal, local artifact, constraints, and expected evidence — bound to {briefRevision ?? "an accepted revision"}.</p>
          <div className={styles.contextProjection}>
            <div>
              <strong>Shared with Codex</strong>
              <ul>
                <li>Budget goal &amp; comparison idea</li>
                <li>Local planning page path</li>
                <li>Repo-local edit permission</li>
              </ul>
            </div>
            <div>
              <strong>Kept private</strong>
              <ul>
                <li>Provider contact notes</li>
                <li>Unrelated worldstate areas</li>
                <li>Personal address details</li>
              </ul>
            </div>
          </div>
          <div
            className={styles.delegationCluster}
            data-action-cluster="agent-delegation"
            data-gate="dispatch-agent"
            data-gate-state={adopted ? (hasReturnedResult ? "satisfied" : "ready") : "blocked"}
          >
            <span>{adopted ? "Brief is previewable. Dispatch remains explicit." : "Accept the semantic update before compiling this brief."}</span>
            <div>
              <button data-semantic-action="preview-brief" disabled={!adopted} type="button">Preview brief</button>
              <button
                className={styles.dispatchButton}
                data-semantic-action="dispatch-agent"
                disabled={!adopted || hasReturnedResult}
                onClick={onDispatch}
                type="button"
              >
                {hasReturnedResult ? "Fixture replay loaded" : "Approve & load fixture replay"}
              </button>
            </div>
          </div>
        </article>

        <span aria-hidden="true" className={styles.workConnector}><ChevronIcon /></span>

        <article className={styles.workStep} data-morphic-lane="worker-observation">
          <div className={styles.stepHeader}>
            <span>02</span>
            <div><small>Worker observation</small><h3>Codex fixture replay</h3></div>
            <StatusToken state={hasReturnedResult ? "returned" : "waiting"} />
          </div>
          <div className={styles.replayNotice} data-runtime-mode="replay">
            <HistoryIcon />
            <span><strong>{DEMO_REPLAY_ID}</strong>Fixture evidence, never a live or historical worker run.</span>
          </div>
          <ol className={styles.workerEvents}>
            <li data-state={hasReturnedResult ? "complete" : "pending"}><i /> Brief fixture ready</li>
            <li data-state={hasReturnedResult ? "complete" : "pending"}><i /> Focused calculation tests passed</li>
            <li data-state={hasReturnedResult ? "complete" : "pending"}><i /> Result fixture staged</li>
          </ol>
        </article>

        <span aria-hidden="true" className={styles.workConnector}><ChevronIcon /></span>

        <article className={styles.workStep} data-morphic-lane="result-reconciliation">
          <div className={styles.stepHeader}>
            <span>03</span>
            <div><small>Work result</small><h3>Review before integration</h3></div>
            <StatusToken
              state={runState === "integrated" ? "integrated" : runState === "returned" ? "candidate" : "waiting"}
            />
          </div>
          {hasReturnedResult ? (
            <div className={styles.resultEvidence} data-evidence-anchor="closure-witness">
              <div><CheckIcon /><span><strong>Addressable artifact change</strong><small>demo/moving-costs.html</small></span></div>
              <div><CheckIcon /><span><strong>Focused calculation tests</strong><small>Fixture calculation checks passed</small></span></div>
              <div data-state="open"><span>?</span><span><strong>Unresolved</strong><small>Storage recurrence needs a user rule</small></span></div>
            </div>
          ) : (
            <p className={styles.emptyResult}>No worker result is staged. Canonical state is unchanged.</p>
          )}
          <div
            className={styles.reconciliationCluster}
            data-action-cluster="result-reconciliation"
            data-gate="integrate-result"
            data-gate-state={runState === "integrated" ? "satisfied" : runState === "returned" ? "ready" : "unavailable"}
          >
            <span>
              {runState === "integrated"
                ? `Integrated in ${revision}; the closure witness remains in project history.`
                : runState === "returned"
                  ? "Required artifact and test evidence passed. The storage question remains explicitly open."
                  : "A closure witness must arrive before integration."}
            </span>
            <div>
              <button data-semantic-action="leave-for-review" disabled={runState !== "returned"} type="button">Leave for review</button>
              <button data-semantic-action="remand-result" disabled={runState !== "returned"} type="button">Remand</button>
              <button
                className={styles.integrateButton}
                data-semantic-action="integrate-result"
                disabled={runState !== "returned"}
                onClick={onIntegrate}
                type="button"
              >
                {runState === "integrated" ? "Result integrated" : "Integrate result"}
              </button>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

function StatusToken({ state }: { state: "gated" | "ready" | "waiting" | "returned" | "candidate" | "integrated" }) {
  const labels = {
    gated: "Gated",
    ready: "Ready",
    waiting: "Waiting",
    returned: "Returned",
    candidate: "Candidate",
    integrated: "Integrated",
  };
  return <span className={styles.statusToken} data-state={state}>{labels[state]}</span>;
}

interface StatusRegionProps {
  adopted: boolean;
  revision: string;
  runState: RunState;
  selectedLabel: string;
  onUndo: () => void;
}

function StatusRegion({ adopted, revision, runState, selectedLabel, onUndo }: StatusRegionProps) {
  return (
    <footer className={styles.statusRegion} data-morphic-region="status">
      <div data-morphic-lane="revision-sync" data-state="current" data-state-family="revision" data-state-surface="authoritative-status-surface">
        <span className={styles.statusLight} />
        <span><small>Canonical revision</small><strong>{revision} · current</strong></span>
      </div>
      <div data-morphic-lane="selection-status">
        <span><small>Selected context</small><strong>{selectedLabel}</strong></span>
      </div>
      <div data-morphic-lane="runtime-status" data-runtime-mode="replay" data-state="replay" data-state-family="runtime" data-state-surface="diagnostic-status-surface">
        <HistoryIcon />
        <span>
          <small>Execution adapter</small>
          <strong>
            {runState === "integrated"
              ? `${DEMO_REPLAY_ID} · integrated`
              : runState === "returned"
                ? `${DEMO_REPLAY_ID} · result staged`
                : `${DEMO_REPLAY_ID} · standing by`}
          </strong>
        </span>
      </div>
      <div className={styles.undoLane} data-morphic-lane="undo-history">
        <span>
          <small>Last transition</small>
          <strong>
            {runState === "integrated"
              ? "Work result integrated"
              : runState === "returned"
                ? "Work result staged"
                : adopted
                  ? "Semantic update adopted"
                  : "Placement suggested"}
          </strong>
        </span>
        <button
          data-semantic-action="undo-revision"
          disabled={!adopted || runState === "integrated"}
          onClick={onUndo}
          title={runState === "integrated" ? "Create a new compensating result revision in history" : undefined}
          type="button"
        >
          <HistoryIcon /> Undo
        </button>
      </div>
    </footer>
  );
}
