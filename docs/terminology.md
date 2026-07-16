# Terminology

The interface should use natural anchors while the kernel preserves precise meaning.
Names in the “kernel concept” column describe the intended semantic contract; concrete
schema names may evolve during implementation.

## Core objects

| Interface label | Kernel concept | Meaning |
| --- | --- | --- |
| Worldstate | Canonical scoped state | What a person currently accepts as the structured state of a world at a revision |
| Worldmodel | Worldstate history and transition model | The evolving account of a world, including prior states, relations, evidence, and change |
| Project | Project scope | A concrete world organized around an end goal, artifacts, constraints, and work |
| Goal | Utility target | A desired state with priorities and, where possible, completion criteria |
| Idea | Provisional concept | A proposed object, relation, mechanism, or direction that has not been collapsed into fact |
| Decision | Adopted choice | A selected direction with scope, rationale, and provenance |
| Constraint | Deontic or operational bound | Something required, forbidden, restricted, or otherwise limiting valid action |
| Open question | Unresolved branch | A distinction the current evidence or policy cannot yet settle |
| Task | Work obligation | A bounded unit of intended work related to a goal |
| Artifact | Addressable work object | A file, document, source record, commit, test result, or other inspectable object |
| Evidence | Epistemic support or challenge | Material that supports, challenges, or leaves a claim unresolved |
| Agent run | Scoped execution episode | One bounded worker invocation under a declared brief and authority boundary |

## Transitions and receipts

| Interface label | Kernel concept | Meaning |
| --- | --- | --- |
| Suggested update | Worldstate delta proposal | A non-canonical candidate change to objects, relations, statuses, or scope |
| Where this fits | Placement receipt | A reviewable account of proposed location, relations, rationale, uncertainty, and alternatives |
| Add to my worldstate | Delta commit | Human acceptance of a bounded proposal into canonical state |
| Agent brief | Scoped runtime projection | The least-context goal, evidence, constraints, artifacts, permissions, and return contract given to a worker |
| Ask Codex to work | Delegation transition | A separate authorization step that starts a worker run from an accepted brief |
| Work result | Closure witness | Artifacts, checks, observations, effects, and unresolved issues returned by a worker |
| Integrate result | Reconciliation commit | Human acceptance of a result-derived update after evidence review |
| Where this came from | Provenance binding | The source events and artifacts from which an interpretation or claim arose |
| How this evolved | Conceptual genealogy | Refinement, split, challenge, supersession, retirement, and other historical relations |

## Natural ODEU anchors

The ODEU terminology belongs in the kernel and technical inspector. The normal
interface can use four familiar questions:

| Lane | Natural anchor | Tracks |
| --- | --- | --- |
| O | Things and connections | Objects, types, roles, states, relations, scopes |
| E | What we know | Sources, observations, evidence, inference, uncertainty, freshness |
| D | Rules and permissions | Ownership, obligations, constraints, authority, gates, delegation |
| U | Goals and priorities | Desired outcomes, rankings, tradeoffs, risks, completion criteria |

## Independent status families

No single `status` field can truthfully represent knowledge, governance, and work.

| Family | Friendly states | Question answered |
| --- | --- | --- |
| Knowledge | Draft, Supported, Challenged, Open, Out of date | How well do we know this? |
| Governance | Suggested, Adopted, Restricted, Approval needed | What standing does this have, and who may act? |
| Work | Planned, Running, Blocked, Completed, Verified | What is happening operationally? |

An item may therefore be both `Adopted` and `Challenged`, or an agent run may be
`Completed` while its output remains unverified.

## Views

| View | Best for | Preserves |
| --- | --- | --- |
| Outline | Hierarchy and verbal scanning | The same object identities and relations |
| Map | Neighborhoods, dependencies, and conflicts | The same statuses, provenance, and authority |
| Timeline | Genesis, revision, and work history | The same current-state distinction from historical state |
| Focus | One update or decision with lower cognitive load | The same evidence and commit gate through progressive disclosure |

A **Morphic view** is a lawful projection of canonical state. It may change spatial and
informational ergonomics, but it is not a separate store and cannot reinterpret the
world merely by changing presentation.
