export type ProjectionView = "outline" | "map" | "timeline" | "focus";

export type NodeKind = "project" | "goal" | "area" | "artifact" | "idea" | "question";

export interface StatusSet {
  knowledge: "Draft" | "Supported" | "Open";
  governance: "Suggested" | "Adopted" | "Restricted";
  work: "Planned" | "Running" | "Completed" | "Verified";
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
}

export interface DemoWorldstate {
  world: string;
  project: string;
  revision: string;
  nodes: WorldNode[];
  relations: WorldRelation[];
  events: WorldEvent[];
}
