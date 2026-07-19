import type { ProjectionView } from "./types";

export type WorldstatePresentationCommand =
  | {
      readonly id: string;
      readonly type: "select_project";
      readonly projectId: string;
    }
  | {
      readonly id: string;
      readonly type: "select_view";
      readonly view: ProjectionView;
    }
  | {
      readonly id: string;
      readonly type: "select_object";
      readonly objectId: string;
    };

export interface WorldstatePresentationState {
  readonly projectId: string;
  readonly projectLabel: string;
  readonly view: ProjectionView;
  readonly selectedObjectId: string;
  readonly selectedObjectLabel: string;
}

export function worldstatePresentationCommandSatisfied(
  command: WorldstatePresentationCommand,
  state: WorldstatePresentationState,
): boolean {
  switch (command.type) {
    case "select_project":
      return state.projectId === command.projectId;
    case "select_view":
      return state.view === command.view;
    case "select_object":
      return state.selectedObjectId === command.objectId;
  }
}
