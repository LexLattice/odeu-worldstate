"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import { demoWorldstate } from "./demo-data";
import { FocusIcon, MapIcon, OutlineIcon, TimelineIcon } from "./icons";
import type { ProjectionView, WorldNode } from "./types";
import styles from "./worldstate-workbench.module.css";

interface ProjectionProps {
  activeView: ProjectionView;
  selectedId: string;
  onSelect: (id: string) => void;
  onViewChange: (view: ProjectionView) => void;
  adopted: boolean;
}

const viewOptions: Array<{
  id: ProjectionView;
  label: string;
  cue: string;
  icon: typeof OutlineIcon;
}> = [
  { id: "outline", label: "Outline", cue: "Where it belongs", icon: OutlineIcon },
  { id: "map", label: "Map", cue: "What it affects", icon: MapIcon },
  { id: "timeline", label: "Timeline", cue: "How it evolved", icon: TimelineIcon },
  { id: "focus", label: "Focus", cue: "One decision", icon: FocusIcon },
];

export function ProjectionSurface({
  activeView,
  selectedId,
  onSelect,
  onViewChange,
  adopted,
}: ProjectionProps) {
  const selected = demoWorldstate.nodes.find((node) => node.id === selectedId);

  return (
    <section
      aria-labelledby="projection-heading"
      className={styles.projectionRegion}
      data-morphic-region="projection"
      data-selected-object-id={selectedId}
      data-view={activeView}
    >
      <div className={styles.regionHeader}>
        <div>
          <span className={styles.regionKicker}>Project projection</span>
          <h1 id="projection-heading">{demoWorldstate.project}</h1>
          <p>
            One canonical project, arranged for the question you are asking now.
          </p>
        </div>
        <span className={styles.selectionStamp}>
          Selected <strong>{selected?.label ?? "Nothing"}</strong>
        </span>
      </div>

      <div
        aria-label="Worldstate view"
        className={styles.viewSwitcher}
        data-action-cluster="advisory-actions"
        role="tablist"
      >
        {viewOptions.map(({ id, label, cue, icon: Icon }) => (
          <button
            aria-label={`${label}: ${cue}`}
            aria-controls={`projection-${id}`}
            aria-selected={activeView === id}
            className={styles.viewOption}
            data-semantic-action="select-view"
            key={id}
            onClick={() => onViewChange(id)}
            role="tab"
            type="button"
          >
            <Icon />
            <span>
              <strong>{label}</strong>
              <small>{cue}</small>
            </span>
          </button>
        ))}
      </div>

      <div
        className={styles.projectionFrame}
        data-morphic-lane="primary-projection"
        id={`projection-${activeView}`}
        role="tabpanel"
      >
        {activeView === "outline" ? (
          <OutlineProjection adopted={adopted} onSelect={onSelect} selectedId={selectedId} />
        ) : null}
        {activeView === "map" ? (
          <MapProjection adopted={adopted} onSelect={onSelect} selectedId={selectedId} />
        ) : null}
        {activeView === "timeline" ? (
          <TimelineProjection adopted={adopted} onSelect={onSelect} selectedId={selectedId} />
        ) : null}
        {activeView === "focus" ? (
          <FocusProjection adopted={adopted} onSelect={onSelect} selectedId={selectedId} />
        ) : null}
      </div>
    </section>
  );
}

interface ViewProps {
  selectedId: string;
  onSelect: (id: string) => void;
  adopted: boolean;
}

function OutlineProjection({ selectedId, onSelect, adopted }: ViewProps) {
  const roots = demoWorldstate.nodes.filter((node) => !node.parentId);

  return (
    <div className={styles.outlineView}>
      <div className={styles.projectionLegend}>
        <span><i className={styles.canonicalDot} />Canonical</span>
        <span><i className={styles.suggestedDot} />{adopted ? "Newly adopted" : "Suggested"}</span>
        <span><i className={styles.openDot} />Open question</span>
      </div>
      <ul aria-label="Project outline" className={styles.tree} role="tree">
        {roots.map((root) => (
          <OutlineBranch
            adopted={adopted}
            depth={0}
            key={root.id}
            node={root}
            onSelect={onSelect}
            selectedId={selectedId}
          />
        ))}
      </ul>
    </div>
  );
}

interface BranchProps extends ViewProps {
  node: WorldNode;
  depth: number;
}

function OutlineBranch({ node, depth, selectedId, onSelect, adopted }: BranchProps) {
  const children = demoWorldstate.nodes.filter((candidate) => candidate.parentId === node.id);
  const isCandidate = node.id === "idea-compare-quotes";
  const state = isCandidate ? (adopted ? "adopted" : "suggested") : node.status.governance.toLowerCase();

  return (
    <li
      aria-expanded={children.length ? true : undefined}
      aria-selected={selectedId === node.id}
      className={styles.treeItem}
      data-state={state}
      data-worldstate-id={node.id}
      role="treeitem"
    >
      <button
        className={styles.treeNode}
        data-depth={depth}
        onClick={() => onSelect(node.id)}
        style={{ "--tree-depth": depth } as React.CSSProperties}
        type="button"
      >
        <span className={styles.treeGlyph}>{node.kind.slice(0, 1).toUpperCase()}</span>
        <span className={styles.treeCopy}>
          <small>{node.eyebrow}</small>
          <strong>{node.label}</strong>
        </span>
        <StatusMark label={isCandidate && adopted ? "Adopted" : node.status.governance} />
      </button>
      {children.length ? (
        <ul role="group">
          {children.map((child) => (
            <OutlineBranch
              adopted={adopted}
              depth={depth + 1}
              key={child.id}
              node={child}
              onSelect={onSelect}
              selectedId={selectedId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

type FlowData = {
  label: string;
  eyebrow: string;
  posture: "canonical" | "suggested" | "adopted" | "open";
};

type FlowWorldNode = Node<FlowData, "worldNode">;

function WorldFlowNode({ id, data, selected }: NodeProps<FlowWorldNode>) {
  return (
    <div
      className={styles.flowNode}
      data-selected={selected ? "true" : "false"}
      data-state={data.posture}
      data-worldstate-id={id}
    >
      <Handle
        className={styles.flowHandle}
        isConnectable={false}
        position={Position.Left}
        type="target"
      />
      <small>{data.eyebrow}</small>
      <strong>{data.label}</strong>
      <Handle
        className={styles.flowHandle}
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

const nodeTypes = { worldNode: WorldFlowNode };

function MapProjection({ selectedId, onSelect, adopted }: ViewProps) {
  const positions: Record<string, { x: number; y: number }> = {
    "project-home-move": { x: 40, y: 155 },
    "goal-under-4000": { x: 310, y: 20 },
    "area-budget": { x: 310, y: 145 },
    "idea-compare-quotes": { x: 590, y: 125 },
    "question-storage": { x: 850, y: 20 },
    "artifact-planning-page": { x: 840, y: 230 },
  };
  const visibleIds = new Set(Object.keys(positions));
  const nodes: FlowWorldNode[] = demoWorldstate.nodes
    .filter((node) => visibleIds.has(node.id))
    .map((node) => {
      const candidate = node.id === "idea-compare-quotes";
      const posture: FlowData["posture"] =
        node.id === "question-storage"
          ? "open"
          : candidate
            ? adopted
              ? "adopted"
              : "suggested"
            : "canonical";
      return {
        id: node.id,
        type: "worldNode",
        position: positions[node.id],
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selected: selectedId === node.id,
        ariaLabel: `${node.eyebrow}: ${node.label}`,
        data: { label: node.label, eyebrow: node.eyebrow ?? node.kind, posture },
      };
    });
  const edges: Edge[] = demoWorldstate.relations
    .filter((relation) => visibleIds.has(relation.source) && visibleIds.has(relation.target))
    .map((relation) => ({
      id: relation.id,
      source: relation.source,
      target: relation.target,
      label: relation.label,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: relation.posture === "proposed" && !adopted,
      className: relation.posture === "proposed" ? styles.proposedEdge : styles.canonicalEdge,
    }));

  return (
    <div className={styles.mapView} data-evidence-anchor="relation-neighborhood">
      <div className={styles.mapTruth}>
        Position helps exploration; it is not stored as project meaning.
      </div>
      <ReactFlow
        colorMode="dark"
        edges={edges}
        edgesFocusable
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.55}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_, node) => onSelect(node.id)}
        panOnScroll
        zoomOnDoubleClick={false}
      >
        <Background color="rgba(142, 231, 200, .12)" gap={22} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <details className={styles.mapFallback}>
        <summary>Accessible relation list</summary>
        <ul>
          {demoWorldstate.relations
            .filter((relation) => visibleIds.has(relation.source) && visibleIds.has(relation.target))
            .map((relation) => (
              <li key={relation.id}>
                {demoWorldstate.nodes.find((node) => node.id === relation.source)?.label} {relation.label}{" "}
                {demoWorldstate.nodes.find((node) => node.id === relation.target)?.label}
              </li>
            ))}
        </ul>
      </details>
    </div>
  );
}

function TimelineProjection({ selectedId, onSelect, adopted }: ViewProps) {
  return (
    <div className={styles.timelineView} data-evidence-anchor="conceptual-lineage">
      <div className={styles.timelineKey}>
        <span data-kind="source">Source</span>
        <span data-kind="revision">Revision</span>
        <span data-kind="worker">Worker</span>
        <span data-kind="evidence">Evidence</span>
      </div>
      <ol className={styles.timelineList}>
        {demoWorldstate.events.map((event, index) => {
          const selected = event.id === "event-placement" && selectedId === "idea-compare-quotes";
          return (
            <li data-kind={event.kind} data-selected={selected ? "true" : "false"} key={event.id}>
              <span className={styles.timelineIndex}>{String(index + 1).padStart(2, "0")}</span>
              <span className={styles.timelineRail} />
              <button
                className={styles.timelineCard}
                data-worldstate-id={event.id === "event-placement" ? "idea-compare-quotes" : event.id}
                onClick={() =>
                  onSelect(event.id === "event-placement" ? "idea-compare-quotes" : "project-home-move")
                }
                type="button"
              >
                <span className={styles.timelineMeta}>
                  <strong>{event.kind}</strong>
                  <time>{event.time}</time>
                  {event.revision ? <code>{event.revision}</code> : null}
                </span>
                <b>{event.label}</b>
                <p>{event.detail}</p>
                {event.id === "event-placement" ? (
                  <em>{adopted ? "Accepted in this sandbox session" : "Still provisional — no revision created"}</em>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FocusProjection({ selectedId, onSelect, adopted }: ViewProps) {
  const selected = demoWorldstate.nodes.find((node) => node.id === selectedId) ?? demoWorldstate.nodes[0];
  const isCandidate = selected.id === "idea-compare-quotes";

  return (
    <div className={styles.focusView}>
      <div className={styles.focusProgress} aria-label="Review progress">
        <span data-state="complete">1 <b>Capture</b></span>
        <i />
        <span data-state="current">2 <b>Understand</b></span>
        <i />
        <span data-state={adopted ? "complete" : "pending"}>3 <b>Accept</b></span>
        <i />
        <span data-state="pending">4 <b>Delegate</b></span>
      </div>
      <article
        className={styles.focusCard}
        data-state={isCandidate ? (adopted ? "adopted" : "suggested") : "canonical"}
        data-worldstate-id={selected.id}
      >
        <span className={styles.focusNumber}>Current context · 02</span>
        <small>{selected.eyebrow}</small>
        <h2>{selected.label}</h2>
        <p>{selected.description ?? "This object remains selected in every projection."}</p>
        <div className={styles.focusConsequences}>
          <span>
            <b>Belongs under</b>
            {selected.parentId
              ? demoWorldstate.nodes.find((node) => node.id === selected.parentId)?.label
              : "World root"}
          </span>
          <span>
            <b>Authority</b>
            {isCandidate && !adopted ? "Needs your semantic commit" : "Already adopted"}
          </span>
        </div>
      </article>
      <div className={styles.focusNeighbors}>
        <button onClick={() => onSelect("goal-under-4000")} type="button">
          <span>Related goal</span>
          Keep total cost below €4,000
        </button>
        <button onClick={() => onSelect("question-storage")} type="button">
          <span>Open question</span>
          Treat recurring storage separately?
        </button>
      </div>
    </div>
  );
}

function StatusMark({ label }: { label: string }) {
  return (
    <span className={styles.statusMark} data-state={label.toLowerCase()}>
      {label}
    </span>
  );
}
