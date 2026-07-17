import type {
  AgentBrief,
  AgentRun,
  ClosureWitness,
  EvidenceValidation,
  LedgerEvent,
  RevisionRecord,
  RunLifecycleStatus,
  SourceRecord,
  WorldstateDelta,
  WorldstateNode,
  WorldstateRelation,
} from "./schema";

export type DeltaDisposition =
  | "pending"
  | "deferred"
  | "rejected"
  | "remanded"
  | "superseded"
  | "accepted";

export interface DeltaProjection {
  readonly delta: WorldstateDelta;
  readonly disposition: DeltaDisposition;
  readonly proposedEventId: string;
  readonly dispositionEventIds: readonly string[];
  readonly acceptedRevisionId?: string;
  readonly supersededByDeltaId?: string;
  readonly reason?: string;
}

export interface RunProjection {
  readonly run: AgentRun;
  readonly status: RunLifecycleStatus;
  readonly lifecycleEventIds: readonly string[];
}

export interface ManagerFailureProjection {
  readonly eventId: string;
  readonly sourceId?: string;
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
}

export interface CanonicalProjection {
  readonly projectId: string;
  readonly head: RevisionRecord;
  readonly revisions: Readonly<Record<string, RevisionRecord>>;
  readonly revisionOrder: readonly string[];
  /** Retired records remain addressable; current selectors filter them. */
  readonly nodes: Readonly<Record<string, WorldstateNode>>;
  /** Retired records remain addressable; current selectors filter them. */
  readonly relations: Readonly<Record<string, WorldstateRelation>>;
}

export interface OperationalProjection {
  readonly sources: Readonly<Record<string, SourceRecord>>;
  readonly managerFailures: readonly ManagerFailureProjection[];
  readonly deltas: Readonly<Record<string, DeltaProjection>>;
  readonly briefs: Readonly<Record<string, AgentBrief>>;
  readonly runs: Readonly<Record<string, RunProjection>>;
  readonly closures: Readonly<Record<string, ClosureWitness>>;
  readonly validations: Readonly<Record<string, EvidenceValidation>>;
  readonly latestValidationByClosure: Readonly<Record<string, string>>;
  readonly selectedProjection: "outline" | "map" | "timeline" | "focus";
}

export interface ProvenanceProjection {
  readonly sourceToDeltaIds: Readonly<Record<string, readonly string[]>>;
  readonly deltaToRevisionId: Readonly<Record<string, string>>;
  readonly supersession: Readonly<Record<string, string>>;
}

export interface WorldstateState {
  readonly canonical: CanonicalProjection;
  readonly operational: OperationalProjection;
  readonly provenance: ProvenanceProjection;
  readonly eventOrder: readonly string[];
}

export interface WorldstateLedger {
  readonly projectId: string;
  readonly genesisRevision: RevisionRecord;
  readonly events: readonly LedgerEvent[];
}

export interface AppendEventResult {
  readonly ledger: WorldstateLedger;
  readonly emittedEventIds: readonly string[];
  readonly replayed: boolean;
}
