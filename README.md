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
idea, seeing where it fits, accepting it into a durable worldstate, then eventually
delegating bounded work to Codex and receiving the result back in the same conceptual
structure.

> **Project status:** persisted-placement slice. The responsive workbench now wires a
> typed text source through the fixture `/api/placement` boundary, persists the exact
> source and bounded request before dispatch, then the manager exchange and pending
> delta in IndexedDB, and creates one canonical revision only after an explicit human
> semantic commit. Reload reconstructs the same request, receipt, disposition,
> revision, and selection from durable state. Agent dispatch and result reconciliation
> remain visibly unavailable in the workbench; no live model or Codex execution is
> claimed.

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
- Least-context agent briefs that omit private nodes and preserve evidence requirements.
- A deterministic placement fixture plus an opt-in structured-output model gateway.
- A brief-bound Codex fixture replay plus an opt-in live adapter with signed run
  authorization, short-lived run-scoped single use, an authoritative-ledger check and
  persistent claim under one shared per-run guard, an exclusive worktree lease, exact
  revision and clean Git-base checks, isolated configuration, disabled network access,
  and observed SDK evidence kept separate from model claims.
- Validated in-memory and IndexedDB ledger stores with full-ledger-version
  compare-and-swap, immutable-history prefix checks, and an explicit atomic project
  replacement used only by the confirmed sandbox reset.
- A separate Work region that truthfully reports agent execution as unavailable for
  this slice; accepting placement does not compile a brief, create a run, or stage a
  closure.

Still to do for the MVP is wiring agent-brief preview, authorization, worker return,
evidence validation, and result reconciliation into the durable session. The live
placement and guarded-live Codex adapters must then be exercised and validated with
their real providers. Voice capture, correction/defer/reject controls, onboarding,
multi-project routing, and Codex thread resume are not implemented yet.

## Example journey

A person says:

> Have Codex add confidence scoring for exchange-listing dates to my crypto project.

Before changing anything, the system proposes a **Where this fits** receipt: the
project, conceptual location, related goals, dependencies, uncertainty, and possible
alternatives. The persisted-placement slice stops after the person accepts that
update. In the intended next stages, a bounded **Agent brief** can be sent to Codex,
which returns a **Work result** with artifacts and verification evidence for a second
human decision.

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
fixture and exposes no worker dispatch control. The repository also contains fixture
and guarded-live Codex adapter contracts, but they are not wired into this UI slice.
Run the full local verification suite with:

```bash
npm run verify
```

Set `ODEU_MANAGER_MODE=live` only with a server-side `OPENAI_API_KEY`. Live Codex mode
is a local/container integration surface, not a browser toggle: it requires an
authorized kernel run, an exact current revision, an exact Git commit, an isolated
Codex home, a validated current ledger export outside the worker boundary, and normally
a clean linked worktree with no ignored files. The configured ledger path and its
parents cannot be symlinks. The adapter reduces queued run state and creates its
persistent dispatch claim while holding the same per-run guard required by every
pre-dispatch cancellation or status writer, then leases the worktree for the full
execution. A blocked run returns evidence without a closure; its domain state is
resumable, but v0 does not yet implement Codex thread resume. See
[.env.example](.env.example) for the configuration boundary.

## Development provenance

The v0 foundation was scaffolded and verified on 2026-07-16. On 2026-07-17, the
home-move source → placement → semantic-commit path was wired through the browser
ledger and exercised in deterministic fixture mode. The older authored Codex fixture
`home-move-fixture-replay-v0` remains adapter test material; the workbench does not
present it as a run. The live placement path targets GPT-5.6 through the OpenAI
Responses API, but was not exercised without credentials. The guarded live Codex path
was implemented against the Codex SDK, but has likewise not been claimed as an
executed end-to-end run.

Unit, integration, browser-journey, responsive, and automated accessibility checks
cover the implemented foundation. Passing tests establish contract behavior in this
repository; they do not turn fixture evidence or model reports into verified real-world
outcomes.

## License

See [LICENSE](LICENSE).
