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
  "loading" | "saving" | "saved" | "conflict" | "unavailable" | "corrupt";

export interface PlacementSurface {
  state: PlacementSurfaceState;
  sourceId: string | null;
  sourceText: string | null;
  sourceCapturedAt: string | null;
  requestId: string | null;
  requestSelectedNodeId: string | null;
  attemptId: string | null;
  baseRevisionId: string | null;
  acceptedRevisionId: string | null;
  deltaId: string | null;
  candidateId: string | null;
  exchangeId: string | null;
  receiptId: string | null;
  locationTargetNodeId: string | null;
  locationLabel: string | null;
  breadcrumb: string[];
  proposedKind: string | null;
  delegationProfileId: string | null;
  proposedTitle: string | null;
  proposedSummary: string | null;
  rationale: string | null;
  confidence: "high" | "medium" | "low" | null;
  uncertainty: string[];
  alternatives: Array<{ title: string; rationale: string }>;
  conflicts: Array<{
    title: string;
    reason: string;
    severity: "notice" | "material";
  }>;
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

export type WorkSurfaceState =
  | "ineligible"
  | "eligible"
  | "preparing"
  | "previewable"
  | "authorizing"
  | "dispatching"
  | "persisting_result"
  | "queued"
  | "received"
  | "working"
  | "blocked"
  | "outcome_unknown"
  | "returned"
  | "failed"
  | "cancelled"
  | "quarantined"
  | "stale";

export interface AgentBriefSurface {
  id: string;
  baseRevisionId: string;
  artifactBaseRef: string;
  targetNodeId: string;
  delegationProfileId: string | null;
  goal: string;
  doneMeans: string[];
  unknowns: string[];
  constraints: string[];
  expectedArtifacts: string[];
  sharedContext: Array<{
    id: string;
    kind: string;
    label: string;
    summary: string;
  }>;
  sharedRelationCount: number;
  omittedContext: Array<{
    id: string;
    label: string;
    reason: "private" | "out_of_scope";
  }>;
  environment: string;
  agentProfile: string;
  allowedActions: string[];
  deniedActions: string[];
  confirmationRequired: string[];
  evidenceRequirements: Array<{
    id: string;
    label: string;
    kind: "test" | "artifact" | "review" | "command" | "other";
    required: boolean;
    command: string | null;
  }>;
  blockIntegrationWithoutEvidence: boolean;
  escalationPath: string;
  stale: boolean;
}

export interface AgentRunSurface {
  id: string;
  briefId: string;
  mode: "live" | "replay";
  status:
    | "queued"
    | "received"
    | "working"
    | "blocked"
    | "outcome_unknown"
    | "returned"
    | "failed"
    | "cancelled";
  lifecycle: Array<{
    id: string;
    status:
      | "queued"
      | "received"
      | "working"
      | "blocked"
      | "outcome_unknown"
      | "returned"
      | "failed"
      | "cancelled";
    at: string;
    message: string;
    evidenceRefs: string[];
  }>;
  stale: boolean;
}

export interface AgentResultSurface {
  exchangeSourceId: string | null;
  closureId: string | null;
  outcome: "returned" | "blocked" | "failed" | "cancelled";
  summary: string;
  claimedDone: boolean;
  criteriaClaimedSatisfied: boolean[];
  claimedEffects: string[];
  claimedArtifacts: Array<{
    path: string;
    kind: "added" | "updated" | "deleted" | "observed";
    summary: string;
    reference: string;
  }>;
  claimedChecks: Array<{
    id: string;
    label: string;
    status: "passed" | "failed" | "not_run";
    detail: string;
    reference: string;
  }>;
  observedFiles: Array<{
    id: string;
    path: string;
    kind: "add" | "update" | "delete";
    status: "completed" | "failed";
  }>;
  observedCommands: Array<{
    id: string;
    command: string;
    status: "completed" | "failed";
    exitCode: number | null;
  }>;
  artifactCandidate: {
    id: string;
    commit: string;
    tree: string | null;
    baseCommit: string | null;
    repositoryId: string | null;
    targetRef: string | null;
    manifestDigest: string | null;
    patchDigest: string | null;
    sealedAt: string | null;
    changedPaths: Array<{
      path: string;
      status: "added" | "modified" | "deleted";
      blob: string | null;
    }>;
  } | null;
  failures: string[];
  unresolved: string[];
  stale: boolean;
}

export interface CodexExchangeEvidenceSurface {
  sourceId: string;
  recordedAt: string;
  requestId: string;
  requestRunId: string;
  requestBriefId: string;
  sourceRevisionId: string;
  artifactBaseRef: string;
  requestedMode: "live" | "replay";
  effectiveMode: "live" | "replay" | null;
  runtimeStatus: string;
  provider: string;
  replayIdentity: string | null;
  responseKind: "success" | "failure";
  disposition: "accepted" | "quarantined";
  issues: string[];
}

export interface CodexNormalizationFailureSurface {
  sourceId: string;
  recordedAt: string;
  requestId: string;
  runId: string;
  briefId: string;
  code: "coherence_rejected" | "state_conflict";
  message: string;
}

export interface EvidenceValidationSurface {
  id: string;
  closureId: string;
  briefId: string;
  baseRevisionId: string;
  evidenceSourceId: string;
  validator: {
    id: string;
    kind: "human" | "system";
    label: string;
  };
  observedAt: string;
  verdict: "verified" | "not_verified" | "stale";
  consumedByRevisionId: string | null;
  verifierExchangeGrounded: boolean;
  requiredPassed: number;
  requiredTotal: number;
  observations: Array<{
    requirementId: string;
    label: string;
    kind: "test" | "artifact" | "review" | "command" | "other";
    required: boolean;
    command: string | null;
    result: "passed" | "failed" | "missing";
    freshness: "current" | "stale";
    evidenceRefs: string[];
    verifierDetail: string | null;
    execution: {
      kind: "fixture_equivalent" | "sandboxed_candidate";
      runnerId: string;
      declaredCommand: string;
      declaredCommandExecuted: boolean;
      passedCount: number | null;
      totalCount: number | null;
      exitCode: number | null;
      termination: "exited" | "timed_out" | "output_limited" | null;
    } | null;
  }>;
  issues: string[];
}

export type ReconciliationSurfaceState =
  | "unavailable"
  | "eligible"
  | "proposing"
  | "candidate"
  | "blocked"
  | "stale"
  | "integrating"
  | "integrated"
  | "failed";

export interface ReconciliationConsequenceSurface {
  id: string;
  operation:
    | "node.add"
    | "node.patch"
    | "node.retire"
    | "relation.add"
    | "relation.patch"
    | "relation.retire";
  targetId: string;
  targetLabel: string;
  summary: string;
  details: string[];
}

export interface ReconciliationGateCheckSurface {
  id:
    | "worldstate-base"
    | "closure-lineage"
    | "artifact-base"
    | "independent-evidence"
    | "integration-policy"
    | "candidate-disposition";
  label: string;
  status: "passed" | "blocked" | "stale" | "consumed";
  detail: string;
  evidenceRefs: string[];
}

export interface ReconciliationCandidateSurface {
  id: string;
  disposition:
    | "pending"
    | "deferred"
    | "rejected"
    | "remanded"
    | "superseded"
    | "accepted";
  baseRevisionId: string;
  closureId: string;
  validationId: string;
  acceptedRevisionId: string | null;
  proposedBy: {
    id: string;
    kind: "human" | "manager" | "agent" | "system";
    label: string;
  };
  visibleConsequence: string;
  consequences: ReconciliationConsequenceSurface[];
  rationale: string[];
  uncertainty: string[];
  alternatives: string[];
  artifactBaseRef: string;
  codexExchangeSourceId: string;
  validationExchangeSourceId: string;
  verificationScope: "registered_fixture_bundle" | "sealed_live_candidate";
  causalExecutionEstablished: boolean;
  causalAuthorshipEstablished: false;
  artifactPromotion: "not_performed";
}

export interface ReconciliationSurface {
  state: ReconciliationSurfaceState;
  candidate: ReconciliationCandidateSurface | null;
  gate: {
    allowed: boolean;
    verified: boolean;
    reasons: string[];
    checks: ReconciliationGateCheckSurface[];
  };
  canPropose: boolean;
  canIntegrate: boolean;
  proposalGateReason: string;
  integrationGateReason: string;
}

export type ArtifactPromotionSurfaceState =
  | "unavailable"
  | "eligible"
  | "proposing"
  | "proposed"
  | "authorized"
  | "authorizing"
  | "promoting"
  | "persisting"
  | "unattested"
  | "promoted"
  | "stale"
  | "failed"
  | "outcome_unknown";

export interface ArtifactPromotionCandidateSurface {
  id: string;
  candidateId: string;
  repositoryId: string;
  targetRef: string;
  expectedBaseCommit: string;
  candidateCommit: string;
  candidateTree: string;
  manifestDigest: string;
  patchDigest: string;
  changedPaths: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  integratedRevisionId: string;
  status: "proposed" | "authorized" | "promoted" | "stale" | "failed" | "outcome_unknown";
  observedTargetCommit: string | null;
  observedAt: string | null;
}

export interface ArtifactPromotionSurface {
  state: ArtifactPromotionSurfaceState;
  candidate: ArtifactPromotionCandidateSurface | null;
  canPropose: boolean;
  canPromote: boolean;
  gateReason: string;
}

export interface WorkSurface {
  state: WorkSurfaceState;
  available: boolean;
  reason: string;
  targetNodeId: string | null;
  targetLabel: string | null;
  brief: AgentBriefSurface | null;
  run: AgentRunSurface | null;
  exchangeEvidence: CodexExchangeEvidenceSurface | null;
  normalizationFailure: CodexNormalizationFailureSurface | null;
  result: AgentResultSurface | null;
  validation: EvidenceValidationSurface | null;
  reconciliation: ReconciliationSurface;
  artifactPromotion: ArtifactPromotionSurface;
  canPrepare: boolean;
  canAuthorize: boolean;
  canRetryDispatch: boolean;
  canValidate: boolean;
  prepareGateReason: string;
  dispatchGateReason: string;
  validationGateReason: string;
  authority: {
    state: "absent" | "prepared" | "granted" | "used";
    label: string;
    detail: string;
  };
  runtime: {
    mode: "replay" | "live" | "unavailable";
    requestedMode: string | null;
    effectiveMode: "replay" | "live" | null;
    status: string;
    provider: string | null;
    replayIdentity: string | null;
    replayKind: "fixture" | "recorded" | null;
    label: string;
  };
  errorCode: string | null;
  errorMessage: string | null;
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
  work: WorkSurface;
}
