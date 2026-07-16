# Contributing

ODEU Worldstate is currently a design scaffold for an early MVP. Contributions are
welcome, but claims should stay proportional to what has actually been implemented and
verified.

## Before proposing a change

1. Read the [architecture](docs/architecture.md),
   [product principles](docs/product-principles.md), and
   [terminology](docs/terminology.md).
2. State the concrete user problem and project scope.
3. Identify whether the change affects objects, evidence, authority, goals, or more
   than one of those lanes.
4. Separate intended behavior from observed implementation behavior.

## Contribution principles

- Prefer concrete, testable project semantics over universal abstractions without an
  immediate use case.
- Preserve provenance and conceptual history when changing the current projection.
- Do not collapse proposed, supported, adopted, completed, verified, and authoritative
  states.
- Keep agent context purpose-bound and least-context by default.
- Keep interpretation, worldstate commit, delegation, and result reconciliation as
  distinct transitions.
- Use familiar interface language without weakening kernel distinctions.
- Treat visual views as projections of one canonical state, not independent stores.
- Mark unimplemented designs and unobserved runtime behavior explicitly.

## Documentation

Public documentation in the repository should describe stable product intent,
implemented behavior, or reproducible evidence. Exploratory notes and working specs
are useful design inputs but are not automatically public source of truth; promote
their settled conclusions deliberately.

When documenting a new interaction, include:

- the source event;
- the proposed interpretation;
- what the human reviews and commits;
- what context and authority an agent receives;
- what evidence comes back;
- what remains unresolved.

## Code changes

The implementation stack and its build commands have not yet been selected. Once code
exists, changes should include focused tests for the affected semantic transitions and
clear instructions for reproducing verification.

Until then, avoid adding framework boilerplate that silently decides architecture or
UX semantics before the relevant contract is written.

## Pull requests

Keep pull requests narrow enough to review as one coherent worldstate or product
change. Describe:

- the problem and intended outcome;
- the files or schemas changed;
- the evidence used;
- authority or privacy implications;
- verification performed;
- remaining uncertainty or follow-up work.

Contributions are made under the repository's license.
