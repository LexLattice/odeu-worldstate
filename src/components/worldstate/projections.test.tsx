import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DemoWorldstate, ProjectionView } from "./types";
import { ProjectionSurface } from "./projections";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({
    children,
    nodes,
    onNodeClick,
  }: {
    children?: ReactNode;
    nodes: Array<{ id: string; position: { x: number; y: number } }>;
    onNodeClick?: (event: unknown, node: { id: string }) => void;
  }) => (
    <div data-testid="flow">
      {nodes.map((node) => (
        <button
          data-position={`${node.position.x},${node.position.y}`}
          data-worldstate-id={node.id}
          key={node.id}
          onClick={() => onNodeClick?.({}, node)}
          type="button"
        >
          map {node.id}
        </button>
      ))}
      {children}
    </div>
  ),
}));

afterEach(cleanup);

const worldstate: DemoWorldstate = {
  world: "Dynamic world",
  project: "Dynamic project",
  revision: "revision-dynamic",
  nodes: [
    {
      id: "root-dynamic",
      kind: "project",
      label: "Dynamic project",
      status: { knowledge: "Supported", governance: "Adopted", work: "Running" },
    },
    {
      id: "candidate-dynamic",
      kind: "idea",
      label: "Dynamic candidate",
      parentId: "root-dynamic",
      status: { knowledge: "Draft", governance: "Suggested", work: "Planned" },
    },
    {
      id: "neighbor-dynamic",
      kind: "goal",
      label: "Dynamic neighbor",
      parentId: "root-dynamic",
      status: { knowledge: "Supported", governance: "Adopted", work: "Planned" },
    },
  ],
  relations: [
    {
      id: "relation-dynamic",
      label: "supports",
      posture: "proposed",
      source: "candidate-dynamic",
      target: "neighbor-dynamic",
    },
  ],
  events: [
    {
      id: "event-dynamic",
      kind: "evidence",
      label: "Dynamic placement",
      detail: "The candidate was placed from durable evidence.",
      time: "10:42",
      worldstateId: "candidate-dynamic",
    },
  ],
};

function renderProjection(activeView: ProjectionView, onSelect = vi.fn()) {
  const rendered = render(
    <ProjectionSurface
      activeView={activeView}
      onSelect={onSelect}
      onViewChange={vi.fn()}
      selectedId="candidate-dynamic"
      worldstate={worldstate}
    />,
  );

  return { ...rendered, onSelect };
}

describe("ProjectionSurface", () => {
  it("renders and selects dynamic identities in the outline", () => {
    const { container, onSelect } = renderProjection("outline");

    expect(screen.getByRole("heading", { name: "Dynamic project" })).toBeInTheDocument();
    expect(
      container.querySelector("[data-worldstate-id='candidate-dynamic']"),
    ).toHaveAttribute("data-state", "suggested");

    fireEvent.click(screen.getByRole("button", { name: /Dynamic candidate/i }));
    expect(onSelect).toHaveBeenCalledWith("candidate-dynamic");
  });

  it("lays out every dynamic map node and preserves selection callbacks", () => {
    const { onSelect } = renderProjection("map");

    const candidate = screen.getByRole("button", { name: "map candidate-dynamic" });
    expect(candidate).toHaveAttribute("data-worldstate-id", "candidate-dynamic");
    expect(candidate).toHaveAttribute("data-position");

    fireEvent.click(candidate);
    expect(onSelect).toHaveBeenCalledWith("candidate-dynamic");
    expect(screen.getByText(/Dynamic candidate supports Dynamic neighbor/)).toBeInTheDocument();
  });

  it("uses an event's optional worldstate identity in the timeline", () => {
    const { container, onSelect } = renderProjection("timeline");

    const event = screen.getByRole("button", {
      name: /Dynamic placement: The candidate was placed from durable evidence/i,
    });
    expect(event).toHaveAttribute("data-worldstate-id", "candidate-dynamic");
    expect(container.querySelector("[data-selected='true']")).toBeInTheDocument();

    fireEvent.click(event);
    expect(onSelect).toHaveBeenCalledWith("candidate-dynamic");
  });

  it("falls back to a visible node when timeline evidence names a source or delta", () => {
    const onSelect = vi.fn();
    const evidenceWorldstate: DemoWorldstate = {
      ...worldstate,
      events: [
        {
          id: "event-source-identity",
          kind: "source",
          label: "Source captured",
          detail: "A durable source was captured.",
          time: "10:43",
          worldstateId: "source-not-a-worldstate-node",
        },
        {
          id: "event-delta-identity",
          kind: "revision",
          label: "Update deferred",
          detail: "The placement delta was deferred.",
          time: "10:44",
          worldstateId: "delta-not-a-worldstate-node",
        },
      ],
    };
    render(
      <ProjectionSurface
        activeView="timeline"
        onSelect={onSelect}
        onViewChange={vi.fn()}
        selectedId="candidate-dynamic"
        worldstate={evidenceWorldstate}
      />,
    );

    const sourceEvent = screen.getByRole("button", {
      name: /Source captured: A durable source was captured/i,
    });
    const deltaEvent = screen.getByRole("button", {
      name: /Update deferred: The placement delta was deferred/i,
    });
    expect(sourceEvent).toHaveAttribute("data-worldstate-id", "root-dynamic");
    expect(deltaEvent).toHaveAttribute("data-worldstate-id", "root-dynamic");

    fireEvent.click(sourceEvent);
    fireEvent.click(deltaEvent);
    expect(onSelect).toHaveBeenNthCalledWith(1, "root-dynamic");
    expect(onSelect).toHaveBeenNthCalledWith(2, "root-dynamic");
  });

  it("renders focused data and derives neighbor actions without fixture IDs", () => {
    const { container, onSelect } = renderProjection("focus");

    expect(screen.getByRole("heading", { name: "Dynamic candidate" })).toBeInTheDocument();
    expect(
      container.querySelector("article[data-worldstate-id='candidate-dynamic']"),
    ).toHaveAttribute("data-state", "suggested");

    fireEvent.click(screen.getByRole("button", { name: /Dynamic neighbor/i }));
    expect(onSelect).toHaveBeenCalledWith("neighbor-dynamic");
  });
});
