import type {
  AgentBrief,
  ClosureWitness,
  RevisionRecord,
  WorldstateNode,
  WorldstateRelation,
} from "./schema";
import type { DeltaProjection, RunProjection, WorldstateState } from "./types";

export const selectHeadRevision = (state: WorldstateState): RevisionRecord =>
  state.canonical.head;

export const selectCurrentNodes = (state: WorldstateState): readonly WorldstateNode[] =>
  Object.values(state.canonical.nodes).filter((node) => !node.retiredRevisionId);

export const selectCurrentRelations = (
  state: WorldstateState,
): readonly WorldstateRelation[] =>
  Object.values(state.canonical.relations).filter((relation) => !relation.retiredRevisionId);

export const selectPendingProposals = (
  state: WorldstateState,
): readonly DeltaProjection[] =>
  Object.values(state.operational.deltas).filter(
    (projection) =>
      projection.disposition === "pending" || projection.disposition === "deferred",
  );

export const selectDelta = (
  state: WorldstateState,
  deltaId: string | undefined,
): DeltaProjection | undefined => (deltaId ? state.operational.deltas[deltaId] : undefined);

export const selectBrief = (
  state: WorldstateState,
  briefId: string | undefined,
): AgentBrief | undefined => (briefId ? state.operational.briefs[briefId] : undefined);

export const selectLatestBrief = (state: WorldstateState): AgentBrief | undefined => {
  const briefs = Object.values(state.operational.briefs);
  return briefs.at(-1);
};

export const selectRun = (
  state: WorldstateState,
  runId: string | undefined,
): RunProjection | undefined => (runId ? state.operational.runs[runId] : undefined);

export const selectLatestRun = (state: WorldstateState): RunProjection | undefined => {
  const runs = Object.values(state.operational.runs);
  return runs.at(-1);
};

export const selectClosure = (
  state: WorldstateState,
  closureId: string | undefined,
): ClosureWitness | undefined =>
  closureId ? state.operational.closures[closureId] : undefined;

export const selectLatestClosure = (state: WorldstateState): ClosureWitness | undefined => {
  const closures = Object.values(state.operational.closures);
  return closures.at(-1);
};

export const selectIsStale = (
  state: WorldstateState,
  baseRevisionId: string,
): boolean => baseRevisionId !== state.canonical.head.id;
