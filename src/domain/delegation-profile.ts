/**
 * Host-registered delegation profiles. A placement manager may propose one of
 * these identifiers, but the proposal is not execution authority and it cannot
 * mint a new executable profile with prose.
 */
export const MOVING_COST_DELEGATION_PROFILE_ID =
  "moving-cost-contract-v1" as const;

export const MOVING_COST_DELEGATION_ALLOWED_CHANGE_PATHS = Object.freeze([
  "demo/moving-costs.html",
  "demo/moving-costs.mjs",
] as const);

const MOVING_COST_DELEGATION_DONE_MEANS = Object.freeze([
  "A user can enter at least two provider quotes and compare totals.",
  "Focused tests for total calculation pass.",
  "The planning page imports one repo-local moving-cost support module that exports calculateMovingTotalCents for independent fixed-vector verification.",
] as const);

const MOVING_COST_DELEGATION_CONSTRAINTS = Object.freeze([
  "demo/moving-costs.html must import ./moving-costs.mjs exactly once, and demo/moving-costs.mjs must export calculateMovingTotalCents for independent fixed-vector verification.",
] as const);

const MOVING_COST_DELEGATION_ALLOWED_ACTIONS = Object.freeze([
  "Read files inside the disposable demo workspace",
  "Edit only demo/moving-costs.html and demo/moving-costs.mjs",
  "Run the declared focused test command",
] as const);

const MOVING_COST_DELEGATION_EVIDENCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: "requirement-focused-tests",
    label: "Focused moving-cost calculation tests pass",
    kind: "test" as const,
    command: "npm test -- moving-cost",
    required: true,
  }),
  Object.freeze({
    id: "requirement-artifact-change",
    label: "The planning-page artifact change is addressable",
    kind: "artifact" as const,
    command: null,
    required: true,
  }),
] as const);

export const REGISTERED_DELEGATION_PROFILE_IDS = [
  MOVING_COST_DELEGATION_PROFILE_ID,
] as const;

export type DelegationProfileId =
  (typeof REGISTERED_DELEGATION_PROFILE_IDS)[number];

export interface RegisteredDelegationProfile {
  readonly id: DelegationProfileId;
  readonly expectedProjectId: string;
  readonly expectedAncestorId: string;
  readonly expectedGoalId: string;
  readonly expectedArtifactId: string;
  readonly allowedChangePaths: readonly string[];
  readonly goal: string;
  readonly doneMeans: readonly string[];
  readonly constraints: readonly string[];
  readonly expectedArtifacts: readonly string[];
  readonly environment: string;
  readonly agentProfile: string;
  readonly allowedActions: readonly string[];
  readonly deniedActions: readonly string[];
  readonly confirmationRequired: readonly string[];
  readonly evidenceContract: {
    readonly requirements: readonly {
      readonly id: string;
      readonly label: string;
      readonly kind: "test" | "artifact" | "review" | "command" | "other";
      readonly command: string | null;
      readonly required: boolean;
    }[];
    readonly policy: { readonly blockIntegration: boolean };
  };
  readonly escalationPath: string;
}

export const MOVING_COST_DELEGATION_PROFILE = Object.freeze({
  id: MOVING_COST_DELEGATION_PROFILE_ID,
  expectedProjectId: "node-project-home-move",
  expectedAncestorId: "node-area-budget",
  expectedGoalId: "node-goal-under-4000",
  expectedArtifactId: "node-artifact-planning-page",
  allowedChangePaths: MOVING_COST_DELEGATION_ALLOWED_CHANGE_PATHS,
  goal: "Add a simple moving-cost comparison tool to the demo planning page.",
  doneMeans: MOVING_COST_DELEGATION_DONE_MEANS,
  constraints: MOVING_COST_DELEGATION_CONSTRAINTS,
  expectedArtifacts: Object.freeze(["demo/moving-costs.html"] as const),
  environment: "Disposable local demo workspace",
  agentProfile: "Codex, repository-local implementation",
  allowedActions: MOVING_COST_DELEGATION_ALLOWED_ACTIONS,
  deniedActions: Object.freeze([
    "Publish externally",
    "Read omitted worldstate context",
  ] as const),
  confirmationRequired: Object.freeze([
    "Any action outside the disposable workspace",
  ] as const),
  evidenceContract: Object.freeze({
    requirements: MOVING_COST_DELEGATION_EVIDENCE_REQUIREMENTS,
    policy: Object.freeze({ blockIntegration: true }),
  }),
  escalationPath:
    "Return blocked with the exact missing authorization or information.",
}) satisfies RegisteredDelegationProfile;

export const REGISTERED_DELEGATION_PROFILES: Readonly<
  Record<DelegationProfileId, RegisteredDelegationProfile>
> = Object.freeze({
  [MOVING_COST_DELEGATION_PROFILE_ID]: MOVING_COST_DELEGATION_PROFILE,
});

export function registeredDelegationProfile(
  profileId: DelegationProfileId,
): RegisteredDelegationProfile {
  return REGISTERED_DELEGATION_PROFILES[profileId];
}

/**
 * Returns candidate paths outside the host-owned profile envelope. The brief's
 * prose and expected-artifact list cannot broaden this registered authority.
 */
export function unexpectedDelegationProfileChangePaths(
  profileId: DelegationProfileId | null,
  changedPaths: Iterable<string>,
): readonly string[] {
  const allowed = new Set(
    profileId === null
      ? []
      : registeredDelegationProfile(profileId).allowedChangePaths,
  );
  const unexpected = new Set<string>();
  for (const path of changedPaths) {
    if (!allowed.has(path)) unexpected.add(path);
  }
  return [...unexpected].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}
