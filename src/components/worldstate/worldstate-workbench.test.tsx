import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorldstateWorkbench } from "./worldstate-workbench";

afterEach(cleanup);

describe("WorldstateWorkbench", () => {
  it("keeps the selected worldstate object stable while the projection changes", async () => {
    const user = userEvent.setup();
    const { container } = render(<WorldstateWorkbench />);
    const root = container.querySelector("[data-morphic-root='worldstate-workbench']");

    await user.click(screen.getByRole("button", { name: /Complete the move for less than €4,000/i }));
    expect(root).toHaveAttribute("data-selected-object-id", "goal-under-4000");

    await user.click(screen.getByRole("tab", { name: /Focus/i }));
    expect(root).toHaveAttribute("data-view", "focus");
    expect(root).toHaveAttribute("data-selected-object-id", "goal-under-4000");
    expect(
      container.querySelector("[data-view='focus'] [data-worldstate-id='goal-under-4000']"),
    ).toBeInTheDocument();
  });

  it("keeps semantic commit, replay dispatch, and result integration as separate gates", async () => {
    const user = userEvent.setup();
    const onSemanticCommit = vi.fn();
    const onAgentDispatch = vi.fn();
    const onResultIntegrate = vi.fn();
    const { container } = render(
      <WorldstateWorkbench
        onAgentDispatch={onAgentDispatch}
        onResultIntegrate={onResultIntegrate}
        onSemanticCommit={onSemanticCommit}
      />,
    );
    const root = container.querySelector("[data-morphic-root='worldstate-workbench']");
    const dispatch = screen.getByRole("button", { name: /Approve & load fixture replay/i });
    const integrate = screen.getByRole("button", { name: /Integrate result/i });

    expect(dispatch).toBeDisabled();
    expect(integrate).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add to my worldstate" }));
    expect(root).toHaveAttribute("data-worldstate-revision", "rev-019");
    expect(onSemanticCommit).toHaveBeenCalledOnce();
    expect(dispatch).toBeEnabled();
    expect(integrate).toBeDisabled();

    await user.click(dispatch);
    expect(root).toHaveAttribute("data-worldstate-revision", "rev-019");
    expect(onAgentDispatch).toHaveBeenCalledOnce();
    expect(screen.getByText("Addressable artifact change")).toBeInTheDocument();
    expect(screen.getByText("demo/moving-costs.html")).toBeInTheDocument();
    expect(screen.getByText("Focused calculation tests")).toBeInTheDocument();
    expect(screen.getAllByText("home-move-fixture-replay-v0").length).toBeGreaterThan(0);
    expect(screen.getByText("Result staged")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(integrate).toBeEnabled();

    await user.click(integrate);
    expect(root).toHaveAttribute("data-worldstate-revision", "rev-020");
    expect(onResultIntegrate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Result integrated" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("exposes stable Morphic regions, evidence anchors, and action clusters", () => {
    const { container } = render(<WorldstateWorkbench />);

    for (const region of [
      "scope",
      "projection",
      "interpretation",
      "evidence",
      "governance",
      "work",
      "status",
    ]) {
      expect(container.querySelector(`[data-morphic-region='${region}']`)).toBeInTheDocument();
    }

    for (const cluster of [
      "advisory-actions",
      "semantic-commit",
      "agent-delegation",
      "result-reconciliation",
    ]) {
      expect(container.querySelector(`[data-action-cluster='${cluster}']`)).toBeInTheDocument();
    }

    expect(container.querySelector("[data-evidence-anchor='original-source']")).toBeInTheDocument();
    expect(container.querySelector("[data-evidence-anchor='material-uncertainty']")).toBeInTheDocument();
  });
});
