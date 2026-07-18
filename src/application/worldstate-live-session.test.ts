import { describe, expect, it, vi } from "vitest";

import {
  AgentRunFailureSchema,
  AgentRunResponseSchema,
  type AgentRunRequest,
  type AgentRunResponse,
} from "@/adapters/codex/schema";
import { ArtifactPromotionReceiptSchema } from "@/adapters/artifact-promotion/schema";
import type { BrowserLiveAuthorizationInput } from "@/adapters/codex/live-authorization";
import {
  LIVE_EVIDENCE_ARTIFACT_PATH,
  LIVE_EVIDENCE_RUNNER_ID,
  LIVE_EVIDENCE_TEST_COMMAND,
  LIVE_EVIDENCE_VERIFIER_IDENTITY,
  LiveEvidenceResponseSchema,
  type LiveEvidenceRequest,
  type LiveEvidenceResponse,
} from "@/adapters/live-evidence";
import { testLiveEvidenceHarnessObservation } from "@/adapters/live-evidence/test-observation";
import {
  placeSource,
  type PlacementRequest,
  type PlacementResponse,
} from "@/adapters/manager";
import {
  createMemoryWorldstateLedgerStore,
  worldstateStateFromLedgerDocument,
} from "@/adapters/storage";
import { HOME_MOVE_IDS } from "@/fixtures";
import { authorizedCodexRunRequest } from "@/integration/authorized-codex-run";
import {
  parseCodexRunAttemptSource,
  parseCodexRunExchangeSource,
} from "@/integration/codex-run-evidence";
import {
  parseLiveEvidenceValidationAttemptSource,
  parseLiveEvidenceValidationExchangeSource,
} from "@/integration/live-evidence-validation";
import { parseResultReconciliationArtifactSource } from "@/integration/validated-closure-to-reconciliation";
import { buildWorkbenchViewModel } from "@/components/worldstate/view-model";

import {
  createWorldstateSession,
  type WorldstateSessionIdKind,
} from "./worldstate-session";

const NOW = "2026-07-18T15:00:00.000Z";
const BASE_COMMIT = "a".repeat(40);

function deterministicIds() {
  let ordinal = 0;
  return (kind: WorldstateSessionIdKind) => `live-session:${kind}:${++ordinal}`;
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

function stagedCandidate(request: AgentRunRequest) {
  const candidateDigest = "2".repeat(64);
  return {
    metadata: {
      kind: "odeu.git-artifact-candidate" as const,
      version: 1 as const,
      candidateId: `artifact-candidate:sha256:${candidateDigest}`,
      candidateRef: `refs/odeu/candidates/${candidateDigest}`,
      repositoryId: "repository-home-move-live-test",
      targetRef: "refs/heads/main",
      runId: request.runId,
      briefId: request.brief.briefId,
      baseRevisionId: request.brief.sourceRevisionId,
      sealedAt: NOW,
      git: {
        objectFormat: "sha1" as const,
        baseCommit: BASE_COMMIT,
        baseTree: "b".repeat(40),
        candidateCommit: "c".repeat(40),
        candidateTree: "d".repeat(40),
      },
      patch: {
        format: "git-binary-diff-v1" as const,
        digest: `sha256:${"e".repeat(64)}`,
        byteLength: 256,
      },
      manifest: {
        digest: `sha256:${"f".repeat(64)}`,
        entries: [
          {
            path: LIVE_EVIDENCE_ARTIFACT_PATH,
            status: "modified" as const,
            oldMode: "100644" as const,
            newMode: "100644" as const,
            oldBlob: "1".repeat(40),
            newBlob: "3".repeat(40),
          },
        ],
      },
    },
    signature: {
      algorithm: "hmac-sha256" as const,
      keyId: "artifact-key-live-session-test",
      digest: `hmac-sha256:${"4".repeat(64)}`,
    },
  };
}

function returnedLiveResponse(request: AgentRunRequest): AgentRunResponse {
  const candidate = stagedCandidate(request);
  return AgentRunResponseSchema.parse({
    ok: true,
    runtime: {
      requestedMode: "live",
      effectiveMode: "live",
      status: "returned",
      provider: "codex",
      replayIdentity: null,
      replayKind: null,
    },
    events: [
      {
        sequence: 0,
        status: "queued",
        at: NOW,
        label: "Brief queued",
        detail: "The signed live request entered the isolated worker boundary.",
      },
      {
        sequence: 1,
        status: "received",
        at: NOW,
        label: "Brief received",
        detail: "The isolated worker received the immutable live brief.",
      },
      {
        sequence: 2,
        status: "working",
        at: NOW,
        label: "Working",
        detail: "The isolated worker changed the declared artifact.",
      },
      {
        sequence: 3,
        status: "returned",
        at: NOW,
        label: "Result returned",
        detail: "The live result returned with a sealed staged candidate.",
      },
    ],
    closure: {
      runId: request.runId,
      briefId: request.brief.briefId,
      sourceRevisionIdUsed: request.brief.sourceRevisionId,
      artifactBaseRefUsed: request.brief.artifactBaseRef,
      workerThreadId: "thread-live-session-test",
      workerItemIds: ["item-live-file", "item-live-command"],
      report: {
        outcome: "returned",
        claimedEffects: ["Added the moving-cost comparison tool."],
        claimedArtifacts: [
          {
            path: LIVE_EVIDENCE_ARTIFACT_PATH,
            kind: "updated",
            summary: "Added the moving-cost comparison interface.",
            reference: candidate.metadata.candidateId,
          },
        ],
        claimedChecks: request.brief.evidenceContract.requiredChecks.map(
          (check) => ({
            checkId: check.checkId,
            label: check.label,
            status: "passed" as const,
            detail: "The worker claims the declared check passed.",
            reference: `codex-item:thread-live-session-test/${check.checkId}`,
          }),
        ),
        failures: [],
        unresolved: [
          "Decide whether recurring storage costs need a separate row.",
        ],
        completionClaim: {
          claimedDone: true,
          criteriaClaimedSatisfied: request.brief.doneMeans.map(() => true),
        },
        candidateReconciliationSummary:
          "Stage the exact sealed candidate for independent validation.",
      },
      sdkObservations: {
        fileChanges: [
          {
            itemId: "item-live-file",
            path: LIVE_EVIDENCE_ARTIFACT_PATH,
            kind: "update",
            status: "completed",
          },
        ],
        commands: [
          {
            itemId: "item-live-command",
            command: LIVE_EVIDENCE_TEST_COMMAND,
            status: "completed",
            exitCode: 0,
          },
        ],
      },
      artifactCandidate: candidate,
    },
  });
}

function passingLiveEvidence(
  request: LiveEvidenceRequest,
): LiveEvidenceResponse {
  const candidate = request.candidateReceipt.metadata;
  const commandOutput = {
    observedDigest: `sha256:${"5".repeat(64)}`,
    observedByteLength: 0,
    excerpt: "",
    excerptByteLength: 0,
    truncated: false,
  };
  return LiveEvidenceResponseSchema.parse({
    ok: true,
    status: "passed",
    verifier: {
      identity: LIVE_EVIDENCE_VERIFIER_IDENTITY,
      version: 1,
      kind: "independent_live_candidate",
    },
    bindings: {
      validationRequestId: request.validationRequestId,
      validationId: request.validationId,
      closureId: request.closureId,
      runId: request.runId,
      briefId: request.briefId,
      baseRevisionId: request.baseRevisionId,
      artifactBaseRef: request.artifactBaseRef,
      exchangeSourceId: request.exchangeSourceId,
      artifactCandidateId: request.artifactCandidateId,
      artifactCandidateCommit: request.artifactCandidateCommit,
    },
    candidate: {
      candidateId: candidate.candidateId,
      candidateRef: candidate.candidateRef,
      repositoryId: candidate.repositoryId,
      targetRef: candidate.targetRef,
      baseCommit: candidate.git.baseCommit,
      candidateCommit: candidate.git.candidateCommit,
      candidateTree: candidate.git.candidateTree,
      manifestDigest: candidate.manifest.digest,
      patchDigest: candidate.patch.digest,
      receiptKeyId: request.candidateReceipt.signature.keyId,
    },
    observedAt: NOW,
    observations: request.evidenceRequirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      result: "passed" as const,
      evidenceRef: `live-candidate://${candidate.candidateId}/${requirement.requirementId}`,
      detail: "Independently observed against the exact sealed candidate.",
      artifact:
        requirement.kind === "artifact"
          ? {
              path: LIVE_EVIDENCE_ARTIFACT_PATH,
              blob: candidate.manifest.entries[0]!.newBlob,
              byteLength: 128,
            }
          : null,
      execution:
        requirement.kind === "test"
          ? {
              declaredCommand: LIVE_EVIDENCE_TEST_COMMAND,
              executionKind: "sandboxed_candidate",
              runnerId: LIVE_EVIDENCE_RUNNER_ID,
              exitCode: 0,
              termination: "exited",
              stdout: commandOutput,
              stderr: commandOutput,
              harness: testLiveEvidenceHarnessObservation(),
            }
          : null,
    })),
  });
}

function promotedReceipt(input: {
  readonly promotionId: string;
  readonly candidateId: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly expectedBaseCommit: string;
  readonly candidateCommit: string;
}) {
  return ArtifactPromotionReceiptSchema.parse({
    kind: "odeu.git-artifact-promotion-status",
    version: 1,
    ...input,
    authorityIntentDigest: `sha256:${"8".repeat(64)}`,
    attemptedAt: NOW,
    observedAt: NOW,
    outcome: "promoted",
    observedRefBefore: input.expectedBaseCommit,
    observedRefAfter: input.candidateCommit,
    detailCode: "cas_updated",
    detail:
      "The authoritative target ref atomically advanced to the exact signed candidate.",
    signature: {
      algorithm: "hmac-sha256",
      keyId: "artifact-key-live-session-test",
      digest: `hmac-sha256:${"6".repeat(64)}`,
    },
  });
}

function outcomeUnknownReceipt(
  input: Parameters<typeof promotedReceipt>[0],
) {
  return ArtifactPromotionReceiptSchema.parse({
    ...promotedReceipt(input),
    outcome: "outcome_unknown",
    observedRefBefore: input.expectedBaseCommit,
    observedRefAfter: input.expectedBaseCommit,
    detailCode: "status_recovery_conflict",
    detail:
      "The durable one-shot attempt exists, but its Git outcome cannot be established safely.",
    signature: {
      algorithm: "hmac-sha256",
      keyId: "artifact-key-live-session-test",
      digest: `hmac-sha256:${"7".repeat(64)}`,
    },
  });
}

describe("durable live delegation session", () => {
  it("keeps promotion separate and gates reset on exact ephemeral host receipt attestation", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const authorize = vi.fn(async ({ document, runId, requestId }) =>
      authorizedCodexRunRequest({
        state: worldstateStateFromLedgerDocument(document),
        runId,
        requestId,
        secret: "live-session-authority-secret",
        now: new Date(NOW),
        nonce: "00000000-0000-4000-8000-000000000123",
      }),
    );
    const agent = vi.fn(async (request: AgentRunRequest) => {
      const durable = await store.get(HOME_MOVE_IDS.project);
      const exactAttempt = durable?.events.findLast(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunAttemptSource(event.payload.source)?.request
            .requestId === request.requestId,
      );
      expect(exactAttempt).toBeDefined();
      expect(request.authorization).not.toBeNull();
      return returnedLiveResponse(request);
    });
    const verifier = vi.fn(async (request: LiveEvidenceRequest) => {
      const durable = await store.get(HOME_MOVE_IDS.project);
      const exactAttempt = durable?.events.findLast(
        (event) =>
          event.type === "source.captured" &&
          parseLiveEvidenceValidationAttemptSource(event.payload.source)
            ?.request.validationRequestId === request.validationRequestId,
      );
      expect(exactAttempt).toBeDefined();
      return passingLiveEvidence(request);
    });
    let serverPromotionReceipt: ReturnType<typeof promotedReceipt> | null = null;
    let promotionCommandCount = 0;
    const promote = vi.fn(async ({ document, promotionId }) => {
      const state = worldstateStateFromLedgerDocument(document);
      const projection = state.operational.artifactPromotions[promotionId];
      expect(projection?.status).toBe("authorized");
      const proposal = projection!.proposal;
      serverPromotionReceipt = promotedReceipt({
        promotionId,
        candidateId: proposal.candidateId,
        repositoryId: proposal.repositoryId,
        targetRef: proposal.targetRef,
        expectedBaseCommit: proposal.expectedBaseCommit,
        candidateCommit: proposal.candidateCommit,
      });
      promotionCommandCount += 1;
      if (promotionCommandCount === 1) {
        return {
          ok: true as const,
          status: "outcome_unknown" as const,
          promotionId,
          receipt: null,
        };
      }
      throw new Error("The browser did not observe the promotion response.");
    });
    let promotionStatusReadCount = 0;
    const promotionStatus = vi.fn(async ({ promotionId }) => {
      promotionStatusReadCount += 1;
      if (promotionStatusReadCount === 1) {
        return {
          ok: true as const,
          status: "attempt_only" as const,
          promotionId,
          receipt: null,
        };
      }
      return {
        ok: true as const,
        status: "completed" as const,
        promotionId,
        receipt: serverPromotionReceipt,
      };
    });
    const session = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: agent,
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveAuthorizationGateway: authorize,
      liveEvidenceGateway: verifier,
      artifactPromotionGateway: promote,
      artifactPromotionStatusGetter: promotionStatus,
      now: () => NOW,
      nextId: deterministicIds(),
    });

    await session.initialize();
    await session.captureAndPlace(
      "Ask Codex to add a simple moving-cost comparison tool to my relocation project.",
    );
    await session.acceptActivePlacement();
    const semanticBase = session.getSnapshot().state!.canonical.head.id;
    await session.prepareActiveAgentBrief();
    expect(
      session.getSnapshot().state!.operational.briefs[
        session.getSnapshot().activeBriefId!
      ]!.executionMode,
    ).toBe("live");

    await session.authorizeAndDispatchActiveBrief();
    const returned = session.getSnapshot();
    expect(authorize).toHaveBeenCalledOnce();
    expect(agent).toHaveBeenCalledOnce();
    expect(returned.state!.canonical.head.id).toBe(semanticBase);
    expect(
      returned.state!.operational.closures[returned.activeClosureId!],
    ).toMatchObject({
      mode: "live",
      artifactCandidateId: expect.stringMatching(/^artifact-candidate:sha256:/),
      artifactCandidateCommit: "c".repeat(40),
    });
    expect(
      returned.ledger!.events.some(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunExchangeSource(event.payload.source)?.request.mode ===
            "live",
      ),
    ).toBe(true);

    await session.validateActiveEvidence();
    const validated = session.getSnapshot();
    expect(verifier).toHaveBeenCalledOnce();
    expect(validated.state!.canonical.head.id).toBe(semanticBase);
    expect(
      validated.ledger!.events.some(
        (event) =>
          event.type === "source.captured" &&
          parseLiveEvidenceValidationExchangeSource(event.payload.source) !==
            null,
      ),
    ).toBe(true);

    await session.proposeActiveReconciliation();
    const proposal = session.getSnapshot();
    const receipt = proposal
      .ledger!.events.filter((event) => event.type === "source.captured")
      .map((event) =>
        parseResultReconciliationArtifactSource(event.payload.source),
      )
      .find((candidate) => candidate !== null);
    expect(receipt).toMatchObject({
      verificationScope: "sealed_live_candidate",
      causalExecutionEstablished: true,
      causalAuthorshipEstablished: false,
      artifactPromotion: "not_performed",
    });
    expect(proposal.state!.canonical.head.id).toBe(semanticBase);

    await session.integrateActiveReconciliation();
    const integrated = session.getSnapshot();
    expect(integrated.state!.canonical.head.id).not.toBe(semanticBase);
    expect(integrated.state!.operational.artifactPromotions).toEqual({});
    const integratedHead = integrated.state!.canonical.head.id;

    await session.proposeActiveArtifactPromotion();
    const promotionProposal = session.getSnapshot();
    expect(promotionProposal.activeArtifactPromotionId).toMatch(
      /^artifact-promotion:sha256:/,
    );
    expect(promotionProposal.state!.canonical.head.id).toBe(integratedHead);
    expect(
      promotionProposal.state!.operational.artifactPromotions[
        promotionProposal.activeArtifactPromotionId!
      ]!.status,
    ).toBe("proposed");
    expect(promote).not.toHaveBeenCalled();

    await session.promoteActiveArtifact();
    const unknown = session.getSnapshot();
    expect(promote).toHaveBeenCalledOnce();
    expect(promotionStatus).toHaveBeenCalledOnce();
    expect(
      unknown.state!.operational.artifactPromotions[
        unknown.activeArtifactPromotionId!
      ],
    ).toMatchObject({ status: "authorized" });
    expect(
      unknown.state!.operational.artifactPromotions[
        unknown.activeArtifactPromotionId!
      ]!.latestOutcome,
    ).toBeUndefined();
    expect(unknown.error).toMatchObject({
      code: "artifact_promotion_outcome_unknown",
      retryable: true,
    });
    expect(
      unknown.ledger!.events.some(
        (event) =>
          event.type === "source.captured" &&
          event.payload.source.id ===
            `source-artifact-promotion-response:${unknown.activeArtifactPromotionId}`,
      ),
    ).toBe(false);

    await session.resetSandbox();
    const resetBlocked = session.getSnapshot();
    expect(resetBlocked.error).toMatchObject({
      code: "artifact_promotion_reservation_active",
      scope: "reset",
    });
    expect(
      resetBlocked.state!.operational.artifactPromotions[
        resetBlocked.activeArtifactPromotionId!
      ]?.status,
    ).toBe("authorized");

    await session.promoteActiveArtifact();
    const promoted = session.getSnapshot();
    expect(promote).toHaveBeenCalledTimes(2);
    expect(promotionStatus).toHaveBeenCalledTimes(2);
    expect(promoted.state!.canonical.head.id).toBe(integratedHead);
    expect(
      promoted.state!.operational.artifactPromotions[
        promoted.activeArtifactPromotionId!
      ],
    ).toMatchObject({
      status: "promoted",
      latestOutcome: {
        observedTargetCommit: "c".repeat(40),
      },
    });
    expect(
      promoted.hostAttestedArtifactPromotionReceiptDigests?.[
        promoted.activeArtifactPromotionId!
      ],
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    const promotedView = buildWorkbenchViewModel({
      ledger: promoted.ledger!,
      state: promoted.state!,
      persistence: { state: "saved", detail: "Saved." },
      workOperation: {
        state: "idle",
        activeArtifactPromotionId: promoted.activeArtifactPromotionId,
        hostAttestedArtifactPromotionReceiptDigests:
          promoted.hostAttestedArtifactPromotionReceiptDigests,
      },
    });
    expect(promotedView.work.artifactPromotion.state).toBe("promoted");

    const mismatchedAttestationView = buildWorkbenchViewModel({
      ledger: promoted.ledger!,
      state: promoted.state!,
      persistence: { state: "saved", detail: "Saved." },
      workOperation: {
        state: "idle",
        activeArtifactPromotionId: promoted.activeArtifactPromotionId,
        hostAttestedArtifactPromotionReceiptDigests: {
          [promoted.activeArtifactPromotionId!]: `sha256:${"0".repeat(64)}`,
        },
      },
    });
    expect(mismatchedAttestationView.work.artifactPromotion.state).toBe(
      "unattested",
    );

    const unattestedReload = createWorldstateSession({
      store,
      placementGateway,
      artifactPromotionStatusGetter: async ({ promotionId }) => ({
        ok: true as const,
        status: "absent" as const,
        promotionId,
        receipt: null,
      }),
      now: () => NOW,
      nextId: deterministicIds(),
    });
    await unattestedReload.initialize();
    expect(
      unattestedReload.getSnapshot().state!.operational.artifactPromotions[
        promoted.activeArtifactPromotionId!
      ]?.status,
    ).toBe("promoted");
    expect(
      unattestedReload.getSnapshot()
        .hostAttestedArtifactPromotionReceiptDigests?.[
        promoted.activeArtifactPromotionId!
      ],
    ).toBeUndefined();

    await unattestedReload.resetSandbox();
    expect(unattestedReload.getSnapshot().error).toMatchObject({
      code: "artifact_promotion_terminal_unattested",
      retryable: true,
      scope: "reset",
    });
    expect(
      unattestedReload.getSnapshot().state!.operational.artifactPromotions[
        promoted.activeArtifactPromotionId!
      ]?.status,
    ).toBe("promoted");

    let sameTabStatusAvailable = true;
    const sameTabStore = createMemoryWorldstateLedgerStore([
      promoted.document!,
    ]);
    const sameTabReload = createWorldstateSession({
      store: sameTabStore,
      placementGateway,
      artifactPromotionStatusGetter: async ({ promotionId }) =>
        sameTabStatusAvailable
          ? {
              ok: true as const,
              status: "completed" as const,
              promotionId,
              receipt: serverPromotionReceipt,
            }
          : {
              ok: true as const,
              status: "absent" as const,
              promotionId,
              receipt: null,
            },
      now: () => NOW,
      nextId: deterministicIds(),
    });
    await sameTabReload.initialize();
    expect(
      sameTabReload.getSnapshot()
        .hostAttestedArtifactPromotionReceiptDigests?.[
        promoted.activeArtifactPromotionId!
      ],
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    sameTabStatusAvailable = false;
    await sameTabReload.initialize();
    expect(
      sameTabReload.getSnapshot()
        .hostAttestedArtifactPromotionReceiptDigests?.[
        promoted.activeArtifactPromotionId!
      ],
    ).toBeUndefined();
    await sameTabReload.resetSandbox();
    expect(sameTabReload.getSnapshot().error).toMatchObject({
      code: "artifact_promotion_terminal_unattested",
      scope: "reset",
    });

    const attestedResetStore = createMemoryWorldstateLedgerStore([
      promoted.document!,
    ]);
    const attestedReset = createWorldstateSession({
      store: attestedResetStore,
      placementGateway,
      artifactPromotionStatusGetter: async ({ promotionId }) => ({
        ok: true as const,
        status: "completed" as const,
        promotionId,
        receipt: serverPromotionReceipt,
      }),
      now: () => NOW,
      nextId: deterministicIds(),
    });
    await attestedReset.initialize();
    expect(
      attestedReset.getSnapshot()
        .hostAttestedArtifactPromotionReceiptDigests?.[
        promoted.activeArtifactPromotionId!
      ],
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    await attestedReset.resetSandbox();
    expect(attestedReset.getSnapshot().error).toBeNull();
    expect(
      attestedReset.getSnapshot().state!.operational.artifactPromotions,
    ).toEqual({});

    const authorizedProjection =
      unknown.state!.operational.artifactPromotions[
        unknown.activeArtifactPromotionId!
      ]!;
    const durableUnknownReceipt = outcomeUnknownReceipt({
      promotionId: unknown.activeArtifactPromotionId!,
      candidateId: authorizedProjection.proposal.candidateId,
      repositoryId: authorizedProjection.proposal.repositoryId,
      targetRef: authorizedProjection.proposal.targetRef,
      expectedBaseCommit: authorizedProjection.proposal.expectedBaseCommit,
      candidateCommit: authorizedProjection.proposal.candidateCommit,
    });
    const outcomeUnknownStore = createMemoryWorldstateLedgerStore([
      unknown.document!,
    ]);
    const attestedOutcomeUnknown = createWorldstateSession({
      store: outcomeUnknownStore,
      placementGateway,
      artifactPromotionStatusGetter: async ({ promotionId }) => ({
        ok: true as const,
        status: "completed" as const,
        promotionId,
        receipt: durableUnknownReceipt,
      }),
      now: () => NOW,
      nextId: deterministicIds(),
    });
    await attestedOutcomeUnknown.initialize();
    expect(
      attestedOutcomeUnknown.getSnapshot().state!.operational
        .artifactPromotions[unknown.activeArtifactPromotionId!]?.status,
    ).toBe("outcome_unknown");
    expect(
      attestedOutcomeUnknown.getSnapshot()
        .hostAttestedArtifactPromotionReceiptDigests?.[
        unknown.activeArtifactPromotionId!
      ],
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    await attestedOutcomeUnknown.resetSandbox();
    expect(attestedOutcomeUnknown.getSnapshot().error).toMatchObject({
      code: "artifact_promotion_reservation_active",
      retryable: false,
      scope: "reset",
    });
    expect(
      attestedOutcomeUnknown.getSnapshot().state!.operational
        .artifactPromotions[unknown.activeArtifactPromotionId!]?.status,
    ).toBe("outcome_unknown");
  });

  it("recovers a server-durable live response after browser transport loss without redispatch", async () => {
    const store = createMemoryWorldstateLedgerStore();
    let serverResponse: AgentRunResponse | null = null;
    const authorize = async ({
      document,
      runId,
      requestId,
    }: BrowserLiveAuthorizationInput) =>
      authorizedCodexRunRequest({
        state: worldstateStateFromLedgerDocument(document),
        runId,
        requestId,
        secret: "live-session-recovery-secret",
        now: new Date(NOW),
        nonce: "00000000-0000-4000-8000-000000000124",
      });
    const interruptedAgent = vi.fn(async (request: AgentRunRequest) => {
      serverResponse = returnedLiveResponse(request);
      throw new Error(
        "The browser did not observe the completed HTTP response.",
      );
    });
    const first = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: interruptedAgent,
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveAuthorizationGateway: authorize,
      now: () => NOW,
      nextId: deterministicIds(),
    });
    await first.initialize();
    await first.captureAndPlace(
      "Ask Codex to add a simple moving-cost comparison tool to my relocation project.",
    );
    await first.acceptActivePlacement();
    await first.prepareActiveAgentBrief();
    await first.authorizeAndDispatchActiveBrief();

    const interrupted = first.getSnapshot();
    expect(interruptedAgent).toHaveBeenCalledOnce();
    expect(serverResponse).not.toBeNull();
    expect(
      interrupted.state!.operational.runs[interrupted.activeRunId!]!.status,
    ).toBe("queued");
    expect(interrupted.activeClosureId).toBeNull();

    const replacementAgent = vi.fn(async () => {
      throw new Error("Reload recovery must not redispatch Codex.");
    });
    const status = vi.fn(async () => ({
      status: "completed" as const,
      response: serverResponse,
    }));
    const reloaded = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: replacementAgent,
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveRunStatusGetter: status,
      now: () => NOW,
      nextId: deterministicIds(),
    });
    await reloaded.initialize();

    expect(status).toHaveBeenCalledOnce();
    expect(replacementAgent).not.toHaveBeenCalled();
    expect(reloaded.getSnapshot()).toMatchObject({
      activeClosureId: expect.any(String),
      error: null,
    });
    expect(
      reloaded.getSnapshot().state!.operational.runs[
        reloaded.getSnapshot().activeRunId!
      ]!.status,
    ).toBe("returned");
  });

  it("retries an exact durable live request only after the server confirms dispatch never started", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const nextId = deterministicIds();
    let originalRequest: AgentRunRequest | null = null;
    const authorize = async ({
      document,
      runId,
      requestId,
    }: BrowserLiveAuthorizationInput) =>
      authorizedCodexRunRequest({
        state: worldstateStateFromLedgerDocument(document),
        runId,
        requestId,
        secret: "live-session-not-started-secret",
        now: new Date(NOW),
        nonce: "00000000-0000-4000-8000-000000000125",
      });
    const interruptedAgent = vi.fn(async (request: AgentRunRequest) => {
      originalRequest = request;
      throw new Error("The request did not reach the private executor.");
    });
    const status = vi.fn(async () => ({
      status: "not_started" as const,
      response: null,
    }));
    const first = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: interruptedAgent,
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveAuthorizationGateway: authorize,
      liveRunStatusGetter: status,
      now: () => NOW,
      nextId,
    });
    await first.initialize();
    await first.captureAndPlace(
      "Ask Codex to add a simple moving-cost comparison tool to my relocation project.",
    );
    await first.acceptActivePlacement();
    await first.prepareActiveAgentBrief();
    await first.authorizeAndDispatchActiveBrief();

    expect(interruptedAgent).toHaveBeenCalledOnce();
    expect(originalRequest).not.toBeNull();
    expect(
      first.getSnapshot().state!.operational.runs[
        first.getSnapshot().activeRunId!
      ]!.status,
    ).toBe("queued");
    expect(first.getSnapshot().error).toMatchObject({
      code: "delegation_not_started",
      retryable: true,
    });

    const replacementAgent = vi.fn(async (request: AgentRunRequest) =>
      returnedLiveResponse(request),
    );
    const reloaded = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: replacementAgent,
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveRunStatusGetter: status,
      now: () => NOW,
      nextId,
    });
    await reloaded.initialize();

    expect(reloaded.getSnapshot().error).toMatchObject({
      code: "delegation_not_started",
      retryable: true,
    });
    expect(replacementAgent).not.toHaveBeenCalled();

    await reloaded.retryActiveLiveDispatch();

    expect(status).toHaveBeenCalledTimes(3);
    expect(replacementAgent).toHaveBeenCalledOnce();
    expect(replacementAgent).toHaveBeenCalledWith(originalRequest);
    expect(reloaded.getSnapshot().error).toBeNull();
    expect(
      reloaded.getSnapshot().state!.operational.runs[
        reloaded.getSnapshot().activeRunId!
      ]!.status,
    ).toBe("returned");

    const durable = await store.get(HOME_MOVE_IDS.project);
    expect(
      durable?.events.filter((event) => event.type === "run.authorized"),
    ).toHaveLength(1);
    expect(
      durable?.events
        .filter((event) => event.type === "source.captured")
        .map((event) => parseCodexRunAttemptSource(event.payload.source))
        .filter((attempt) => attempt !== null),
    ).toHaveLength(1);
  });

  it("keeps a cross-process dispatch rejection nonterminal until a private response is durable", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const nextId = deterministicIds();
    let exactRequest: AgentRunRequest | null = null;
    let serverResponse: AgentRunResponse | null = null;
    const authorize = async ({
      document,
      runId,
      requestId,
    }: BrowserLiveAuthorizationInput) =>
      authorizedCodexRunRequest({
        state: worldstateStateFromLedgerDocument(document),
        runId,
        requestId,
        secret: "live-session-concurrent-dispatch-secret",
        now: new Date(NOW),
        nonce: "00000000-0000-4000-8000-000000000127",
      });
    const boundaryRejection = AgentRunFailureSchema.parse({
      ok: false,
      runtime: {
        requestedMode: "live",
        effectiveMode: null,
        status: "unavailable",
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
      },
      error: {
        code: "authorization_consumed",
        message: "The live request has execution evidence without a response.",
        issues: [],
      },
      briefPreserved: true,
      resumable: false,
      resumeSupported: false,
      blockedRun: null,
    });
    const status = vi.fn(async () =>
      serverResponse
        ? { status: "completed" as const, response: serverResponse }
        : { status: "outcome_unknown" as const, response: null },
    );
    const first = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: vi.fn(async (request: AgentRunRequest) => {
        exactRequest = request;
        return boundaryRejection;
      }),
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveAuthorizationGateway: authorize,
      liveRunStatusGetter: status,
      now: () => NOW,
      nextId,
    });
    await first.initialize();
    await first.captureAndPlace(
      "Ask Codex to add a simple moving-cost comparison tool to my relocation project.",
    );
    await first.acceptActivePlacement();
    await first.prepareActiveAgentBrief();
    await first.authorizeAndDispatchActiveBrief();

    const waiting = first.getSnapshot();
    expect(exactRequest).not.toBeNull();
    expect(waiting.error).toMatchObject({
      code: "delegation_outcome_unknown",
      retryable: false,
    });
    expect(
      waiting.state!.operational.runs[waiting.activeRunId!]!.status,
    ).toBe("queued");
    expect(
      waiting.ledger!.events.some(
        (event) =>
          event.type === "source.captured" &&
          parseCodexRunExchangeSource(event.payload.source) !== null,
      ),
    ).toBe(false);
    expect(
      waiting.ledger!.events.some(
        (event) =>
          event.type === "run.lifecycle_recorded" &&
          event.payload.runId === waiting.activeRunId &&
          event.payload.status === "outcome_unknown",
      ),
    ).toBe(false);

    serverResponse = returnedLiveResponse(exactRequest!);
    const replacementAgent = vi.fn(async () => {
      throw new Error("Status recovery must not issue another dispatch.");
    });
    const reloaded = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: replacementAgent,
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveRunStatusGetter: status,
      now: () => NOW,
      nextId,
    });
    await reloaded.initialize();

    expect(replacementAgent).not.toHaveBeenCalled();
    expect(reloaded.getSnapshot().error).toBeNull();
    expect(
      reloaded.getSnapshot().state!.operational.runs[
        reloaded.getSnapshot().activeRunId!
      ]!.status,
    ).toBe("returned");
  });

  it("normalizes a genuine private failed response instead of the concurrent boundary rejection", async () => {
    const store = createMemoryWorldstateLedgerStore();
    const nextId = deterministicIds();
    const privateFailure = AgentRunFailureSchema.parse({
      ok: false,
      runtime: {
        requestedMode: "live",
        effectiveMode: "live",
        status: "failed",
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
      },
      error: {
        code: "worker_failed",
        message: "The private worker failed after dispatch.",
        issues: [],
      },
      briefPreserved: true,
      resumable: false,
      resumeSupported: false,
      blockedRun: null,
    });
    const boundaryRejection = AgentRunFailureSchema.parse({
      ...privateFailure,
      runtime: { ...privateFailure.runtime, effectiveMode: null, status: "unavailable" },
      error: {
        code: "run_claim_busy",
        message: "The requested run is already being processed.",
        issues: [],
      },
    });
    const session = createWorldstateSession({
      store,
      placementGateway,
      agentGateway: vi.fn(async () => boundaryRejection),
      agentRuntimeCapabilityGetter: async () => ({
        requestedMode: "live",
        effectiveMode: "live",
        status: "available",
        artifactBaseRef: `git:${BASE_COMMIT}`,
        reason: null,
      }),
      liveAuthorizationGateway: async ({ document, runId, requestId }) =>
        authorizedCodexRunRequest({
          state: worldstateStateFromLedgerDocument(document),
          runId,
          requestId,
          secret: "live-session-private-failure-secret",
          now: new Date(NOW),
          nonce: "00000000-0000-4000-8000-000000000128",
        }),
      liveRunStatusGetter: vi.fn(async () => ({
        status: "completed" as const,
        response: privateFailure,
      })),
      now: () => NOW,
      nextId,
    });
    await session.initialize();
    await session.captureAndPlace(
      "Ask Codex to add a simple moving-cost comparison tool to my relocation project.",
    );
    await session.acceptActivePlacement();
    await session.prepareActiveAgentBrief();
    await session.authorizeAndDispatchActiveBrief();

    const failed = session.getSnapshot();
    expect(
      failed.state!.operational.runs[failed.activeRunId!]!.status,
    ).toBe("failed");
    const exchange = failed.ledger!.events
      .filter((event) => event.type === "source.captured")
      .map((event) => parseCodexRunExchangeSource(event.payload.source))
      .find((candidate) => candidate !== null);
    expect(exchange?.response).toEqual(privateFailure);
    expect(exchange?.response).not.toEqual(boundaryRejection);
  });
});
