import { describe, expect, it } from "vitest";

import {
  worldstatePresentationCommandSatisfied,
  type WorldstatePresentationCommand,
  type WorldstatePresentationState,
} from "./presentation";

const state: WorldstatePresentationState = {
  projectId: "project-home-move",
  projectLabel: "Plan our home move",
  view: "outline",
  selectedObjectId: "node-goal-under-4000",
  selectedObjectLabel: "Complete the move for less than €4,000",
};

describe("worldstate presentation commands", () => {
  it.each<{
    command: WorldstatePresentationCommand;
    expected: boolean;
  }>([
    {
      command: {
        id: "presentation-project-matches",
        type: "select_project",
        projectId: state.projectId,
      },
      expected: true,
    },
    {
      command: {
        id: "presentation-project-differs",
        type: "select_project",
        projectId: "project-unsupported",
      },
      expected: false,
    },
    {
      command: {
        id: "presentation-view-matches",
        type: "select_view",
        view: state.view,
      },
      expected: true,
    },
    {
      command: {
        id: "presentation-view-differs",
        type: "select_view",
        view: "focus",
      },
      expected: false,
    },
    {
      command: {
        id: "presentation-object-matches",
        type: "select_object",
        objectId: state.selectedObjectId,
      },
      expected: true,
    },
    {
      command: {
        id: "presentation-object-differs",
        type: "select_object",
        objectId: "node-unsupported",
      },
      expected: false,
    },
  ])("derives $command.type satisfaction from observed state", ({
    command,
    expected,
  }) => {
    expect(worldstatePresentationCommandSatisfied(command, state)).toBe(
      expected,
    );
  });
});
