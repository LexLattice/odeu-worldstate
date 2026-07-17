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

import { FocusIcon, MapIcon, OutlineIcon, TimelineIcon } from "./icons";
import { layoutProjectionGraph } from "./projection-layout";
import type {
  DemoWorldstate,
  ProjectionView,
  WorkbenchViewModel,
  WorldNode,
} from "./types";
import styles from "./worldstate-workbench.module.css";

type ProjectionWorldstate = DemoWorldstate | WorkbenchViewModel;

interface ProjectionProps {
  activeView: ProjectionView;
  selectedId: string;
  worldstate: ProjectionWorldstate;
  onSelect: (id: string) => void;
  onViewChange: (view: ProjectionView) => void;
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
  worldstate,
  onSelect,
  onViewChange,
}: ProjectionProps) {
  const selected = worldstate.nodes.find((node) => node.id === selectedId);
  const candidateId = getCandidateId(worldstate);
  const candidateAdopted = isCandidateAdopted(worldstate, candidateId);
  const viewProps: ViewProps = {
    candidateAdopted,
    candidateId,
    onSelect,
    selectedId,
    worldstate,
  };

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
          <h1 id="projection-heading">{worldstate.project}</h1>
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
            id={`projection-tab-${id}`}
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
        aria-labelledby={`projection-tab-${activeView}`}
        className={styles.projectionFrame}
        data-morphic-lane="primary-projection"
        id={`projection-${activeView}`}
        role="tabpanel"
      >
        {activeView === "outline" ? <OutlineProjection {...viewProps} /> : null}
        {activeView === "map" ? <MapProjection {...viewProps} /> : null}
        {activeView === "timeline" ? <TimelineProjection {...viewProps} /> : null}
        {activeView === "focus" ? <FocusProjection {...viewProps} /> : null}
      </div>
    </section>
  );
}

interface ViewProps {
  selectedId: string;
  worldstate: ProjectionWorldstate;
  candidateId: string | null;
  candidateAdopted: boolean;
  onSelect: (id: string) => void;
}

function isWorkbenchViewModel(
  worldstate: ProjectionWorldstate,
): worldstate is WorkbenchViewModel {
  return "placement" in worldstate;
}

function getCandidateId(worldstate: ProjectionWorldstate): string | null {
  if (isWorkbenchViewModel(worldstate) && worldstate.placement.candidateId) {
    return worldstate.placement.candidateId;
  }

  const proposedNodeIds = new Set(
    worldstate.relations
      .filter((relation) => relation.posture === "proposed")
      .flatMap((relation) => [relation.source, relation.target]),
  );

  return (
    worldstate.nodes.find(
      (node) =>
        node.status.governance === "Suggested" && proposedNodeIds.has(node.id),
    )?.id ??
    worldstate.nodes.find((node) => node.status.governance === "Suggested")?.id ??
    null
  );
}

function isCandidateAdopted(
  worldstate: ProjectionWorldstate,
  candidateId: string | null,
): boolean {
  if (!candidateId) {
    return false;
  }

  return (
    (isWorkbenchViewModel(worldstate) &&
      worldstate.placement.state === "adopted") ||
    worldstate.nodes.find((node) => node.id === candidateId)?.status.governance ===
      "Adopted"
  );
}

type NodePosture = "canonical" | "suggested" | "adopted" | "open";

function nodePosture(
  node: WorldNode,
  candidateId: string | null,
  candidateAdopted: boolean,
): NodePosture {
  if (node.id === candidateId) {
    return candidateAdopted || node.status.governance === "Adopted"
      ? "adopted"
      : "suggested";
  }

  if (node.status.knowledge === "Open") {
    return "open";
  }

  return node.status.governance === "Suggested" ? "suggested" : "canonical";
}

function primaryNodeId(worldstate: ProjectionWorldstate): string | null {
  const configuredProjectId = isWorkbenchViewModel(worldstate)
    ? worldstate.projectNodeId
    : null;

  return (
    worldstate.nodes.find((node) => node.id === configuredProjectId)?.id ??
    worldstate.nodes.find((node) => node.kind === "project")?.id ??
    worldstate.nodes.find((node) => !node.parentId)?.id ??
    worldstate.nodes[0]?.id ??
    null
  );
}

function outlineRoots(nodes: readonly WorldNode[]): WorldNode[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, WorldNode[]>();

  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }

    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const roots = nodes.filter(
    (node) => !node.parentId || !nodesById.has(node.parentId),
  );
  const visited = new Set<string>();
  const markReachable = (root: WorldNode) => {
    const stack = [root];

    while (stack.length) {
      const current = stack.pop();
      if (!current || visited.has(current.id)) {
        continue;
      }

      visited.add(current.id);
      stack.push(...(childrenByParent.get(current.id) ?? []));
    }
  };

  roots.forEach(markReachable);
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      roots.push(node);
      markReachable(node);
    }
  }

  return roots;
}

function OutlineProjection({
  selectedId,
  worldstate,
  candidateId,
  candidateAdopted,
  onSelect,
}: ViewProps) {
  const roots = outlineRoots(worldstate.nodes);

  return (
    <div className={styles.outlineView}>
      <div className={styles.projectionLegend}>
        <span><i className={styles.canonicalDot} />Canonical</span>
        <span>
          <i className={styles.suggestedDot} />
          {candidateAdopted ? "Newly adopted" : "Suggested"}
        </span>
        <span><i className={styles.openDot} />Open question</span>
      </div>
      <ul aria-label="Project outline" className={styles.tree} role="tree">
        {roots.map((root) => (
          <OutlineBranch
            candidateAdopted={candidateAdopted}
            candidateId={candidateId}
            depth={0}
            key={root.id}
            node={root}
            nodes={worldstate.nodes}
            onSelect={onSelect}
            path={new Set()}
            selectedId={selectedId}
          />
        ))}
      </ul>
    </div>
  );
}

interface BranchProps {
  node: WorldNode;
  nodes: readonly WorldNode[];
  depth: number;
  selectedId: string;
  candidateId: string | null;
  candidateAdopted: boolean;
  path: ReadonlySet<string>;
  onSelect: (id: string) => void;
}

function OutlineBranch({
  node,
  nodes,
  depth,
  selectedId,
  candidateId,
  candidateAdopted,
  path,
  onSelect,
}: BranchProps) {
  const nextPath = new Set(path).add(node.id);
  const children = nodes.filter(
    (candidate) =>
      candidate.parentId === node.id && !nextPath.has(candidate.id),
  );
  const posture = nodePosture(node, candidateId, candidateAdopted);
  const governanceLabel =
    node.id === candidateId && candidateAdopted
      ? "Adopted"
      : node.status.governance;

  return (
    <li
      aria-expanded={children.length ? true : undefined}
      aria-selected={selectedId === node.id}
      className={styles.treeItem}
      data-state={posture}
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
          <small>{node.eyebrow ?? node.kind}</small>
          <strong>{node.label}</strong>
        </span>
        <StatusMark label={governanceLabel} />
      </button>
      {children.length ? (
        <ul role="group">
          {children.map((child) => (
            <OutlineBranch
              candidateAdopted={candidateAdopted}
              candidateId={candidateId}
              depth={depth + 1}
              key={child.id}
              node={child}
              nodes={nodes}
              onSelect={onSelect}
              path={nextPath}
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
  posture: NodePosture;
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

function MapProjection({
  selectedId,
  worldstate,
  candidateId,
  candidateAdopted,
  onSelect,
}: ViewProps) {
  const layout = layoutProjectionGraph(worldstate.nodes, worldstate.relations);
  const nodesById = new Map(worldstate.nodes.map((node) => [node.id, node]));
  const nodes: FlowWorldNode[] = worldstate.nodes.map((node) => ({
    id: node.id,
    type: "worldNode",
    position: layout.positions[node.id],
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: selectedId === node.id,
    ariaLabel: `${node.eyebrow ?? node.kind}: ${node.label}`,
    data: {
      label: node.label,
      eyebrow: node.eyebrow ?? node.kind,
      posture: nodePosture(node, candidateId, candidateAdopted),
    },
  }));
  const visibleRelations = worldstate.relations.filter(
    (relation) =>
      nodesById.has(relation.source) && nodesById.has(relation.target),
  );
  const edges: Edge[] = visibleRelations.map((relation) => ({
    id: relation.id,
    source: relation.source,
    target: relation.target,
    label: relation.label,
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: relation.posture === "proposed" && !candidateAdopted,
    className:
      relation.posture === "proposed"
        ? styles.proposedEdge
        : styles.canonicalEdge,
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
          {visibleRelations.map((relation) => (
            <li key={relation.id}>
              {nodesById.get(relation.source)?.label} {relation.label}{" "}
              {nodesById.get(relation.target)?.label}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function TimelineProjection({
  selectedId,
  worldstate,
  candidateId,
  candidateAdopted,
  onSelect,
}: ViewProps) {
  const fallbackId = primaryNodeId(worldstate);
  const visibleNodeIds = new Set(worldstate.nodes.map((node) => node.id));

  return (
    <div className={styles.timelineView} data-evidence-anchor="conceptual-lineage">
      <div className={styles.timelineKey}>
        <span data-kind="source">Source</span>
        <span data-kind="revision">Revision</span>
        <span data-kind="worker">Worker</span>
        <span data-kind="evidence">Evidence</span>
      </div>
      <ol aria-label="Worldstate history" className={styles.timelineList}>
        {worldstate.events.map((event, index) => {
          const eventWorldstateId =
            event.worldstateId && visibleNodeIds.has(event.worldstateId)
              ? event.worldstateId
              : fallbackId ?? worldstate.nodes[0]?.id ?? event.id;
          const selected = selectedId === eventWorldstateId;
          const describesCandidate = eventWorldstateId === candidateId;

          return (
            <li
              data-kind={event.kind}
              data-selected={selected ? "true" : "false"}
              key={event.id}
            >
              <span className={styles.timelineIndex}>{String(index + 1).padStart(2, "0")}</span>
              <span className={styles.timelineRail} />
              <button
                aria-label={`${event.label}: ${event.detail}`}
                className={styles.timelineCard}
                data-worldstate-id={eventWorldstateId}
                onClick={() => onSelect(eventWorldstateId)}
                type="button"
              >
                <span className={styles.timelineMeta}>
                  <strong>{event.kind}</strong>
                  <time>{event.time}</time>
                  {event.revision ? <code>{event.revision}</code> : null}
                </span>
                <b>{event.label}</b>
                <p>{event.detail}</p>
                {describesCandidate ? (
                  <em>
                    {candidateAdopted
                      ? "Accepted in the persisted worldstate"
                      : "Still provisional — no revision created"}
                  </em>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface FocusNeighbor {
  node: WorldNode;
  relationLabel: string;
}

function focusNeighbors(
  selected: WorldNode,
  worldstate: ProjectionWorldstate,
): FocusNeighbor[] {
  const nodesById = new Map(worldstate.nodes.map((node) => [node.id, node]));
  const neighbors = new Map<string, FocusNeighbor>();
  const addNeighbor = (nodeId: string | undefined, relationLabel: string) => {
    const node = nodeId ? nodesById.get(nodeId) : undefined;
    if (node && node.id !== selected.id && !neighbors.has(node.id)) {
      neighbors.set(node.id, { node, relationLabel });
    }
  };

  addNeighbor(selected.parentId, "Parent context");

  for (const relation of worldstate.relations) {
    if (relation.source === selected.id) {
      addNeighbor(relation.target, relation.label);
    } else if (relation.target === selected.id) {
      addNeighbor(relation.source, relation.label);
    }
  }

  for (const child of worldstate.nodes) {
    if (child.parentId === selected.id) {
      addNeighbor(child.id, "Contained object");
    }
  }

  return [...neighbors.values()].slice(0, 2);
}

function FocusProjection({
  selectedId,
  worldstate,
  candidateId,
  candidateAdopted,
  onSelect,
}: ViewProps) {
  const selected =
    worldstate.nodes.find((node) => node.id === selectedId) ??
    worldstate.nodes.find((node) => node.id === candidateId) ??
    worldstate.nodes.find((node) => node.id === primaryNodeId(worldstate)) ??
    worldstate.nodes[0];

  if (!selected) {
    return (
      <div className={styles.focusView}>
        <p>No worldstate object is available for focused review.</p>
      </div>
    );
  }

  const posture = nodePosture(selected, candidateId, candidateAdopted);
  const parent = selected.parentId
    ? worldstate.nodes.find((node) => node.id === selected.parentId)
    : undefined;
  const neighbors = focusNeighbors(selected, worldstate);
  const ordinal = worldstate.nodes.findIndex((node) => node.id === selected.id) + 1;
  const sourceCaptured = isWorkbenchViewModel(worldstate)
    ? Boolean(worldstate.placement.sourceId)
    : true;
  const interpretationAvailable = Boolean(candidateId);
  const workAvailable = isWorkbenchViewModel(worldstate)
    ? worldstate.work.available
    : true;
  const authority =
    posture === "suggested"
      ? "Needs your semantic commit"
      : selected.status.governance === "Restricted"
        ? "Restricted by project governance"
        : "Already adopted";

  return (
    <div className={styles.focusView}>
      <div className={styles.focusProgress} aria-label="Review progress">
        <span data-state={sourceCaptured ? "complete" : "current"}>1 <b>Capture</b></span>
        <i />
        <span
          data-state={
            candidateAdopted
              ? "complete"
              : interpretationAvailable
                ? "current"
                : "pending"
          }
        >
          2 <b>Understand</b>
        </span>
        <i />
        <span data-state={candidateAdopted ? "complete" : "pending"}>3 <b>Accept</b></span>
        <i />
        <span data-state={workAvailable ? "pending" : "unavailable"}>
          4 <b>{workAvailable ? "Delegate" : "Work unavailable"}</b>
        </span>
      </div>
      <article
        className={styles.focusCard}
        data-state={posture}
        data-worldstate-id={selected.id}
      >
        <span className={styles.focusNumber}>
          Current context · {String(ordinal).padStart(2, "0")}
        </span>
        <small>{selected.eyebrow ?? selected.kind}</small>
        <h2>{selected.label}</h2>
        <p>{selected.description ?? "This object remains selected in every projection."}</p>
        <div className={styles.focusConsequences}>
          <span>
            <b>Belongs under</b>
            {parent?.label ?? "World root"}
          </span>
          <span>
            <b>Authority</b>
            {authority}
          </span>
        </div>
      </article>
      {neighbors.length ? (
        <div className={styles.focusNeighbors}>
          {neighbors.map(({ node, relationLabel }) => (
            <button
              data-worldstate-id={node.id}
              key={node.id}
              onClick={() => onSelect(node.id)}
              type="button"
            >
              <span>{relationLabel}</span>
              {node.label}
            </button>
          ))}
        </div>
      ) : null}
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
