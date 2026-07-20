import type {
  WorldstateSessionOperationState,
  WorldstateSessionPersistenceState,
} from "@/application/worldstate-session";

import type { PlacementSurface } from "./types";

export type WorldstatePlacementManagerMode =
  | "fixture"
  | "live"
  | "unavailable";

/**
 * Scalar placement truth exposed to read-only consumers such as guided UI.
 *
 * This projection deliberately carries no source text, session reference,
 * callback, or command capability. `canAccept` reports the underlying domain
 * gate only; it does not grant semantic-commit authority.
 */
export interface WorldstatePlacementObservation {
  readonly state: PlacementSurface["state"];
  readonly operationState: WorldstateSessionOperationState;
  readonly persistenceState: WorldstateSessionPersistenceState;
  readonly sourceId: string | null;
  readonly requestId: string | null;
  readonly requestSelectedNodeId: string | null;
  readonly attemptId: string | null;
  readonly exchangeId: string | null;
  readonly receiptId: string | null;
  readonly deltaId: string | null;
  readonly candidateId: string | null;
  readonly locationTargetNodeId: string | null;
  readonly baseRevisionId: string | null;
  readonly acceptedRevisionId: string | null;
  readonly headRevisionId: string | null;
  readonly managerMode: WorldstatePlacementManagerMode;
  readonly managerLabel: string;
  readonly retryable: boolean;
  readonly canAccept: boolean;
}

export interface DeriveWorldstatePlacementObservationInput {
  readonly placement: PlacementSurface;
  readonly operationState: WorldstateSessionOperationState;
  readonly persistenceState: WorldstateSessionPersistenceState;
  readonly headRevisionId: string | null;
  readonly managerMode: WorldstatePlacementManagerMode;
}

export function deriveWorldstatePlacementObservation(
  input: DeriveWorldstatePlacementObservationInput,
): WorldstatePlacementObservation {
  return Object.freeze({
    state: input.placement.state,
    operationState: input.operationState,
    persistenceState: input.persistenceState,
    sourceId: input.placement.sourceId,
    requestId: input.placement.requestId,
    requestSelectedNodeId: input.placement.requestSelectedNodeId,
    attemptId: input.placement.attemptId,
    exchangeId: input.placement.exchangeId,
    receiptId: input.placement.receiptId,
    deltaId: input.placement.deltaId,
    candidateId: input.placement.candidateId,
    locationTargetNodeId: input.placement.locationTargetNodeId,
    baseRevisionId: input.placement.baseRevisionId,
    acceptedRevisionId: input.placement.acceptedRevisionId,
    headRevisionId: input.headRevisionId,
    managerMode: input.managerMode,
    managerLabel: input.placement.managerLabel,
    retryable: input.placement.retryable,
    canAccept: input.placement.canAccept,
  });
}

export function worldstatePlacementObservationEqual(
  left: WorldstatePlacementObservation | null,
  right: WorldstatePlacementObservation | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;

  return (
    left.state === right.state &&
    left.operationState === right.operationState &&
    left.persistenceState === right.persistenceState &&
    left.sourceId === right.sourceId &&
    left.requestId === right.requestId &&
    left.requestSelectedNodeId === right.requestSelectedNodeId &&
    left.attemptId === right.attemptId &&
    left.exchangeId === right.exchangeId &&
    left.receiptId === right.receiptId &&
    left.deltaId === right.deltaId &&
    left.candidateId === right.candidateId &&
    left.locationTargetNodeId === right.locationTargetNodeId &&
    left.baseRevisionId === right.baseRevisionId &&
    left.acceptedRevisionId === right.acceptedRevisionId &&
    left.headRevisionId === right.headRevisionId &&
    left.managerMode === right.managerMode &&
    left.managerLabel === right.managerLabel &&
    left.retryable === right.retryable &&
    left.canAccept === right.canAccept
  );
}
