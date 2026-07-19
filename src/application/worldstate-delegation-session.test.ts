import { describe, expect, it, vi } from "vitest";

import { runCodexReplay } from "@/adapters/codex/replay";
import { BrowserAgentGatewayError } from "@/adapters/codex/browser";
import {
  HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
  HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
  HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF,
  HOME_MOVE_REPLAY_ARTIFACT_PATH,
  HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
  HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
  HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
  HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS,
  HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
  HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
  HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
  HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
  HOME_MOVE_REPLAY_IDENTITY,
  HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX,
  ReplayEvidenceResponseSchema,
  type ReplayEvidenceRequest,
  type ReplayEvidenceResponse,
} from "@/adapters/replay-evidence";
import {
  AgentRunResponseSchema,
  type AgentRunRequest,
  type AgentRunResponse,
} from "@/adapters/codex/schema";
import {
  placeSource,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  createMemoryWorldstateLedgerStore,
  ledgerVersion,
  type ProjectLedgerStore,
} from "@/adapters/storage";
import {
  briefCompiledEvent,
  buildDeltaAcceptedEvent,
  createLedgerEvent,
  deltaProposedEvent,
  runLifecycleEvent,
  type LedgerEvent,
  type WorldstateDelta,
} from "@/domain";
import { HOME_MOVE_ACTORS, HOME_MOVE_IDS } from "@/fixtures";
import {
  codexRunExchangeSourceEvent,
  codexRunNormalizationFailureSourceEvent,
  parseCodexRunAttemptSource,
  parseCodexRunExchangeSource,
  parseCodexRunNormalizationFailureSource,
} from "@/integration/codex-run-evidence";
import { parseCodexTransportObservationSource } from "@/integration/codex-transport-evidence";
import {
  INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
  compileReplayEvidenceRequest,
  parseReplayEvidenceValidationAttemptSource,
  parseReplayEvidenceValidationExchangeSource,
  replayEvidenceValidationAttemptSourceEvent,
  replayEvidenceValidationExchangeSourceEvent,
} from "@/integration/replay-evidence-validation";
import {
  parseResultReconciliationArtifactSource,
  resultReconciliationSourceId,
} from "@/integration/validated-closure-to-reconciliation";

import {
  appendWorldstateLedgerEvents,
} from "./worldstate-ledger-transaction";
import {
  createWorldstateSession,
  WorldstateSessionBusyError,
  WorldstateSessionNotReadyError,
  type WorldstateSession,
  type WorldstateSessionIdKind,
} from "./worldstate-session";

const NOW = "2026-07-17T14:00:00.000Z";
const SOURCE_TEXT =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";

function deterministicIds(seed: string) {
  let ordinal = 0;
  return (kind: WorldstateSessionIdKind) =>
    `${seed}:${kind}:${++ordinal}`;
}

async function placementGateway(
  request: PlacementRequest,
): Promise<PlacementResponse> {
  return (
    await placeSource(request, {
      environment: { ODEU_MANAGER_MODE: "fixture" },
    })
  ).body;
}

function passingReplayEvidence(
  request: ReplayEvidenceRequest,
): ReplayEvidenceResponse {
  const bindings = {
    validationRequestId: request.validationRequestId,
    validationId: request.validationId,
    closureId: request.closureId,
    runId: request.runId,
    briefId: request.briefId,
    baseRevisionId: request.baseRevisionId,
    artifactBaseRef: request.artifactBaseRef,
    replayIdentity: request.replayIdentity,
    semanticBriefDigest: request.semanticBriefDigest,
    exchangeSourceId: request.exchangeSourceId,
  };
  return ReplayEvidenceResponseSchema.parse({
    ok: true,
    status: "passed",
    verifier: {
      identity: HOME_MOVE_REPLAY_EVIDENCE_VERIFIER_IDENTITY,
      version: 2,
      kind: "independent_fixture",
    },
    bindings,
    observedAt: "2026-07-17T14:00:01.000Z",
    bundle: {
      bundleId: HOME_MOVE_REPLAY_EVIDENCE_BUNDLE_ID,
      version: 2,
      manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
      artifactCount: HOME_MOVE_REPLAY_EVIDENCE_ARTIFACT_COUNT,
    },
    observations: request.evidenceRequirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      result: "passed",
      evidenceRef:
        requirement.kind === "artifact"
          ? HOME_MOVE_REPLAY_ARTIFACT_EVIDENCE_REF
          : `${HOME_MOVE_REPLAY_TEST_EVIDENCE_REF_PREFIX}${encodeURIComponent(
              requirement.requirementId,
            )}/${HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID}`,
      detail: "Independently observed by the deterministic fixture verifier.",
      artifact:
        requirement.kind === "artifact"
          ? {
              path: HOME_MOVE_REPLAY_ARTIFACT_PATH,
              digest: HOME_MOVE_REPLAY_ARTIFACT_DIGEST,
              byteLength: HOME_MOVE_REPLAY_ARTIFACT_BYTE_LENGTH,
              manifestDigest: HOME_MOVE_REPLAY_EVIDENCE_MANIFEST_DIGEST,
            }
          : null,
      execution:
        requirement.kind === "test"
          ? {
              declaredCommand: HOME_MOVE_REPLAY_EVIDENCE_TEST_COMMAND,
              executionKind: HOME_MOVE_REPLAY_EVIDENCE_EXECUTION_KIND,
              runnerId: HOME_MOVE_REPLAY_EVIDENCE_RUNNER_ID,
              cases: HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.map(
                (caseId) => ({
                  caseId,
                  result: "passed" as const,
                  detail: "Observed the expected total.",
                }),
              ),
              passedCount: HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.length,
              totalCount: HOME_MOVE_REPLAY_EVIDENCE_EXPECTED_CASE_IDS.length,
            }
          : null,
    })),
  });
}

function sessionWith(input: {
  readonly store?: ProjectLedgerStore<LedgerEvent>;
  readonly agentGateway?: (
    request: AgentRunRequest,
  ) => Promise<AgentRunResponse>;
  readonly replayEvidenceGateway?: (
    request: ReplayEvidenceRequest,
  ) => Promise<ReplayEvidenceResponse>;
  readonly seed?: string;
} = {}): {
  readonly store: ProjectLedgerStore<LedgerEvent>;
  readonly session: WorldstateSession;
} {
  const store = input.store ?? createMemoryWorldstateLedgerStore();
  return {
    store,
    session: createWorldstateSession({
      store,
      placementGateway,
      agentGateway: input.agentGateway ?? (async (request) => runCodexReplay(request)),
      replayEvidenceGateway: input.replayEvidenceGateway,
      now: () => NOW,
      nextId: deterministicIds(input.seed ?? "delegation"),
    }),
  };
}

async function acceptDynamicPlacement(
  session: WorldstateSession,
  source = SOURCE_TEXT,
): Promise<void> {
  await session.initialize();
  await session.captureAndPlace(source);
  await session.acceptActivePlacement();
}

async function returnAndValidateReplay(session: WorldstateSession): Promise<void> {
  await acceptDynamicPlacement(session);
  await session.prepareActiveAgentBrief();
  await session.authorizeAndDispatchActiveBrief();
  await session.validateActiveReplayEvidence();
}

async function advanceCanonicalHead(
  store: ProjectLedgerStore<LedgerEvent>,
  suffix: string,
): Promise<void> {
  const current = await store.get(HOME_MOVE_IDS.project);
  if (!current) throw new Error("Expected a durable ledger before head advance.");
  const delta: WorldstateDelta = {
    id: `delta-reconciliation-race-${suffix}`,
    baseRevisionId: current.headRevisionId,
    scopeId: HOME_MOVE_IDS.project,
    purpose: "correction",
    proposedBy: HOME_MOVE_ACTORS.system,
    operations: [
      {
        op: "node.patch",
        nodeId: HOME_MOVE_IDS.packing,
        patch: { data: { [`reconciliationRace:${suffix}`]: true } },
      },
    ],
    rationale: ["Advance canonical state during reconciliation recovery."],
    sourceRefs: [],
    uncertainty: [],
    alternatives: [],
    conflicts: [],
    visibleConsequence: "A concurrent canonical change becomes durable.",
  };
  const proposed = await appendWorldstateLedgerEvents({
    store,
    current: {
      document: current,
      expectedVersion: ledgerVersion(current)!,
    },
    events: [
      deltaProposedEvent({
        eventId: `event-reconciliation-race-${suffix}-proposed`,
        commandId: `command-reconciliation-race-${suffix}-proposed`,
        occurredAt: NOW,
        actor: HOME_MOVE_ACTORS.system,
        payload: { delta },
      }),
    ],
    now: () => NOW,
  });
  await appendWorldstateLedgerEvents({
    store,
    current: {
      document: proposed.document,
      expectedVersion: proposed.version,
    },
    events: [
      buildDeltaAcceptedEvent(proposed.state, {
        eventId: `event-reconciliation-race-${suffix}-accepted`,
        commandId: `command-reconciliation-race-${suffix}-accepted`,
        occurredAt: NOW,
        actor: HOME_MOVE_ACTORS.system,
        deltaId: delta.id,
      }),
    ],
    now: () => NOW,
  });
}

describe("durable browser delegation session", () => {
  it("does not compile the authored moving-cost replay contract around an unrelated Task", async () => {
    const { session } = sessionWith();
    await acceptDynamicPlacement(session, "Add a packing checklist to this project.");
    const eventCount = session.getSnapshot().ledger?.events.length;

    await session.prepareActiveAgentBrief();

    expect(session.getSnapshot()).toMatchObject({
      activeBriefId: null,
      activeRunId: null,
      error: {
        code: "agent_brief_invalid",
        scope: "delegation",
        retryable: false,
      },
    });
    expect(session.getSnapshot().error?.message).toContain(
      "does not match the registered moving-cost replay scenario",
    );
    expect(session.getSnapshot().ledger?.events).toHaveLength(eventCount ?? 0);
  });

  it("persists preview before authority, then stages an exact replay closure without canonical mutation", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const gateway = vi.fn(async (request: AgentRunRequest) => {
      const durable = await store.get(HOME_MOVE_IDS.project);
      const authorization = durable?.events.at(-2);
      const attemptEvent = durable?.events.at(-1);
      expect(authorization?.type).toBe("run.authorized");
      expect(attemptEvent?.type).toBe("source.captured");
      if (attemptEvent?.type !== "source.captured") {
        throw new Error("Expected the exact request to be durable before dispatch.");
      }
      expect(parseCodexRunAttemptSource(attemptEvent.payload.source)?.request).toEqual(
        request,
      );
      expect(JSON.stringify(request)).not.toContain(HOME_MOVE_IDS.privateConstraint);
      expect(JSON.stringify(request)).not.toContain("new address");
      return runCodexReplay(request);
    });
    const { session } = sessionWith({ store, agentGateway: gateway });
    await acceptDynamicPlacement(session);
    const headBeforeDelegation =
      session.getSnapshot().state?.canonical.head.id;
    const beforePreviewCount = session.getSnapshot().ledger?.events.length ?? 0;

    await session.prepareActiveAgentBrief();

    const preview = session.getSnapshot();
    expect(preview.ledger?.events.slice(beforePreviewCount).map((event) => event.type)).toEqual([
      "brief.compiled",
    ]);
    expect(preview.state?.canonical.head.id).toBe(headBeforeDelegation);
    expect(preview.activeRunId).toBeNull();
    const brief = preview.activeBriefId
      ? preview.state?.operational.briefs[preview.activeBriefId]
      : undefined;
    expect(brief).toMatchObject({
      targetNodeId: preview.activeDeltaId
        ? preview.state?.operational.deltas[preview.activeDeltaId]?.delta.operations.find(
            (operation) => operation.op === "node.add",
          )?.node.id
        : undefined,
      unknowns: ["Recurring storage costs may need a separate comparison."],
      expectedArtifacts: ["demo/moving-costs.html"],
    });
    expect(brief?.omittedContext).toContainEqual(
      expect.objectContaining({
        nodeId: HOME_MOVE_IDS.privateConstraint,
        reason: "private",
      }),
    );
    const previewEventCount = preview.ledger?.events.length;
    await expect(session.prepareActiveAgentBrief()).rejects.toBeInstanceOf(
      WorldstateSessionNotReadyError,
    );
    expect(session.getSnapshot().ledger?.events).toHaveLength(
      previewEventCount ?? 0,
    );

    await session.authorizeAndDispatchActiveBrief();

    const returned = session.getSnapshot();
    expect(gateway).toHaveBeenCalledOnce();
    expect(returned.state?.canonical.head.id).toBe(headBeforeDelegation);
    expect(returned.activeRunId).toBeTruthy();
    expect(returned.activeClosureId).toBe(`closure:${returned.activeRunId}`);
    expect(
      returned.activeRunId
        ? returned.state?.operational.runs[returned.activeRunId]?.status
        : null,
    ).toBe("returned");
    expect(Object.keys(returned.state?.operational.validations ?? {})).toHaveLength(0);
    expect(
      Object.values(returned.state?.operational.deltas ?? {}).filter(
        (projection) => projection.delta.purpose === "reconciliation",
      ),
    ).toHaveLength(0);
    const exchangeEvent = returned.ledger?.events.find(
      (event) =>
        event.type === "source.captured" &&
        parseCodexRunExchangeSource(event.payload.source)?.request.runId ===
          returned.activeRunId,
    );
    if (exchangeEvent?.type !== "source.captured") {
      throw new Error("Expected a durable replay exchange.");
    }
    const exchange = parseCodexRunExchangeSource(exchangeEvent.payload.source);
    expect(exchange?.response).toMatchObject({
      ok: true,
      runtime: {
        effectiveMode: "replay",
        status: "replayed",
        replayIdentity: HOME_MOVE_REPLAY_IDENTITY,
      },
    });

    const reloaded = sessionWith({ store, seed: "reload" }).session;
    await reloaded.initialize();
    expect(reloaded.getSnapshot()).toMatchObject({
      activeBriefId: returned.activeBriefId,
      activeRunId: returned.activeRunId,
      activeClosureId: returned.activeClosureId,
      error: null,
    });
    expect(reloaded.getSnapshot().state?.canonical.head.id).toBe(
      headBeforeDelegation,
    );
  });

  it("records independent fixture evidence without trusting claims or changing canonical state", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const verifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const { session } = sessionWith({
      store,
      replayEvidenceGateway: verifier,
    });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();
    await session.authorizeAndDispatchActiveBrief();

    const before = session.getSnapshot();
    const canonicalBefore = structuredClone(before.state?.canonical);
    const eventCountBefore = before.ledger?.events.length ?? 0;
    await session.validateActiveReplayEvidence();

    const validated = session.getSnapshot();
    expect(verifier).toHaveBeenCalledOnce();
    expect(validated.state?.canonical).toEqual(canonicalBefore);
    expect(validated.ledger?.events.length).toBe(eventCountBefore + 3);
    expect(validated.activeValidationId).toBeTruthy();
    const validation = validated.activeValidationId
      ? validated.state?.operational.validations[validated.activeValidationId]
      : undefined;
    expect(validation?.validator).toEqual({
      id: "actor-independent-replay-validator",
      kind: "system",
      label: "Independent replay verifier",
    });
    expect(validation?.observations).toHaveLength(2);
    expect(
      validation?.observations.every(
        (observation) =>
          observation.result === "passed" &&
          observation.freshness === "current" &&
          observation.evidenceRefs.includes(
            validation.evidenceSourceId,
          ),
      ),
    ).toBe(true);
    expect(
      validated.ledger?.events.filter(
        (event) =>
          event.type === "source.captured" &&
          parseReplayEvidenceValidationAttemptSource(event.payload.source) !==
            null,
      ),
    ).toHaveLength(1);
    expect(
      validated.ledger?.events.filter(
        (event) =>
          event.type === "source.captured" &&
          parseReplayEvidenceValidationExchangeSource(event.payload.source) !==
            null,
      ),
    ).toHaveLength(1);
    expect(
      Object.values(validated.state?.operational.deltas ?? {}).some(
        (projection) => projection.delta.purpose === "reconciliation",
      ),
    ).toBe(false);

    const recoveryVerifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const reloaded = sessionWith({
      store,
      replayEvidenceGateway: recoveryVerifier,
      seed: "validation-reload",
    }).session;
    await reloaded.initialize();
    expect(recoveryVerifier).not.toHaveBeenCalled();
    expect(reloaded.getSnapshot().activeValidationId).toBe(
      validated.activeValidationId,
    );
    expect(reloaded.getSnapshot().state?.canonical).toEqual(canonicalBefore);
  });

  it("recomputes validation freshness after a CAS race advances the canonical head", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let injectedHeadAdvance = false;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        const containsValidation = document.events.some(
          (event) => event.type === "evidence.validation_recorded",
        );
        if (containsValidation && !injectedHeadAdvance) {
          injectedHeadAdvance = true;
          const current = await base.get(document.projectId);
          if (!current) throw new Error("Expected a durable ledger before the CAS race.");
          const concurrentDelta: WorldstateDelta = {
            id: "delta-validation-race-head-advance",
            baseRevisionId: current.headRevisionId,
            scopeId: HOME_MOVE_IDS.project,
            purpose: "placement",
            proposedBy: HOME_MOVE_ACTORS.system,
            operations: [
              {
                op: "node.add",
                node: {
                  id: "node-validation-race-head-advance",
                  scopeId: HOME_MOVE_IDS.project,
                  kind: "Idea",
                  title: "Concurrent canonical update",
                  visibility: "shared",
                  sourceRefs: [],
                  data: {},
                },
              },
            ],
            rationale: ["Advance canonical state during validation persistence."],
            sourceRefs: [],
            uncertainty: [],
            alternatives: [],
            conflicts: [],
            visibleConsequence: "Canonical state advances before evidence is stored.",
          };
          const proposed = await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: current,
              expectedVersion: ledgerVersion(current)!,
            },
            events: [
              deltaProposedEvent({
                eventId: "event-validation-race-head-advance-proposed",
                commandId: "command-validation-race-head-advance-proposed",
                occurredAt: NOW,
                actor: HOME_MOVE_ACTORS.system,
                payload: { delta: concurrentDelta },
              }),
            ],
            now: () => NOW,
          });
          await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: proposed.document,
              expectedVersion: proposed.version,
            },
            events: [
              buildDeltaAcceptedEvent(proposed.state, {
                eventId: "event-validation-race-head-advance-accepted",
                commandId: "command-validation-race-head-advance-accepted",
                occurredAt: NOW,
                actor: HOME_MOVE_ACTORS.system,
                deltaId: concurrentDelta.id,
              }),
            ],
            now: () => NOW,
          });
        }
        await base.put(document, expectedVersion);
      },
    };
    const verifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const { session } = sessionWith({ store, replayEvidenceGateway: verifier });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();
    await session.authorizeAndDispatchActiveBrief();
    const validationBaseRevisionId = session.getSnapshot().state?.canonical.head.id;

    await session.validateActiveReplayEvidence();

    const snapshot = session.getSnapshot();
    const validation = snapshot.activeValidationId
      ? snapshot.state?.operational.validations[snapshot.activeValidationId]
      : undefined;
    expect(verifier).toHaveBeenCalledOnce();
    expect(injectedHeadAdvance).toBe(true);
    expect(snapshot.state?.canonical.head.id).not.toBe(validationBaseRevisionId);
    expect(validation?.baseRevisionId).toBe(validationBaseRevisionId);
    expect(
      validation?.observations.every(
        (observation) => observation.freshness === "stale",
      ),
    ).toBe(true);
    expect(
      snapshot.state?.canonical.nodes["node-validation-race-head-advance"],
    ).toBeDefined();
  });

  it("accepts an equivalent validation another session stored before CAS recovery", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let injectedEquivalentValidation = false;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        const validationEvent = document.events.findLast(
          (event) => event.type === "evidence.validation_recorded",
        );
        if (validationEvent && !injectedEquivalentValidation) {
          injectedEquivalentValidation = true;
          const current = await base.get(document.projectId);
          if (!current) {
            throw new Error("Expected durable evidence before validation CAS.");
          }
          const validated = await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: current,
              expectedVersion: ledgerVersion(current)!,
            },
            events: [validationEvent],
            now: () => NOW,
          });
          const concurrentDelta: WorldstateDelta = {
            id: "delta-after-concurrent-validation",
            baseRevisionId: validated.state.canonical.head.id,
            scopeId: HOME_MOVE_IDS.project,
            purpose: "correction",
            proposedBy: HOME_MOVE_ACTORS.system,
            operations: [
              {
                op: "node.patch",
                nodeId: HOME_MOVE_IDS.packing,
                patch: { data: { concurrentValidationObserved: true } },
              },
            ],
            rationale: ["Advance canonical state after another session validates."],
            sourceRefs: [],
            uncertainty: [],
            alternatives: [],
            conflicts: [],
            visibleConsequence:
              "Packing records a concurrent update after validation.",
          };
          const proposed = await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: validated.document,
              expectedVersion: validated.version,
            },
            events: [
              deltaProposedEvent({
                eventId: "event-after-concurrent-validation-proposed",
                commandId: "command-after-concurrent-validation-proposed",
                occurredAt: NOW,
                actor: HOME_MOVE_ACTORS.system,
                payload: { delta: concurrentDelta },
              }),
            ],
            now: () => NOW,
          });
          await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: proposed.document,
              expectedVersion: proposed.version,
            },
            events: [
              buildDeltaAcceptedEvent(proposed.state, {
                eventId: "event-after-concurrent-validation-accepted",
                commandId: "command-after-concurrent-validation-accepted",
                occurredAt: NOW,
                actor: HOME_MOVE_ACTORS.system,
                deltaId: concurrentDelta.id,
              }),
            ],
            now: () => NOW,
          });
        }
        await base.put(document, expectedVersion);
      },
    };
    const verifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const { session } = sessionWith({ store, replayEvidenceGateway: verifier });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();
    await session.authorizeAndDispatchActiveBrief();

    await session.validateActiveReplayEvidence();

    const snapshot = session.getSnapshot();
    expect(injectedEquivalentValidation).toBe(true);
    expect(verifier).toHaveBeenCalledOnce();
    expect(snapshot.error).toBeNull();
    expect(
      snapshot.ledger?.events.filter(
        (event) => event.type === "evidence.validation_recorded",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.state?.canonical.nodes[HOME_MOVE_IDS.packing]?.data
        .concurrentValidationObserved,
    ).toBe(true);
  });

  it("retries only the exact durable validation request whose response was never observed", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const interruptedVerifier = vi.fn(async () => {
      throw new Error("verifier response was not observed");
    });
    const first = sessionWith({
      store,
      replayEvidenceGateway: interruptedVerifier,
      seed: "unobserved-validation",
    }).session;
    await acceptDynamicPlacement(first);
    await first.prepareActiveAgentBrief();
    await first.authorizeAndDispatchActiveBrief();
    await first.validateActiveReplayEvidence();

    expect(interruptedVerifier).toHaveBeenCalledOnce();
    expect(first.getSnapshot()).toMatchObject({
      activeValidationRequestId: expect.any(String),
      activeValidationId: expect.any(String),
      error: {
        code: "validation_outcome_unobserved",
        retryable: true,
        scope: "validation",
      },
    });

    const replacementVerifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const recovered = sessionWith({
      store,
      replayEvidenceGateway: replacementVerifier,
      seed: "unobserved-validation-reload",
    }).session;
    await recovered.initialize();

    expect(replacementVerifier).not.toHaveBeenCalled();
    expect(recovered.getSnapshot().activeValidationId).toBeTruthy();
    expect(
      Object.keys(
        recovered.getSnapshot().state?.operational.validations ?? {},
      ),
    ).toHaveLength(0);
    const durableRequestId = recovered.getSnapshot().activeValidationRequestId;
    const durableValidationId = recovered.getSnapshot().activeValidationId;
    await recovered.validateActiveReplayEvidence();
    expect(replacementVerifier).toHaveBeenCalledOnce();
    expect(replacementVerifier.mock.calls[0]?.[0]).toMatchObject({
      validationRequestId: durableRequestId,
      validationId: durableValidationId,
    });
    expect(
      recovered.getSnapshot().state?.operational.validations[
        durableValidationId!
      ],
    ).toBeDefined();
  });

  it("normalizes a durable verifier response after reload without rerunning verification", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const first = sessionWith({ store }).session;
    await acceptDynamicPlacement(first);
    await first.prepareActiveAgentBrief();
    await first.authorizeAndDispatchActiveBrief();
    const snapshot = first.getSnapshot();
    const closureId = snapshot.activeClosureId;
    const closure = closureId
      ? snapshot.state?.operational.closures[closureId]
      : undefined;
    const runProjection = closure
      ? snapshot.state?.operational.runs[closure.runId]
      : undefined;
    const brief = closure
      ? snapshot.state?.operational.briefs[closure.briefId]
      : undefined;
    const codexExchange = snapshot.ledger?.events
      .filter((event) => event.type === "source.captured")
      .map((event) => parseCodexRunExchangeSource(event.payload.source))
      .find((candidate) => candidate?.request.runId === runProjection?.run.id);
    if (!closure || !runProjection || !brief || !codexExchange) {
      throw new Error("Expected a returned replay chain before interruption.");
    }
    const request = compileReplayEvidenceRequest({
      validationRequestId: "request-interrupted-validation",
      validationId: "validation-interrupted-replay",
      run: runProjection.run,
      brief,
      closure,
      codexExchange,
    });
    const response = passingReplayEvidence(request);
    const current = await store.get(HOME_MOVE_IDS.project);
    if (!current) throw new Error("Expected the durable replay ledger.");
    await appendWorldstateLedgerEvents({
      store,
      current: {
        document: current,
        expectedVersion: ledgerVersion(current)!,
      },
      events: [
        replayEvidenceValidationAttemptSourceEvent({
          request,
          eventId: "event-interrupted-validation-attempt",
          commandId: "command-interrupted-validation-attempt",
          occurredAt: NOW,
          actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
        }),
        replayEvidenceValidationExchangeSourceEvent({
          request,
          response,
          eventId: "event-interrupted-validation-exchange",
          commandId: "command-interrupted-validation-exchange",
          occurredAt: NOW,
          actor: INDEPENDENT_REPLAY_VALIDATOR_ACTOR,
        }),
      ],
      now: () => NOW,
    });

    const verifier = vi.fn(async (candidate: ReplayEvidenceRequest) =>
      passingReplayEvidence(candidate),
    );
    const recovered = sessionWith({
      store,
      replayEvidenceGateway: verifier,
      seed: "interrupted-validation-reload",
    }).session;
    await recovered.initialize();

    expect(verifier).not.toHaveBeenCalled();
    expect(recovered.getSnapshot().activeValidationId).toBe(
      request.validationId,
    );
    expect(
      recovered.getSnapshot().state?.operational.validations[
        request.validationId
      ]?.observations.every((observation) => observation.result === "passed"),
    ).toBe(true);
    expect(recovered.getSnapshot().persistenceDetail).toContain(
      "without rerunning verification",
    );
  });

  it("persists a reviewable reconciliation separately, then integrates it with explicit human authority", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const verifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const first = sessionWith({
      store,
      replayEvidenceGateway: verifier,
      seed: "reconciliation-happy",
    }).session;
    await returnAndValidateReplay(first);
    const validated = first.getSnapshot();
    const canonicalBefore = structuredClone(validated.state?.canonical);
    const placementDeltaId = validated.activeDeltaId;
    const validationId = validated.activeValidationId;
    const eventCountBeforeProposal = validated.ledger?.events.length ?? 0;
    const revisionCountBefore =
      validated.state?.canonical.revisionOrder.length ?? 0;

    await first.proposeActiveReconciliation();

    const proposed = first.getSnapshot();
    const reconciliationDeltaId = proposed.activeReconciliationDeltaId;
    expect(reconciliationDeltaId).toBeTruthy();
    expect(proposed.activeDeltaId).toBe(placementDeltaId);
    expect(proposed.activeIntegratedRevisionId).toBeNull();
    expect(proposed.state?.canonical).toEqual(canonicalBefore);
    expect(
      proposed.ledger?.events
        .slice(eventCountBeforeProposal)
        .map((event) => event.type),
    ).toEqual(["source.captured", "delta.proposed"]);
    const projection = reconciliationDeltaId
      ? proposed.state?.operational.deltas[reconciliationDeltaId]
      : undefined;
    expect(projection).toMatchObject({
      disposition: "pending",
      delta: {
        purpose: "reconciliation",
        closureRef: proposed.activeClosureId,
        validationRef: validationId,
      },
    });
    const receiptSource = reconciliationDeltaId
      ? proposed.state?.operational.sources[
          resultReconciliationSourceId(reconciliationDeltaId)
        ]
      : undefined;
    expect(
      receiptSource
        ? parseResultReconciliationArtifactSource(receiptSource)?.bindings
        : null,
    ).toMatchObject({
      deltaId: reconciliationDeltaId,
      closureId: proposed.activeClosureId,
      validationId,
    });

    const pendingReload = sessionWith({
      store,
      seed: "reconciliation-pending-reload",
    }).session;
    await pendingReload.initialize();
    expect(pendingReload.getSnapshot()).toMatchObject({
      activeDeltaId: placementDeltaId,
      activeReconciliationDeltaId: reconciliationDeltaId,
      activeIntegratedRevisionId: null,
    });
    expect(pendingReload.getSnapshot().ledger?.events).toHaveLength(
      proposed.ledger?.events.length ?? 0,
    );

    await pendingReload.integrateActiveReconciliation();

    const integrated = pendingReload.getSnapshot();
    expect(integrated.state?.canonical.revisionOrder).toHaveLength(
      revisionCountBefore + 1,
    );
    expect(integrated.activeIntegratedRevisionId).toBe(
      integrated.state?.canonical.head.id,
    );
    expect(integrated.activeDeltaId).toBe(placementDeltaId);
    expect(
      reconciliationDeltaId
        ? integrated.state?.operational.deltas[reconciliationDeltaId]
            ?.disposition
        : null,
    ).toBe("accepted");
    const targetId = integrated.activeBriefId
      ? integrated.state?.operational.briefs[integrated.activeBriefId]
          ?.targetNodeId
      : undefined;
    expect(targetId ? integrated.state?.canonical.nodes[targetId]?.work : null).toEqual(
      { phase: "completed", verification: "verified" },
    );
    const accepted = integrated.ledger?.events.findLast(
      (event) =>
        event.type === "delta.accepted" &&
        event.payload.deltaId === reconciliationDeltaId,
    );
    expect(accepted).toMatchObject({
      actor: { kind: "human" },
      payload: {
        artifactBaseRef: projection?.delta.closureRef
          ? integrated.state?.operational.closures[
              projection.delta.closureRef
            ]?.artifactBaseRef
          : undefined,
      },
    });
    await expect(
      pendingReload.integrateActiveReconciliation(),
    ).rejects.toBeInstanceOf(WorldstateSessionNotReadyError);

    const integratedReload = sessionWith({
      store,
      seed: "reconciliation-integrated-reload",
    }).session;
    await integratedReload.initialize();
    expect(integratedReload.getSnapshot()).toMatchObject({
      activeDeltaId: placementDeltaId,
      activeReconciliationDeltaId: reconciliationDeltaId,
      activeIntegratedRevisionId: integrated.activeIntegratedRevisionId,
    });
  });

  it("adopts equivalent concurrent proposal and integration outcomes without duplicating events", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let injectedProposal = false;
    let injectedIntegration = false;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        const proposed = document.events.at(-1);
        const receipt = document.events.at(-2);
        if (
          !injectedProposal &&
          proposed?.type === "delta.proposed" &&
          proposed.payload.delta.purpose === "reconciliation" &&
          receipt?.type === "source.captured"
        ) {
          injectedProposal = true;
          const current = await base.get(document.projectId);
          if (!current) throw new Error("Expected durable validation before proposal race.");
          await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: current,
              expectedVersion: ledgerVersion(current)!,
            },
            events: [receipt, proposed],
            now: () => NOW,
          });
        }
        const accepted = document.events.at(-1);
        if (
          !injectedIntegration &&
          accepted?.type === "delta.accepted" &&
          accepted.eventId.startsWith("event-result-reconciliation-integrated:")
        ) {
          injectedIntegration = true;
          const current = await base.get(document.projectId);
          if (!current) throw new Error("Expected a durable proposal before integration race.");
          await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: current,
              expectedVersion: ledgerVersion(current)!,
            },
            events: [accepted],
            now: () => NOW,
          });
        }
        await base.put(document, expectedVersion);
      },
    };
    const verifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const { session } = sessionWith({ store, replayEvidenceGateway: verifier });
    await returnAndValidateReplay(session);

    await session.proposeActiveReconciliation();
    await session.integrateActiveReconciliation();

    const snapshot = session.getSnapshot();
    const deltaId = snapshot.activeReconciliationDeltaId;
    expect(injectedProposal).toBe(true);
    expect(injectedIntegration).toBe(true);
    expect(snapshot.error).toBeNull();
    expect(
      snapshot.ledger?.events.filter(
        (event) =>
          event.type === "delta.proposed" &&
          event.payload.delta.id === deltaId,
      ),
    ).toHaveLength(1);
    expect(
      snapshot.ledger?.events.filter(
        (event) =>
          event.type === "delta.accepted" &&
          event.payload.deltaId === deltaId,
      ),
    ).toHaveLength(1);
    expect(snapshot.activeIntegratedRevisionId).toBe(
      snapshot.state?.canonical.head.id,
    );
  });

  it("fails closed when the canonical head advances during proposal persistence", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let injectedHeadAdvance = false;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        const includesReconciliationProposal = document.events.some(
          (event) =>
            event.type === "delta.proposed" &&
            event.payload.delta.purpose === "reconciliation",
        );
        if (includesReconciliationProposal && !injectedHeadAdvance) {
          injectedHeadAdvance = true;
          await advanceCanonicalHead(base, "proposal-head-advance");
        }
        await base.put(document, expectedVersion);
      },
    };
    const verifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const { session } = sessionWith({ store, replayEvidenceGateway: verifier });
    await returnAndValidateReplay(session);
    const headBefore = session.getSnapshot().state?.canonical.head.id;

    await session.proposeActiveReconciliation();

    const snapshot = session.getSnapshot();
    expect(injectedHeadAdvance).toBe(true);
    expect(snapshot.state?.canonical.head.id).not.toBe(headBefore);
    expect(snapshot.activeReconciliationDeltaId).toBeNull();
    expect(snapshot.error).toMatchObject({
      code: "stale_reconciliation",
      scope: "reconciliation",
      retryable: false,
    });
    expect(
      Object.values(snapshot.state?.operational.deltas ?? {}).filter(
        (projection) => projection.delta.purpose === "reconciliation",
      ),
    ).toHaveLength(0);
    expect(
      Object.values(snapshot.state?.operational.sources ?? {}).filter((source) =>
        source.id.startsWith("source-result-reconciliation:"),
      ),
    ).toHaveLength(0);
  });

  it("retains a pending proposal when the canonical head advances during integration", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let injectedHeadAdvance = false;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        const accepted = document.events.at(-1);
        if (
          !injectedHeadAdvance &&
          accepted?.type === "delta.accepted" &&
          accepted.eventId.startsWith("event-result-reconciliation-integrated:")
        ) {
          injectedHeadAdvance = true;
          await advanceCanonicalHead(base, "integration-head-advance");
        }
        await base.put(document, expectedVersion);
      },
    };
    const verifier = vi.fn(async (request: ReplayEvidenceRequest) =>
      passingReplayEvidence(request),
    );
    const { session } = sessionWith({ store, replayEvidenceGateway: verifier });
    await returnAndValidateReplay(session);
    await session.proposeActiveReconciliation();
    const deltaId = session.getSnapshot().activeReconciliationDeltaId;

    await session.integrateActiveReconciliation();

    const snapshot = session.getSnapshot();
    expect(injectedHeadAdvance).toBe(true);
    expect(snapshot.activeReconciliationDeltaId).toBe(deltaId);
    expect(snapshot.activeIntegratedRevisionId).toBeNull();
    expect(snapshot.error).toMatchObject({
      code: "stale_reconciliation",
      scope: "integration",
      retryable: false,
    });
    expect(
      deltaId
        ? snapshot.state?.operational.deltas[deltaId]?.disposition
        : null,
    ).toBe("pending");
    expect(
      snapshot.ledger?.events.filter(
        (event) =>
          event.type === "delta.accepted" &&
          event.payload.deltaId === deltaId,
      ),
    ).toHaveLength(0);
  });

  it("keeps the one-run gate busy and prevents a duplicate dispatch", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = vi.fn(async (request: AgentRunRequest) => {
      await gate;
      return runCodexReplay(request);
    });
    const { session } = sessionWith({ agentGateway: gateway });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();

    const first = session.authorizeAndDispatchActiveBrief();
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledOnce());
    expect(session.getSnapshot()).toMatchObject({
      operationState: "dispatching_run",
      error: null,
    });
    await expect(
      session.authorizeAndDispatchActiveBrief(),
    ).rejects.toBeInstanceOf(WorldstateSessionBusyError);

    release?.();
    await first;
    expect(gateway).toHaveBeenCalledOnce();
  });

  it("records an unobserved gateway outcome as unknown without inventing an exchange or closure", async () => {
    const { session } = sessionWith({
      agentGateway: async (request) => {
        throw new BrowserAgentGatewayError("replay route offline", {
          requestId: request.requestId,
          runId: request.runId,
          outcome: "transport_failed",
          httpStatus: null,
          contentType: null,
          bodyExcerpt: null,
          bodyTruncated: false,
          bodyDigest: null,
        });
      },
    });
    await acceptDynamicPlacement(session);
    const head = session.getSnapshot().state?.canonical.head.id;
    await session.prepareActiveAgentBrief();

    await session.authorizeAndDispatchActiveBrief();

    const snapshot = session.getSnapshot();
    expect(snapshot.state?.canonical.head.id).toBe(head);
    expect(snapshot.activeRunId).toBeTruthy();
    expect(snapshot.activeClosureId).toBeNull();
    expect(
      snapshot.activeRunId
        ? snapshot.state?.operational.runs[snapshot.activeRunId]?.status
        : null,
    ).toBe("outcome_unknown");
    expect(snapshot.error).toMatchObject({
      code: "delegation_outcome_unknown",
      retryable: false,
      scope: "delegation",
    });
    expect(
      snapshot.ledger?.events.some(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunExchangeSource(event.payload.source) !== null,
      ),
    ).toBe(false);
    expect(
      snapshot.ledger?.events
        .filter((event) => event.type === "source.captured")
        .map((event) => parseCodexTransportObservationSource(event.payload.source))
        .find((observation) => observation !== null),
    ).toMatchObject({
      outcome: "transport_failed",
      httpStatus: null,
      bodyExcerpt: null,
    });
  });

  it("retains a schema-valid mismatched response as evidence but stages no closure", async () => {
    const { session } = sessionWith({
      agentGateway: async (request) => {
        const response = structuredClone(runCodexReplay(request));
        response.closure.runId = "run-from-another-request";
        return AgentRunResponseSchema.parse(response);
      },
    });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();

    await session.authorizeAndDispatchActiveBrief();

    const snapshot = session.getSnapshot();
    expect(snapshot.activeClosureId).toBeNull();
    expect(
      snapshot.activeRunId
        ? snapshot.state?.operational.runs[snapshot.activeRunId]?.status
        : null,
    ).toBe("outcome_unknown");
    const exchange = snapshot.ledger?.events.find(
      (event) =>
        event.type === "source.captured" &&
        parseCodexRunExchangeSource(event.payload.source) !== null,
    );
    if (exchange?.type !== "source.captured") {
      throw new Error("Expected the mismatched response to remain durable evidence.");
    }
    expect(
      parseCodexRunExchangeSource(exchange.payload.source)?.response.ok,
    ).toBe(true);
    expect(
      snapshot.ledger?.events.some(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunNormalizationFailureSource(event.payload.source)?.code ===
            "coherence_rejected",
      ),
    ).toBe(true);
    expect(snapshot.error?.message).toContain("response.closure.runId");
  });

  it("does not let late evidence from an older run replace the active brief chain", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createMemoryWorldstateLedgerStore();
    const gateway = vi.fn(async (request: AgentRunRequest) => {
      const response = runCodexReplay(request);
      await gate;
      return response;
    });
    const { session } = sessionWith({ store, agentGateway: gateway });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();
    const originalBriefId = session.getSnapshot().activeBriefId;
    const originalBrief = originalBriefId
      ? session.getSnapshot().state?.operational.briefs[originalBriefId]
      : undefined;
    if (!originalBrief) throw new Error("Expected the prepared brief.");

    const dispatch = session.authorizeAndDispatchActiveBrief();
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledOnce());
    const originalRunId = session.getSnapshot().activeRunId;
    const current = await store.get(HOME_MOVE_IDS.project);
    if (!current) throw new Error("Expected the durable authorized run.");
    const replacementBriefId = "brief-concurrent-newer";
    await appendWorldstateLedgerEvents({
      store,
      current: {
        document: current,
        expectedVersion: ledgerVersion(current)!,
      },
      events: [
        briefCompiledEvent({
          eventId: "event-concurrent-newer-brief",
          commandId: "command-concurrent-newer-brief",
          occurredAt: NOW,
          actor: HOME_MOVE_ACTORS.manager,
          payload: {
            brief: { ...originalBrief, id: replacementBriefId },
          },
        }),
      ],
      now: () => NOW,
    });

    release?.();
    await dispatch;

    expect(session.getSnapshot()).toMatchObject({
      activeAgentRequestId: null,
      activeBriefId: replacementBriefId,
      activeRunId: null,
      activeClosureId: null,
    });
    expect(
      originalRunId
        ? session.getSnapshot().state?.operational.runs[originalRunId]?.status
        : null,
    ).toBe("returned");

    const reloaded = sessionWith({ store, seed: "late-evidence-reload" }).session;
    await reloaded.initialize();
    expect(reloaded.getSnapshot()).toMatchObject({
      activeAgentRequestId: null,
      activeBriefId: replacementBriefId,
      activeRunId: null,
      activeClosureId: null,
    });
  });

  it("recovers repeated result-persistence CAS conflicts without dispatching twice", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let injectedConflicts = 0;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        const containsNewExchange = document.events.some(
          (event) =>
            event.type === "source.captured" &&
            parseCodexRunExchangeSource(event.payload.source) !== null,
        );
        if (containsNewExchange && injectedConflicts < 2) {
          injectedConflicts += 1;
          const current = await base.get(document.projectId);
          if (!current) throw new Error("Expected a durable ledger before the CAS race.");
          await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: current,
              expectedVersion: ledgerVersion(current)!,
            },
            events: [
              createLedgerEvent({
                eventId: `event-concurrent-view-selection-${injectedConflicts}`,
                commandId: `command-concurrent-view-selection-${injectedConflicts}`,
                occurredAt: NOW,
                actor: HOME_MOVE_ACTORS.human,
                type: "projection.selected",
                payload: {
                  projection: injectedConflicts === 1 ? "timeline" : "focus",
                },
              }),
            ],
            now: () => NOW,
          });
        }
        await base.put(document, expectedVersion);
      },
    };
    const gateway = vi.fn(async (request: AgentRunRequest) =>
      runCodexReplay(request),
    );
    const { session } = sessionWith({ store, agentGateway: gateway });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();

    await session.authorizeAndDispatchActiveBrief();

    expect(injectedConflicts).toBe(2);
    expect(gateway).toHaveBeenCalledOnce();
    expect(session.getSnapshot().activeClosureId).toBeTruthy();
    expect(session.getSnapshot().state?.operational.selectedProjection).toBe(
      "focus",
    );
    expect(
      session.getSnapshot().ledger?.events.filter(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunExchangeSource(event.payload.source) !== null,
      ),
    ).toHaveLength(1);
  });

  it("keeps the exact response when concurrent terminal state rejects normalization", async () => {
    const base = createMemoryWorldstateLedgerStore();
    let injectedTerminalState = false;
    const store: ProjectLedgerStore<LedgerEvent> = {
      ...base,
      async put(document, expectedVersion) {
        const containsNormalizedLifecycle = document.events.some(
          (event) =>
            event.type === "run.lifecycle_recorded" &&
            event.payload.status === "received",
        );
        if (containsNormalizedLifecycle && !injectedTerminalState) {
          injectedTerminalState = true;
          const current = await base.get(document.projectId);
          const runEvent = current?.events.find(
            (event) => event.type === "run.authorized",
          );
          if (!current || runEvent?.type !== "run.authorized") {
            throw new Error("Expected an authorized run before the CAS race.");
          }
          await appendWorldstateLedgerEvents({
            store: base,
            current: {
              document: current,
              expectedVersion: ledgerVersion(current)!,
            },
            events: [
              runLifecycleEvent({
                eventId: "event-concurrent-outcome-unknown",
                commandId: "command-concurrent-outcome-unknown",
                occurredAt: NOW,
                actor: HOME_MOVE_ACTORS.system,
                payload: {
                  runId: runEvent.payload.run.id,
                  status: "outcome_unknown",
                  message: "A concurrent observer could not determine the outcome.",
                  evidenceRefs: [],
                },
              }),
            ],
            now: () => NOW,
          });
        }
        await base.put(document, expectedVersion);
      },
    };
    const gateway = vi.fn(async (request: AgentRunRequest) =>
      runCodexReplay(request),
    );
    const { session } = sessionWith({ store, agentGateway: gateway });
    await acceptDynamicPlacement(session);
    await session.prepareActiveAgentBrief();

    await session.authorizeAndDispatchActiveBrief();

    const snapshot = session.getSnapshot();
    expect(injectedTerminalState).toBe(true);
    expect(gateway).toHaveBeenCalledOnce();
    expect(snapshot.activeClosureId).toBeNull();
    expect(
      snapshot.activeRunId
        ? snapshot.state?.operational.runs[snapshot.activeRunId]?.status
        : null,
    ).toBe("outcome_unknown");
    expect(
      snapshot.ledger?.events.filter(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunExchangeSource(event.payload.source) !== null,
      ),
    ).toHaveLength(1);
    expect(
      snapshot.ledger?.events.some(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunNormalizationFailureSource(event.payload.source)?.code ===
            "state_conflict",
      ),
    ).toBe(true);
  });

  it("normalizes an exact response found after reload without redispatch", async () => {
    const pending = new Promise<AgentRunResponse>(() => {});
    const store = createMemoryWorldstateLedgerStore();
    const firstGateway = vi.fn(async (request: AgentRunRequest) => {
      void request;
      return pending;
    });
    const first = sessionWith({ store, agentGateway: firstGateway }).session;
    await acceptDynamicPlacement(first);
    await first.prepareActiveAgentBrief();
    void first.authorizeAndDispatchActiveBrief();
    await vi.waitFor(() => expect(firstGateway).toHaveBeenCalledOnce());
    const observedRequest = firstGateway.mock.calls[0]?.[0];
    if (!observedRequest) throw new Error("Expected the durable replay request.");

    const current = await store.get(HOME_MOVE_IDS.project);
    if (!current) throw new Error("Expected the authorized durable ledger.");
    await appendWorldstateLedgerEvents({
      store,
      current: {
        document: current,
        expectedVersion: ledgerVersion(current)!,
      },
      events: [
        codexRunExchangeSourceEvent({
          request: observedRequest,
          response: runCodexReplay(observedRequest),
          eventId: "event-interrupted-exact-response",
          commandId: "command-interrupted-exact-response",
          occurredAt: NOW,
          actor: HOME_MOVE_ACTORS.system,
        }),
        runLifecycleEvent({
          eventId: "event-interrupted-exact-response-received",
          commandId: "command-interrupted-exact-response-received",
          occurredAt: NOW,
          actor: HOME_MOVE_ACTORS.system,
          payload: {
            runId: observedRequest.runId,
            status: "received",
            message: "A trusted observer recorded partial lifecycle progress.",
            evidenceRefs: [],
          },
        }),
      ],
      now: () => NOW,
    });

    const recoveryGateway = vi.fn(async (request: AgentRunRequest) =>
      runCodexReplay(request),
    );
    const recovered = sessionWith({
      store,
      agentGateway: recoveryGateway,
      seed: "response-recovery",
    }).session;
    await recovered.initialize();

    const snapshot = recovered.getSnapshot();
    expect(recoveryGateway).not.toHaveBeenCalled();
    expect(snapshot.activeClosureId).toBe(`closure:${snapshot.activeRunId}`);
    expect(
      snapshot.activeRunId
        ? snapshot.state?.operational.runs[snapshot.activeRunId]?.status
        : null,
    ).toBe("returned");
    expect(snapshot.persistenceDetail).toContain("without redispatch");
  });

  it("completes an interrupted unknown-outcome transition after reload", async () => {
    const pending = new Promise<AgentRunResponse>(() => {});
    const store = createMemoryWorldstateLedgerStore();
    const firstGateway = vi.fn(async (request: AgentRunRequest) => {
      void request;
      return pending;
    });
    const first = sessionWith({ store, agentGateway: firstGateway }).session;
    await acceptDynamicPlacement(first);
    await first.prepareActiveAgentBrief();
    void first.authorizeAndDispatchActiveBrief();
    await vi.waitFor(() => expect(firstGateway).toHaveBeenCalledOnce());
    const observedRequest = firstGateway.mock.calls[0]?.[0];
    if (!observedRequest) throw new Error("Expected the durable replay request.");
    const briefId = observedRequest.brief.briefId;

    const current = await store.get(HOME_MOVE_IDS.project);
    if (!current) throw new Error("Expected the authorized durable ledger.");
    await appendWorldstateLedgerEvents({
      store,
      current: {
        document: current,
        expectedVersion: ledgerVersion(current)!,
      },
      events: [
        codexRunExchangeSourceEvent({
          request: observedRequest,
          response: runCodexReplay(observedRequest),
          eventId: "event-interrupted-rejected-response",
          commandId: "command-interrupted-rejected-response",
          occurredAt: NOW,
          actor: HOME_MOVE_ACTORS.system,
        }),
        runLifecycleEvent({
          eventId: "event-interrupted-normalization-received",
          commandId: "command-interrupted-normalization-received",
          occurredAt: NOW,
          actor: HOME_MOVE_ACTORS.system,
          payload: {
            runId: observedRequest.runId,
            status: "received",
            message: "The response was observed before normalization stopped.",
            evidenceRefs: [],
          },
        }),
        codexRunNormalizationFailureSourceEvent({
          requestId: observedRequest.requestId,
          runId: observedRequest.runId,
          briefId,
          code: "coherence_rejected",
          message: "Normalization stopped after durable failure evidence.",
          eventId: "event-interrupted-normalization-failure",
          commandId: "command-interrupted-normalization-failure",
          occurredAt: NOW,
          actor: HOME_MOVE_ACTORS.system,
        }),
      ],
      now: () => NOW,
    });

    const recoveryGateway = vi.fn(async (request: AgentRunRequest) =>
      runCodexReplay(request),
    );
    const recovered = sessionWith({
      store,
      agentGateway: recoveryGateway,
      seed: "unknown-recovery",
    }).session;
    await recovered.initialize();

    const snapshot = recovered.getSnapshot();
    expect(recoveryGateway).not.toHaveBeenCalled();
    expect(snapshot.activeClosureId).toBeNull();
    expect(
      snapshot.activeRunId
        ? snapshot.state?.operational.runs[snapshot.activeRunId]?.status
        : null,
    ).toBe("outcome_unknown");
    expect(snapshot.error).toMatchObject({
      code: "delegation_outcome_unknown",
      scope: "delegation",
    });
    expect(snapshot.persistenceDetail).toContain("without redispatch");
  });

  it("rehydrates an authorized attempt with no response as an explicitly unobserved outcome", async () => {
    const pending = new Promise<AgentRunResponse>(() => {});
    const store = createMemoryWorldstateLedgerStore();
    const gateway = vi.fn(async () => pending);
    const first = sessionWith({ store, agentGateway: gateway }).session;
    await acceptDynamicPlacement(first);
    await first.prepareActiveAgentBrief();
    void first.authorizeAndDispatchActiveBrief();
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledOnce());

    const reloaded = sessionWith({ store, seed: "interrupted" }).session;
    await reloaded.initialize();

    expect(reloaded.getSnapshot()).toMatchObject({
      operationState: "idle",
      activeRunId: first.getSnapshot().activeRunId,
      activeClosureId: null,
      error: {
        code: "delegation_outcome_unobserved",
        retryable: false,
        scope: "delegation",
      },
    });

  });
});
