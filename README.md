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
idea, seeing where it fits, delegating bounded work to Codex, and receiving the result
back in the same conceptual structure.

> **Project status:** pre-implementation design scaffold. The documents in this
> repository describe intended behavior; they do not claim that a working runtime or
> interface exists yet.

## Why a worldstate?

Chats are useful event streams, but poor long-term maps. Important ideas become
distributed across conversations and must repeatedly be reconstructed by both the
person and the model.

ODEU Worldstate treats a conversation as evidence that may induce a structured
update. Once reviewed, that update becomes part of a concrete project worldstate and
can be reused without permanently carrying the original transcript in active context.
The transcript remains inspectable as provenance.

## Intended MVP

- A hierarchical worldstate for a small number of real projects.
- Text or voice capture of a new idea.
- GPT-5.6-assisted placement that proposes where the idea fits, what it relates to,
  and what remains uncertain.
- A visible review boundary before the proposed update becomes canonical state.
- Outline, Map, Timeline, and Focus views over the same underlying objects.
- A least-context agent brief generated from a selected project slice.
- One real Codex work loop whose artifacts, checks, and unresolved questions return as
  evidence rather than automatic truth.
- Conceptual genealogy: ideas may be refined, split, superseded, challenged, or
  retired without losing where they came from.

## Example journey

A person says:

> Have Codex add confidence scoring for exchange-listing dates to my crypto project.

Before changing anything, the system proposes a **Where this fits** receipt: the
project, conceptual location, related goals, dependencies, uncertainty, and possible
alternatives. After the person accepts the update, a bounded **Agent brief** can be
sent to Codex. Codex returns a **Work result** with artifacts and verification
evidence. The person then decides whether and how that result updates the worldstate.

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

## Development provenance

The runtime contribution of GPT-5.6 and Codex described above is an intended MVP
contract, not yet an implementation claim. As the project is built, this section will
be expanded with dated build provenance, the implemented feature boundary, and
verification instructions.

## License

See [LICENSE](LICENSE).
