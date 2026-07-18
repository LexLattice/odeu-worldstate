# Product principles

These principles govern the MVP. They are normative product intent; current
implementation claims and remaining boundaries are recorded in the README and
architecture.

## 1. Model the concrete world

ODEU is universal as a grammar and local in use. A crypto project needs a concrete
crypto-project worldstate; it does not need an abstract model of everything. New
information enters the active scope only through a relevant relationship.

## 2. The user owns the canonical state

The worldstate is the person's semantic estate. Model providers and worker agents may
receive revocable, purpose-bound projections. They do not become owners of the
canonical representation merely because they helped interpret or act on it.

## 3. Chat is evidence, not the database

A conversation records what was said. The worldstate records what currently exists,
where it belongs, why it exists, what supports it, and how it changed. Chat remains
available as provenance without occupying permanent active context.

## 4. Interpretation precedes mutation

Every meaningful input first produces a visible **Where this fits** proposal. The
person can accept, edit, move, split, defer, or reject it. A plausible interpretation
is not silently promoted into canonical state.

## 5. Preserve conceptual genealogy

Ideas evolve. Refinement, splitting, supersession, challenge, and retirement should
change the current projection without erasing the path by which the project arrived
there.

## 6. Agents receive a brief, not the whole person

Worker context is a least-context projection of a specific goal. It includes relevant
objects, evidence, constraints, allowed actions, artifacts, and expected proof of
completion. Private or unrelated worldstate branches stay outside the run.

## 7. Completion returns evidence, not truth

An agent's **Work result** reports what it changed, checked, observed, and could not
resolve. It becomes evidence for a proposed update. `Completed`, `verified`,
`authoritative`, and `adopted` remain different states.

A returned replay, a worker's claimed check, and an SDK-observed command are all
inspectable evidence with different provenance; none is independent validation by
itself. Validation, reconciliation, and canonical integration require their own
explicit transitions.

The registered fixture replay makes that separation concrete: a trusted system
validator observes separately authored, digest-pinned HTML and its imported support
module, executes fixed vectors against those exact module bytes, then records
requirement-level validation grounded in the exact verifier exchange. This is
independent of worker claims but remains fixture evidence; it does not establish a
live run or causal authorship.

A returned live result has a stronger but still bounded posture: the execution host
must seal and retain a signed Git candidate before releasing the workspace, and a
separate server-owned validator must mount only the registered candidate blobs
read-only and execute a digest-pinned host harness against them. The authored package
command is not executed, and passing requires the harness's exact nonce-bound report.
This may establish causal execution for the sealed candidate—the host harness evaluated
the exact bytes bound to the authorized run—but it does not establish causal model authorship.
Cooperative isolation, SDK observations, and a signed host receipt do not
cryptographically prove which model authored each change.

“Independent” describes that separate transition and harness, not a separate
cryptographic principal; v0 uses symmetric candidate-receipt verification. Promotion
therefore also requires the exact private completed live response and a fresh verifier
run before any external Git operation.

A deterministic reconciliation receipt may bind either exact validation and stage a
pending delta without changing canonical state. Later human acceptance adopts only the
semantic result and still records `artifactPromotion: not_performed`. Artifact
authority is a different possession-based operator boundary: an exact-origin POST with
the transient Bearer may permit the reviewed Git CAS, while the browser human-actor
event remains audit and coordination evidence rather than a server credential.

Before Git, the host must create a signed private intent bound to the exact
SHA-256 authorization prefix, candidate, semantic head, and ledger version, then chain
that intent's digest through its one-shot attempt and terminal status. Authorization
can be retried while only the intent exists. Once an attempt is durable, the external
effect may have happened; an adopter must never repeat the CAS. A crash before the CAS
may therefore stay `outcome_unknown` until an operator reconciles it. The semantic head
is cooperatively reserved while the promotion remains `authorized`; that reservation
ends at terminal `outcome_unknown`, though reset stays blocked to preserve recovery and
audit evidence. A raced create that adopts the winner's attempt is an adopter, never a
second CAS creator. Journal records become visible only after a complete private
same-directory write/fsync/atomic-install/directory-fsync sequence. Exact Git truth is
the raw OID of a direct ref naming a commit, never a symbolic ref or annotated tag that
only peels to it. Only the private journal and Git CAS are security boundaries. No UI
label, semantic revision, worker claim, candidate ref, successful test, or browser
actor can substitute for that server authority chain.

Provider timestamps are evidence claims, not ordering authority for the local domain.
The exact response preserves them; host observation time orders normalized events. If
the response cannot be coherently normalized against the authorized run and current
state, the truthful terminal posture is `outcome_unknown`, not inferred success or
failure.

## 8. Natural anchors over precise semantics

The kernel may be conceptually rich. The default interface uses familiar labels such
as Idea, Goal, Open question, Where this fits, Agent brief, and Work result. Friendly
language must remain a faithful projection over stable types rather than flattening
important distinctions.

## 9. One state, several lawful views

Outline, Map, Timeline, and Focus are perceptual organizations of the same objects.
A view may adapt density, arrangement, disclosure, and salience to a person's current
task or cognitive preference. It may not change meaning, evidence, status, or
permission.

Users choose views rather than receiving fixed personality diagnoses. The same person
may explore in Map, decide in Focus, and audit in Timeline.

## 10. Evidence before commit

Required evidence and uncertainty stay visible or reachable in the same work context
before state commit, destructive action, or delegation. Provisional, challenged,
conflicted, and authoritative material must look materially different.

For returned work, the independent validation, pinned reconciliation receipt, exact
semantic consequences, execution scope, authorship limitation, and artifact-promotion
posture must all remain reachable before `Integrate reviewed result`. For a live
candidate, its base/candidate commits, changed paths, manifest/patch digests, target
ref, and promotion outcome must remain reachable before and after
`Promote reviewed artifact`.

## 11. The interface expresses authority; it does not mint it

Controls render permissions and gates established by the worldstate and policy layer.
Visual prominence, confident narration, or a model recommendation cannot create new
authority.

Preparing reconciliation is therefore a safe proposal action. It cannot mint commit
authority or advance the canonical head. Result integration is a later human-only
`delta.accepted` boundary. Artifact promotion is later still: human review is recorded
for audit, but only possession of operator authority can permit the exact external Git
compare-and-swap. A completed receipt is the host's historical observation at one
time; it must be re-attested on reload and does not claim the ref still has that value.
Reset remains unavailable for an authorized or outcome-unknown promotion and for any
terminal browser claim whose exact receipt has not been re-attested. Replacing the
shared document clears ephemeral receipt attestation and requires a fresh status read.

## 12. Onboarding can be a real semantic demonstration

The intended guided tour uses the application's typed actions: select a project,
stage a placement, change view, accept a delta, compile a brief, dispatch a worker,
and reconcile a result. It should not fake capability with a decorative cursor.

The tour begins in a temporary or watch-only state, explains each boundary, and does
not write to the person's canonical worldstate or contact an agent without explicit
approval. Narration, captions, pacing, mute, reduced motion, and skip controls are
first-class accessibility needs.

## 13. Truthful surfaces over theatrical certainty

Motion and visual hierarchy should explain state change, focus, evidence, and
authority. They must not perform confidence the system has not earned. Unknown is not
empty, validated is not authoritative, and a polished graph is not proof that its
claims are true.
