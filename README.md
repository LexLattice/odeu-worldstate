# ODEU Worldstate

**Worldstate-mediated, agent-assisted work for ordinary people.**

ODEU Worldstate is an early-stage project for turning everyday conversation into a
user-owned, structured account of projects, ideas, goals, decisions, evidence, and
work. It is intended to give a person and their AI systems the same explicit ground
truth without making a chat transcript the permanent context.

The core loop is:

```text
conversation or voice input
  -> proposed placement in the current worldstate
  -> human review and acceptance
  -> scoped brief for an agent
  -> evidence-backed work result
  -> proposed worldstate revision
```

The first build target is deliberately narrow: demonstrate one person capturing an
idea, seeing where it fits, accepting it into a durable worldstate, delegating a
bounded replay or live brief, independently validating the exact returned evidence,
reconciling the semantic result, and separately deciding whether a reviewed artifact
candidate becomes authoritative.

> **Project status:** durable live-candidate and artifact-promotion boundary. The
> fixture replay remains the safe default and truthful fallback. When the server-side
> live runtime is configured, the browser obtains a short-lived signed authorization
> derived from the current ledger, persists the exact signed attempt before dispatch,
> and never substitutes replay for a requested live run. A returned live result is
> lawful only when the execution host seals the worktree changes before releasing its
> lease, retains the resulting Git commit under a candidate ref, and signs a receipt
> binding the run, brief, worldstate revision, base commit, target ref, manifest, and
> binary patch. The candidate is staged evidence, not an authoritative artifact.
> Independent validation verifies that exact receipt and candidate, mounts only the
> registered artifact and support blobs read-only, and runs a digest-pinned,
> server-owned harness in a bounded no-network sandbox. The authored
> `npm test -- moving-cost` remains a requirement label; candidate package scripts are
> not executed, and exit zero alone cannot pass. Reconciliation may then record
> `verificationScope: sealed_live_candidate` and
> `causalExecutionEstablished: true`, but it still records
> `causalAuthorshipEstablished: false` and `artifactPromotion: not_performed`.
> Semantic integration changes the worldstate only. A later exact-origin POST with a
> transient operator Bearer may advance the configured Git target ref from the exact
> reviewed base commit to the exact candidate commit with one compare-and-swap. Git
> ref truth is the raw OID of a direct ref whose object is a commit; a symbolic ref or
> annotated tag that merely peels to that commit is never accepted as exact. Bearer
> possession is the server authority; the browser's human-actor event records review
> and coordination but is not a security credential. Before Git is attempted, the host
> persists a signed, create-only private intent bound to the candidate, semantic head,
> ledger version, and SHA-256 digest of the exact authorization prefix. Its digest is
> chained through the attempt and terminal status. Each create-only journal record is
> fully written and fsynced in the private directory before atomic installation and a
> directory fsync. Durable status supports recovery without blindly repeating a
> possibly completed promotion.

## Why a worldstate?

Chats are useful event streams, but poor long-term maps. Important ideas become
distributed across conversations and must repeatedly be reconstructed by both the
person and the model.

ODEU Worldstate treats a conversation as evidence that may induce a structured
update. Once reviewed, that update becomes part of a concrete project worldstate and
can be reused without permanently carrying the original transcript in active context.
The transcript remains inspectable as provenance.

## Implemented foundation

- An append-only, revisioned kernel with deterministic reduction, typed objects and
  relations, conceptual genealogy, compensation, and idempotent commands.
- A browser session transaction layer that seeds once, validates event batches locally,
  and publishes each operation with one full-ledger compare-and-swap.
- Typed source capture, an integrity-checked attempt artifact persisted before the real
  same-origin placement request, and durable retention of the exact request/response
  exchange as evidence rather than canonical truth.
- A visible placement receipt and explicit semantic commit boundary; persistence,
  clarification, failure, stale-base, and conflict states fail closed.
- Outline, Map, Timeline, and Focus projections derived from the reduced ledger, with
  shared identity, persisted selection, provisional candidate overlays, and
  deterministic projection-only graph layout.
- A consent-first opening guide with `Interactive`, `Watch only`, and `Skip` modes,
  pause/resume, caption visibility, and replay. Watch-only guidance uses typed,
  presentation-only project, view, and object-selection commands; the chapter stops
  at the source-capture handoff without adding a canonical event, advancing a
  revision, calling a provider, or granting agent authority.
- A separate guided source-placement chapter that first establishes `Budget` as the
  exact working context, then enables only user-invoked capture and exact-source retry.
  It persists the source, request/attempt with its exact selected context, Manager
  exchange/receipt, and pending delta, keeps the canonical head unchanged, and hands
  off a frozen reviewable receipt. Semantic adoption, reset, and every agent or
  promotion action remain locked within that chapter.
- A separate guided semantic-adoption chapter that preserves the exact provisional
  candidate through Outline, Map, Timeline, and Focus before changing the Workbench to
  `guided-adoption`. Only the person's exact semantic commit is then available. One
  accepted revision is observed and frozen into the handoff while capture, retry,
  reset, brief preparation, dispatch, validation, reconciliation, integration, and
  promotion remain locked until the guide is explicitly closed.
- A durable, least-context browser brief preview compiled from the latest accepted
  Task, with shared context, local private/out-of-scope omission receipts, immutable
  revision and artifact bindings, authority limits, unknowns, and evidence requirements.
- A deterministic placement fixture plus an opt-in structured-output model gateway.
- A brief-bound Codex fixture replay plus an opt-in live adapter with signed run
  authorization, short-lived run-scoped single use, an authoritative-ledger check and
  persistent claim under one shared per-run guard, an exclusive worktree lease, exact
  revision and clean Git-base checks, isolated configuration, disabled network access,
  and observed SDK evidence kept separate from model claims.
- Validated in-memory and IndexedDB ledger stores with full-ledger-version
  compare-and-swap, immutable-history prefix checks, and an explicit atomic project
  replacement used only by the confirmed sandbox reset.
- A separate Work region with a durable preview boundary, one-run replay/live
  authority, normalized worker observation, exact claim-versus-SDK-observation
  inspection, sealed-candidate evidence, independent validation, a provisional
  reconciliation receipt, and physically separate human semantic-integration and
  reviewed operator artifact-promotion boundaries.
- A fixed replay-evidence registry keyed by replay identity and semantic brief digest,
  with SHA-256-pinned `demo/moving-costs.html` and its imported
  `demo/moving-costs.mjs`, fixed vectors executed against that exact support module,
  exact durable verifier attempt/response artifacts, and a kernel validation grounded
  in their integrity-bound system source. The kernel recomputes the semantic source
  fingerprint from its content instead of trusting integrity metadata alone. The
  declared npm command is shown truthfully; the request path runs a bounded
  `fixture_equivalent` checker rather than executing browser-supplied commands.
- Failure and recovery behavior for an unobserved gateway outcome, a schema-valid but
  incoherent response, interrupted reload after a durable attempt, and a concurrent
  normalization CAS conflict. Invalid transport bodies retain bounded metadata, a
  capped excerpt, truncation posture, and a full-body digest without rendering the
  excerpt in the general timeline. Exact response evidence survives independently;
  reload resumes an interrupted normalization, and repeated CAS recovery retains the
  response without duplicate dispatch.
- A deterministic reconciliation compiler that binds the active Task, closure, run,
  brief, exact validation, worldstate revision, artifact base, Codex exchange, and
  verifier exchange. It atomically persists an integrity-bound receipt plus pending
  reconciliation delta with no canonical mutation. The kernel gates that delta on its
  pinned `validationRef`, rejects stale or artifact-drifted acceptance, and permits
  reconciliation `delta.accepted` only from an explicit human actor.
- A server-minted live authorization handoff that validates the current ledger and
  exact Git base before issuing a short-lived, single-use capability. The exact signed
  request is durable before live dispatch. A completed private response is recovered
  without redispatch; only an exact request proven `not_started` may be explicitly
  retried without a new authority event.
- A live return contract that requires a signed, content-addressed Git candidate for
  every returned result. The retained candidate receipt binds the base and candidate
  commits/trees, changed-path manifest, binary-patch digest, repository identity, and
  intended target ref without making that target authoritative.
- An independent live-candidate verifier that rejects replay evidence, verifies the
  signed candidate and recomputed Git objects, materializes only two registered Git
  blobs, and evaluates fixed vectors through a nonce- and digest-bound host harness.
  Its durable evidence records the harness pin, support blob, cases, and truthful
  per-process isolation limits.
- A separate artifact-promotion contract. It becomes eligible only after exact live
  validation and human semantic integration, persists proposal/request/response
  evidence, requires the exact private completed live response, freshly reruns the
  host verifier, and permits only an operator-authorized compare-and-swap in a
  dedicated bare repository. The browser reserves the semantic head only while the
  promotion is `authorized`, coordinating cooperating sessions; the signed private
  journal and Git CAS form the server security boundary. Stale, failed, and terminal
  `outcome_unknown` remain distinct from promoted.

The implementation and deterministic adapter evidence for this boundary are verified,
including real temporary Git repositories and target-ref compare-and-swap behavior.
A real external Codex turn has also been observed through the opt-in local-session
diagnostic using the project-bundled CLI and an existing ChatGPT login. That smoke
proves only ephemeral CLI connectivity and independently checked disposable artifact
creation. It is not an authorized ODEU run and cannot produce closure, candidate,
reconciliation, or promotion evidence. The application's provider-key-backed live
route and live placement remain unobserved because neither `OPENAI_API_KEY` nor
`CODEX_API_KEY` is configured. Remaining product work includes that end-to-end live
route evidence, the later agent-brief-through-reconciliation onboarding
chapters, voice capture, correction/defer/reject controls, multi-project routing, and
Codex thread resume.

## Example journey

A person says:

> Have Codex add confidence scoring for exchange-listing dates to my crypto project.

Before changing anything, the system proposes a **Where this fits** receipt: the
project, conceptual location, related goals, dependencies, uncertainty, and possible
alternatives. After the person accepts that update, they can persist and inspect a
bounded **Agent brief**, then separately authorize the displayed replay or live run. A
live return exposes its exact sealed Git candidate as staged evidence. **Run independent
validation** checks either the registered replay bundle or that exact live candidate.
**Prepare reconciliation** saves a reviewable, revision-compatible semantic candidate
without changing the head. **Integrate reviewed result** creates the next canonical
worldstate revision but still does not move a file or branch. Only the later **Promote
reviewed artifact** boundary may, after human review and with transient operator Bearer
authority, advance the configured target ref to the exact reviewed candidate commit.

## Design commitments

- The individual is the owner and disposer of their canonical worldstate.
- Models propose interpretations; they do not silently promote them into truth.
- Agents receive scoped projections, not ambient access to the full private graph.
- Agent completion is distinct from verified project success.
- Friendly interface language is a projection over precise kernel semantics.
- Every view may change presentation, never object identity, meaning, evidence, or
  authority.

## Documentation

- [Architecture](docs/architecture.md)
- [Product principles](docs/product-principles.md)
- [Terminology](docs/terminology.md)
- [Contributing](CONTRIBUTING.md)

## Run locally

Use Node.js 24 and npm 11:

```bash
npm ci
cp .env.example .env
npm run dev
```

The defaults are deliberately safe: the workbench calls the deterministic placement
fixture and exposes a separate one-run fixture replay after a durable brief preview.
Replay never masquerades as live execution and cannot enter the live artifact-promotion
path.
Run the full local verification suite with:

```bash
npm run verify
```

To provision and prove the private local prerequisites for the application-backed
live journey without reading a provider credential or making a provider call, run:

```bash
npm run smoke:application:live
```

The create-only default writes a private disposable Git runtime under
`.working/application-live/runtime-v1`, publishes redacted readiness evidence at
`.working/evidence/application-live-readiness-v1.json`, and exits successfully with
`OPENAI_API_KEY` as the sole missing configuration. Its placeholder ledger is not a
manual input: the existing live-authorization request atomically replaces it with the
exact browser ledger before dispatch. Source the generated private
`application-live.env`, then export `OPENAI_API_KEY` separately in process memory;
that API key is the sole externally supplied application configuration. Start the
application only when ready to perform the separately authorized manual journey and
open exactly `http://localhost:3000`. Because the browser cannot read the server
process environment, copy the generated `ODEU_OPERATOR_BEARER_SECRET` value into the
workbench's **Transient operator authority** field when prompted. This generated
bearer is a separate manual authority handoff: do not place it in a URL, browser
storage, or shell history. To re-prove provider-capable readiness (still without
starting the app or making a provider call), use a fresh runtime and evidence
destination:

```bash
npm run smoke:application:live -- \
  --mode provider-capable \
  --allow-provider-capable-readiness \
  --runtime-root .working/application-live/runtime-v2 \
  --evidence-file .working/evidence/application-live-readiness-v2.json
```

CI additionally requires `--allow-ci-provider-capable-readiness`. The provisioner
never overwrites a runtime or evidence file, never persists the provider credential,
and its output grants no run, closure, candidate, reconciliation, or promotion
authority.

To separately check real Codex connectivity with an existing local ChatGPT login, run
the explicitly gated diagnostic:

```bash
npm run smoke:codex:local-session -- \
  --allow-live-provider-call \
  --evidence-file .working/evidence/local-codex-session-smoke.json
```

This command makes a real external call on Linux, WSL, or macOS. It runs the
project-bundled Codex CLI in an ephemeral, disposable, no-worker-network workspace;
requires one ordered, usage-bearing turn with a successful in-turn local tool event;
independently checks the one declared artifact and rejects unexpected final workspace
entries; terminates the bounded process group; removes the workspace; and publishes
only redacted diagnostic evidence with no ODEU authority. It records the installed
launcher, native executable, and harness source digests alongside matching lockfile
metadata, but does not claim the installed bytes were reverified from package-integrity
metadata. It refuses to run without the
explicit flag, refuses an existing evidence destination, and requires the additional
`--allow-ci-live-provider-call` flag under CI. It does not exercise the application's
signed live route or replace its provider-key requirement. The Codex sandbox is
configured to restrict writes to the disposable workspace, but its read sandbox is not
workspace-confined; the diagnostic therefore strips the worker shell environment and
must still be treated as a trusted-local-machine check rather than a confidential
read-isolation boundary. Before inspecting effects, the harness repeatedly kills and
waits for the inherited POSIX process group to disappear, then reads artifacts through
no-follow descriptors. A process that deliberately escapes that group (for example by
creating a new session) is not cgroup-contained or proven absent, so the evidence does
not claim process-tree containment or a race-free workspace snapshot.

Set `ODEU_MANAGER_MODE=live` only with a server-side `OPENAI_API_KEY`. Live Codex mode
uses `ODEU_CODEX_MODE=live` and a server-side `OPENAI_API_KEY` or `CODEX_API_KEY`. It
also requires a clean Git workspace, isolated Codex home, private ledger/authority
store, run-authorization secret, repository and target-ref identity, retained-candidate
store, distinct artifact-signing key, server-registered live-evidence repository, and
durable promotion-status store. Live authority/evidence/promotion routes additionally
require `ODEU_OPERATOR_BEARER_SECRET` (at least 32 bytes) and an exact
`ODEU_OPERATOR_ALLOWED_ORIGIN`. Use HTTPS except for an exact loopback development
origin; privileged browser routes also require
`Sec-Fetch-Site: same-origin`. Authorization is checked before bodies or private state
are read and before code execution or ref mutation. The Bearer is possession-based
operator authority, not proof of a person's identity. The browser sends it only in the
`Authorization` header from an in-memory provider—never local storage, a request body,
or a query string.
Repository/toolchain paths and all other secrets remain on the server; they are never
accepted from the browser or placed in worker context.
`ODEU_CODEX_PROMOTION_REPOSITORY` must be the exact, symlink-free root of a dedicated
bare repository, and the configured target branch must not be checked out in a linked
worktree. A repository-wide ODEU lock serializes cooperating promotion processes;
Git's expected-old-value CAS still protects against external writers. Promotion
authority, attempt, and status files require a native private POSIX journal with strict
ownership/mode checks and no symlink components; descriptor-anchored journal I/O
currently assumes Linux `/proc`. Complete records are written and fsynced to a private
same-directory temporary file, atomically installed without replacement, and followed
by a directory fsync; readers never adopt a partially filled final record. Retain old
artifact verification keys for as long as their durable receipts may be recovered. An
adopted attempt is never executed again, including one adopted after a raced create: a
crash after the attempt is durable but before its CAS can therefore become terminal
`outcome_unknown` and require operator reconciliation. Stale repository guards or
locks likewise require reconciliation rather than deletion and retry. Sandbox reset is
blocked while a promotion is `authorized` or `outcome_unknown`; a terminal browser
claim (`promoted`, `stale`, or `failed`) also blocks reset until the read-only status
boundary re-attests its exact receipt. External/shared document replacement clears
ephemeral receipt attestation and status must reacquire it. Reset never reverses Git. A
completed receipt is a historical host observation, not proof of the target ref's
current value. See
[.env.example](.env.example) for the complete variable names and safe
defaults. A blocked run returns evidence without a closure; Codex thread resume remains
deferred.

## Development provenance

The v0 foundation was scaffolded and verified on 2026-07-16. On 2026-07-17, the
home-move source → placement → semantic-commit path was wired through the browser
ledger and exercised in deterministic fixture mode. The same browser session now
presents `home-move-fixture-replay-v0` truthfully as a replay after a separately
persisted brief and one-run authorization. Its independent validator verifies
separately authored, digest-pinned HTML and the exact support module imported by that
HTML, then executes fixed vectors against the module; this is fixture verification,
not a fresh Codex execution or proof of the worker's causal authorship. On 2026-07-18,
the browser path added an integrity-bound reconciliation receipt, an exact
validation-pinned pending delta, and a separate human-only integration commit. That
commit updates semantic worldstate and provenance; it does not promote files or turn
fixture evidence into causal worker proof.
The 2026-07-18 live-candidate boundary added the server-minted browser/host authority
handoff, mandatory signed candidate sealing, independent exact-candidate execution,
live reconciliation with causal-execution/no-causal-authorship posture, and separate
reviewed operator target-ref CAS promotion. Its deterministic evidence includes exact
authorization-prefix binding, the intent/attempt/status chain, and adoption without a
second CAS. Contract, route, session, and deterministic Git-adapter evidence exercise
those boundaries. The live placement path targets GPT-5.6 through
the OpenAI Responses API and the live worker uses the Codex SDK. The separate
local-session diagnostic successfully observed one real project-bundled Codex CLI turn
through the existing ChatGPT login on 2026-07-18, including a successful tool-backed
turn and an artifact whose exact bytes and final workspace contract were host-verified.
The event stream does not establish which tool causally created that artifact. No
provider-key-backed application live run has been observed because `OPENAI_API_KEY`
and `CODEX_API_KEY` remain absent; the diagnostic creates no application authority or
durable run lineage. On 2026-07-19, onboarding was extended with a separate guided
source-placement chapter: it establishes Budget context, permits only human capture or
exact-source retry, persists a provisional receipt and its exact lineage, and freezes
that reviewable handoff while the canonical revision stays unchanged and all later
authority gates remain closed. On 2026-07-20, a third controller added the first
semantic authority chapter. It proves the same provisional candidate across all four
projections, permits only the exact human placement acceptance, observes one new
canonical revision, and stops before brief preparation or agent authority.

Unit, integration, browser-journey, responsive, and automated accessibility checks
cover the implemented foundation. Passing tests establish contract behavior in this
repository; they do not turn fixture evidence or model reports into verified real-world
outcomes.

## License

See [LICENSE](LICENSE).
