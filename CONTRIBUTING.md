# Contributing

ODEU Worldstate currently has a tested v0 foundation and an incomplete end-to-end MVP.
Contributions are welcome, but claims should stay proportional to what has actually
been implemented and verified.

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

Use Node.js 24 and npm 11. Install the locked dependency graph with `npm ci`, run local
development with `npm run dev`, and verify the full foundation with `npm run verify`.
Changes should include focused tests for affected semantic transitions and clear
instructions for reproducing any additional verification.

Keep runtime validation and TypeScript contracts aligned. Framework or renderer
mechanics may not silently decide worldstate meaning, authority, evidence posture, or
UX semantics outside the relevant contract.

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
