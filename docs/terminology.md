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
| Adopt this placement | Delta commit | Human acceptance of a bounded proposal into canonical state |
| Agent brief | Scoped runtime projection | The least-context goal, evidence, constraints, artifacts, permissions, and return contract given to a worker |
| Ask Codex to work | Delegation transition | A separate authorization step that starts a worker run from an accepted brief |
| Work result | Closure witness | Artifacts, checks, observations, effects, and unresolved issues returned by a worker |
| Sealed artifact candidate | Signed retained Git candidate | A content-addressed, non-authoritative commit and receipt created from a returned live workspace while its execution lease is still held; the receipt binds exact lineage, manifest, patch, and intended target ref |
| Outcome unknown | Ambiguous-observation terminal | A dispatched run has no trustworthy terminal outcome because no valid response was observed or a retained response could not be normalized against the authorized run and current state; no closure is inferred |
| Independent validation | Evidence validation | A separate human or trusted-system observation of the brief's evidence requirements, grounded in an integrity-bound source and distinct from worker claims, reconciliation, and canonical commit |
| Causal execution established | Exact-candidate execution posture | The immutable host-owned harness evaluated the registered artifact/support bytes from the exact sealed candidate against fixed vectors; candidate-owned packages/scripts did not execute, and this posture does not identify who authored the changes |
| Causal model authorship | Authorship attribution claim | A stronger claim that a particular model caused the candidate changes; the current signed candidate, SDK evidence, isolation, and validation boundary deliberately do not establish it |
| Reconciliation proposal | Validation-pinned reconciliation delta | A provisional result-derived update bound to one exact `validationRef`, closure, brief, run, worldstate revision, artifact base, and evidence lineage |
| Prepare reconciliation | Reconciliation receipt transition | Atomically persist an integrity-bound receipt and its exact pending delta without changing canonical state |
| Integrate reviewed result | Reconciliation commit | A separate human-only `delta.accepted` transition that creates one semantic revision after revision, evidence, lineage, disposition, and artifact-base checks; it does not promote files |
| Promote reviewed artifact | Artifact-promotion handoff | A separate reviewed action after exact live validation and integration; the browser human event records audit/coordination, while possession of the transient operator Bearer authorizes the server POST |
| Promotion authority intent | Private authorization-prefix commitment | A signed, create-only host record binding the promotion/candidate, semantic head, ledger version, authorization event, and SHA-256 digest of the exact ledger prefix before Git is attempted |
| Promotion attempt | One-shot external-effect claim | A signed, atomically published create-only claim chained to the authority-intent digest; its creator may attempt the CAS once, while every adopter—including the loser of a raced create—must only recover and never issue another CAS |
| Artifact promotion | External Git authority boundary | One compare-and-swap that advances the configured raw direct ref OID from the exact reviewed base commit to the exact reviewed candidate commit; symbolic refs and annotated tags that merely peel to a commit are not exact, and the private journal plus Git CAS—not the browser actor event—form the security boundary |
| Promotion outcome unknown | Ambiguous external-write terminal | A durable attempt exists but its Git outcome cannot be established safely, including an adopted attempt observed back at the base or an unobservable ref; no second CAS is permitted, the semantic-head reservation ends, reset remains blocked, and operator reconciliation may be required |
| Promotion receipt | Historical host observation | A signed terminal record chained to the authority intent and attempt; reload or shared-document replacement must re-attest it, an unattested terminal claim cannot release sandbox reset, and it does not prove the target ref still has the observed value |
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
| Work | Planned, Running, Blocked, Completed, Outcome unknown, Verified | What is happening operationally? |

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
