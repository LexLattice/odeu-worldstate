export type ProjectionView = "outline" | "map" | "timeline" | "focus";

export type NodeKind =
  | "world"
  | "project"
  | "goal"
  | "area"
  | "artifact"
  | "idea"
  | "question"
  | "task"
  | "decision"
  | "constraint"
  | "agent-run"
  | "evidence";

export interface StatusSet {
  knowledge: "Draft" | "Supported" | "Challenged" | "Open" | "Out of date";
  governance: "Suggested" | "Adopted" | "Restricted";
  work: "Planned" | "Running" | "Blocked" | "Completed" | "Verified";
}

export interface WorldNode {
  id: string;
  label: string;
  kind: NodeKind;
  parentId?: string;
  eyebrow?: string;
  description?: string;
  status: StatusSet;
}

export interface WorldRelation {
  id: string;
  source: string;
  target: string;
  label: string;
  posture: "canonical" | "proposed" | "evidence";
}

export interface WorldEvent {
  id: string;
  kind: "source" | "revision" | "worker" | "evidence";
  label: string;
  detail: string;
  time: string;
  revision?: string;
  worldstateId?: string;
}

export interface DemoWorldstate {
  world: string;
  project: string;
  revision: string;
  nodes: WorldNode[];
  relations: WorldRelation[];
  events: WorldEvent[];
}

export type PlacementSurfaceState =
  | "idle"
  | "loading"
  | "reviewable"
  | "needs_clarification"
  | "failed"
  | "stale"
  | "adopted";

export type PersistenceSurfaceState =
  | "loading"
  | "saving"
  | "saved"
  | "conflict"
  | "unavailable"
  | "corrupt";

export interface PlacementSurface {
  state: PlacementSurfaceState;
  sourceId: string | null;
  sourceText: string | null;
  sourceCapturedAt: string | null;
  deltaId: string | null;
  candidateId: string | null;
  exchangeId: string | null;
  receiptId: string | null;
  locationLabel: string | null;
  breadcrumb: string[];
  proposedKind: string | null;
  proposedTitle: string | null;
  proposedSummary: string | null;
  rationale: string | null;
  confidence: "high" | "medium" | "low" | null;
  uncertainty: string[];
  alternatives: Array<{ title: string; rationale: string }>;
  conflicts: Array<{ title: string; reason: string; severity: "notice" | "material" }>;
  affectedTitles: string[];
  visibleConsequence: string | null;
  clarificationQuestion: string | null;
  managerLabel: string;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  canAccept: boolean;
  gateReason: string;
}

export interface WorkbenchViewModel extends DemoWorldstate {
  projectId: string;
  projectNodeId: string;
  placement: PlacementSurface;
  persistence: {
    state: PersistenceSurfaceState;
    detail: string;
  };
  runtime: {
    mode: "fixture" | "live" | "unavailable";
    label: string;
  };
  work: {
    available: false;
    reason: string;
  };
}
