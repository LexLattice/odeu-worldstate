import { describe, expect, it } from "vitest";

import { ArtifactCandidateReceiptSchema } from "@/adapters/artifact-promotion/schema";
import { AgentRunSuccessSchema } from "@/adapters/codex/schema";
import { LiveEvidenceSuccessSchema } from "@/adapters/live-evidence";
import {
  LIVE_EVIDENCE_RUNNER_ID,
} from "@/adapters/live-evidence/schema";
import { testLiveEvidenceHarnessObservation } from "@/adapters/live-evidence/test-observation";
import {
  appendLedgerEvent,
  buildDeltaAcceptedEvent,
  fingerprint,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  sourceCapturedEvent,
  stableStringify,
  type AgentRun,
  type LedgerEvent,
  type WorldstateLedger,
} from "@/domain";
import { createPrivateProjectionFixture, HOME_MOVE_ACTORS } from "@/fixtures";
import { authorizedCodexRunRequest } from "@/integration/authorized-codex-run";
import {
  codexRunResponseEvents,
  parseCodexRunExchangeSource,
} from "@/integration/codex-run-evidence";
import {
  INDEPENDENT_LIVE_VALIDATOR_ACTOR,
  compileLiveEvidenceRequest,
  liveEvidenceValidationAttemptSourceEvent,
  liveEvidenceValidationExchangeSourceEvent,
  liveEvidenceValidationRecordedEvent,
} from "@/integration/live-evidence-validation";
import {
  resultReconciliationDeltaId,
  resultReconciliationProposalEvents,
} from "@/integration/validated-closure-to-reconciliation";

import {
  ArtifactPromotionCompilationError,
  artifactPromotionAuthorizationEvents,
  artifactPromotionOutcomeEvents,
  artifactPromotionProposalEvents,
  artifactPromotionProposalSourceId,
  assertArtifactPromotionProposalMatchesCurrentState,
  compileArtifactPromotionProposal,
  parseArtifactPromotionProposalSource,
  parseArtifactPromotionRequestSource,
  parseArtifactPromotionResponseSource,
  resolveAuthorizedArtifactPromotion,
} from "./artifact-promotion";
import { artifactPromotionId } from "@/adapters/artifact-promotion/identity";

const BASE_COMMIT = "a".repeat(40);
const CANDIDATE_COMMIT = "c".repeat(40);
const ARTIFACT_BLOB = "1".repeat(40);
const NOW = "2026-07-18T13:00:00.000Z";

function append(ledger: WorldstateLedger, event: LedgerEvent): WorldstateLedger {
  return appendLedgerEvent(ledger, event).ledger;
}

function candidateReceipt(input: {
  readonly runId: string;
  readonly briefId: string;
  readonly baseRevisionId: string;
}) {
  return ArtifactCandidateReceiptSchema.parse({
    metadata: {
      kind: "odeu.git-artifact-candidate",
      version: 1,
      candidateId: `artifact-candidate:sha256:${"b".repeat(64)}`,
      candidateRef: `refs/odeu/candidates/${"b".repeat(64)}`,
      repositoryId: "repository-odeu-worldstate",
      targetRef: "refs/heads/main",
      runId: input.runId,
      briefId: input.briefId,
      baseRevisionId: input.baseRevisionId,
      sealedAt: "2026-07-18T12:00:03.000Z",
      git: {
        objectFormat: "sha1",
        baseCommit: BASE_COMMIT,
        baseTree: "d".repeat(40),
        candidateCommit: CANDIDATE_COMMIT,
        candidateTree: "e".repeat(40),
      },
      patch: {
        format: "git-binary-diff-v1",
        digest: `sha256:${"2".repeat(64)}`,
        byteLength: 512,
      },
      manifest: {
        digest: `sha256:${"3".repeat(64)}`,
        entries: [
          {
            path: "demo/moving-costs.html",
            status: "modified",
            oldMode: "100644",
            newMode: "100644",
            oldBlob: "0".repeat(40),
            newBlob: ARTIFACT_BLOB,
          },
        ],
      },
    },
    signature: {
      algorithm: "hmac-sha256",
      keyId: "artifact-key-v1",
      digest: `hmac-sha256:${"4".repeat(64)}`,
    },
  });
}

function liveResponse(input: {
  readonly request: ReturnType<typeof authorizedCodexRunRequest>;
  readonly receipt: ReturnType<typeof candidateReceipt>;
}) {
  return AgentRunSuccessSchema.parse({
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
        at: "2026-07-18T12:00:00.000Z",
        label: "Queued",
        detail: "Authorized.",
      },
      {
        sequence: 1,
        status: "received",
        at: "2026-07-18T12:00:01.000Z",
        label: "Received",
        detail: "Received.",
      },
      {
        sequence: 2,
        status: "working",
        at: "2026-07-18T12:00:02.000Z",
        label: "Working",
        detail: "Changed artifact.",
      },
      {
        sequence: 3,
        status: "returned",
        at: "2026-07-18T12:00:03.000Z",
        label: "Returned",
        detail: "Staged candidate returned.",
      },
    ],
    closure: {
      runId: input.request.runId,
      briefId: input.request.brief.briefId,
      sourceRevisionIdUsed: input.request.brief.sourceRevisionId,
      artifactBaseRefUsed: input.request.brief.artifactBaseRef,
      workerThreadId: "thread-live-promotion",
      workerItemIds: ["item-file", "item-test"],
      report: {
        outcome: "returned",
        claimedEffects: ["Updated the moving-cost tool."],
        claimedArtifacts: [
          {
            path: "demo/moving-costs.html",
            kind: "updated",
            summary: "Moving-cost tool",
            reference: "artifact:moving-cost-candidate",
          },
        ],
        claimedChecks: input.request.brief.evidenceContract.requiredChecks.map(
          (check) => ({
            checkId: check.checkId,
            label: check.label,
            status: "passed",
            detail: "Reported passed.",
            reference: `worker-claim:${check.checkId}`,
          }),
        ),
        failures: [],
        unresolved: [],
        completionClaim: {
          claimedDone: true,
          criteriaClaimedSatisfied: input.request.brief.doneMeans.map(() => true),
        },
        candidateReconciliationSummary: "Review the exact staged candidate.",
      },
      sdkObservations: {
        fileChanges: [
          {
            itemId: "item-file",
            path: "demo/moving-costs.html",
            kind: "update",
            status: "completed",
          },
        ],
        commands: [
          {
            itemId: "item-test",
            command: "npm test -- moving-cost",
            status: "completed",
            exitCode: 0,
          },
        ],
      },
      artifactCandidate: input.receipt,
    },
  });
}

function independentResponse(
  request: ReturnType<typeof compileLiveEvidenceRequest>,
) {
  const metadata = request.candidateReceipt.metadata;
  return LiveEvidenceSuccessSchema.parse({
    ok: true,
    status: "passed",
    verifier: {
      identity: "odeu-live-candidate-evidence-verifier-v0",
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
      candidateId: metadata.candidateId,
      candidateRef: metadata.candidateRef,
      repositoryId: metadata.repositoryId,
      targetRef: metadata.targetRef,
      baseCommit: metadata.git.baseCommit,
      candidateCommit: metadata.git.candidateCommit,
      candidateTree: metadata.git.candidateTree,
      manifestDigest: metadata.manifest.digest,
      patchDigest: metadata.patch.digest,
      receiptKeyId: request.candidateReceipt.signature.keyId,
    },
    observedAt: "2026-07-18T12:00:06.000Z",
    observations: request.evidenceRequirements.map((requirement) =>
      requirement.kind === "artifact"
        ? {
            requirementId: requirement.requirementId,
            result: "passed",
            evidenceRef: "git-candidate://artifact",
            detail: "Exact candidate blob observed.",
            artifact: {
              path: "demo/moving-costs.html",
              blob: ARTIFACT_BLOB,
              byteLength: 2_048,
            },
            execution: null,
          }
        : {
            requirementId: requirement.requirementId,
            result: "passed",
            evidenceRef: "git-candidate://check",
            detail: "Registered command passed.",
            artifact: null,
            execution: {
              declaredCommand: "npm test -- moving-cost",
              executionKind: "sandboxed_candidate",
              runnerId: LIVE_EVIDENCE_RUNNER_ID,
              exitCode: 0,
              termination: "exited",
              stdout: {
                observedDigest: `sha256:${"5".repeat(64)}`,
                observedByteLength: 2,
                excerpt: "ok",
                excerptByteLength: 2,
                truncated: false,
              },
              stderr: {
                observedDigest: `sha256:${"6".repeat(64)}`,
                observedByteLength: 0,
                excerpt: "",
                excerptByteLength: 0,
                truncated: false,
              },
              harness: testLiveEvidenceHarnessObservation(),
            },
          },
    ),
  });
}

function integratedLiveCandidateFixture() {
  const fixture = createPrivateProjectionFixture({
    executionMode: "live",
    artifactBaseRef: `git:${BASE_COMMIT}`,
  });
  const run: AgentRun = {
    id: "run-live-promotion",
    briefId: fixture.brief.id,
    baseRevisionId: fixture.brief.baseRevisionId,
    artifactBaseRef: fixture.brief.artifactBaseRef,
    mode: "live",
  };
  let ledger = append(
    fixture.ledger,
    runAuthorizedEvent({
      eventId: "event-live-promotion-run",
      commandId: "command-live-promotion-run",
      occurredAt: "2026-07-18T12:00:00.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: { run },
    }),
  );
  const request = authorizedCodexRunRequest({
    state: reduceWorldstateLedger(ledger),
    runId: run.id,
    requestId: "request-live-promotion",
    secret: "test-live-authorization-secret",
    now: new Date("2026-07-18T12:00:00.000Z"),
    nonce: "00000000-0000-4000-8000-000000000001",
  });
  const receipt = candidateReceipt({
    runId: run.id,
    briefId: fixture.brief.id,
    baseRevisionId: fixture.brief.baseRevisionId,
  });
  const response = liveResponse({ request, receipt });
  for (const event of codexRunResponseEvents({
    run,
    brief: fixture.brief,
    request,
    response,
    recordedAt: "2026-07-18T12:00:04.000Z",
    systemActor: HOME_MOVE_ACTORS.system,
  })) {
    ledger = append(ledger, event);
  }
  const returned = reduceWorldstateLedger(ledger);
  const closure = Object.values(returned.operational.closures).find(
    (candidate) => candidate.runId === run.id,
  );
  const codexExchange = Object.values(returned.operational.sources)
    .map(parseCodexRunExchangeSource)
    .find((candidate) => candidate?.request.runId === run.id);
  if (!closure || !codexExchange) throw new Error("Missing returned live lineage.");
  const validationRequest = compileLiveEvidenceRequest({
    validationRequestId: "request-independent-live-promotion",
    validationId: "validation-independent-live-promotion",
    run,
    brief: fixture.brief,
    closure,
    codexExchange,
  });
  const validationResponse = independentResponse(validationRequest);
  ledger = append(
    ledger,
    liveEvidenceValidationAttemptSourceEvent({
      request: validationRequest,
      eventId: "event-independent-live-promotion-attempt",
      commandId: "command-independent-live-promotion-attempt",
      occurredAt: "2026-07-18T12:00:05.000Z",
      actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
    }),
  );
  ledger = append(
    ledger,
    liveEvidenceValidationExchangeSourceEvent({
      request: validationRequest,
      response: validationResponse,
      eventId: "event-independent-live-promotion-exchange",
      commandId: "command-independent-live-promotion-exchange",
      occurredAt: "2026-07-18T12:00:06.000Z",
      actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
    }),
  );
  ledger = append(
    ledger,
    liveEvidenceValidationRecordedEvent({
      state: reduceWorldstateLedger(ledger),
      request: validationRequest,
      response: validationResponse,
      eventId: "event-independent-live-promotion-recorded",
      commandId: "command-independent-live-promotion-recorded",
      occurredAt: "2026-07-18T12:00:07.000Z",
      actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
    }),
  );
  const validated = reduceWorldstateLedger(ledger);
  const deltaId = resultReconciliationDeltaId({
    closureId: closure.id,
    validationId: validationRequest.validationId,
    baseRevisionId: validated.canonical.head.id,
  });
  for (const event of resultReconciliationProposalEvents({
    state: validated,
    closureId: closure.id,
    validationId: validationRequest.validationId,
    deltaId,
    occurredAt: "2026-07-18T12:00:08.000Z",
    systemActor: HOME_MOVE_ACTORS.system,
  })) {
    ledger = append(ledger, event);
  }
  ledger = append(
    ledger,
    buildDeltaAcceptedEvent(reduceWorldstateLedger(ledger), {
      eventId: "event-live-promotion-reconciliation-accepted",
      commandId: "command-live-promotion-reconciliation-accepted",
      occurredAt: "2026-07-18T12:00:09.000Z",
      actor: HOME_MOVE_ACTORS.human,
      deltaId,
      artifactBaseRef: fixture.brief.artifactBaseRef,
    }),
  );
  return { ledger, deltaId, receipt };
}

function proposedFixture() {
  const integrated = integratedLiveCandidateFixture();
  const state = reduceWorldstateLedger(integrated.ledger);
  const events = artifactPromotionProposalEvents({
    state,
    reconciliationDeltaId: integrated.deltaId,
    sourceEventId: "event-artifact-promotion-proposal-source",
    sourceCommandId: "command-artifact-promotion-proposal-source",
    eventId: "event-artifact-promotion-proposed",
    commandId: "command-artifact-promotion-proposed",
    occurredAt: NOW,
    systemActor: HOME_MOVE_ACTORS.system,
  });
  let ledger = integrated.ledger;
  for (const event of events) ledger = append(ledger, event);
  return { ...integrated, ledger, proposal: events[1].payload.proposal };
}

function authorizedFixture() {
  const proposed = proposedFixture();
  const events = artifactPromotionAuthorizationEvents({
    state: reduceWorldstateLedger(proposed.ledger),
    promotionId: proposed.proposal.id,
    sourceEventId: "event-artifact-promotion-request-source",
    sourceCommandId: "command-artifact-promotion-request-source",
    authorizationEventId: "event-artifact-promotion-authorized",
    authorizationCommandId: "command-artifact-promotion-authorized",
    occurredAt: "2026-07-18T13:00:01.000Z",
    systemActor: HOME_MOVE_ACTORS.system,
    humanActor: HOME_MOVE_ACTORS.human,
  });
  let ledger = proposed.ledger;
  for (const event of events) ledger = append(ledger, event);
  return { ...proposed, ledger };
}

function promotedReceipt(proposal: ReturnType<typeof proposedFixture>["proposal"]) {
  return {
    kind: "odeu.git-artifact-promotion-status" as const,
    version: 1 as const,
    promotionId: proposal.id,
    candidateId: proposal.candidateId,
    repositoryId: proposal.repositoryId,
    targetRef: proposal.targetRef,
    expectedBaseCommit: proposal.expectedBaseCommit,
    candidateCommit: proposal.candidateCommit,
    authorityIntentDigest: `sha256:${"8".repeat(64)}`,
    attemptedAt: "2026-07-18T13:00:02.000Z",
    observedAt: "2026-07-18T13:00:03.000Z",
    outcome: "promoted" as const,
    observedRefBefore: proposal.expectedBaseCommit,
    observedRefAfter: proposal.candidateCommit,
    detailCode: "cas_updated" as const,
    detail: "The configured target atomically advanced to the exact candidate.",
    signature: {
      algorithm: "hmac-sha256" as const,
      keyId: "artifact-key-v1",
      digest: `hmac-sha256:${"7".repeat(64)}`,
    },
  };
}

describe("artifact promotion integration boundary", () => {
  it("compiles the deterministic ID only from an accepted exact live candidate", () => {
    const fixture = integratedLiveCandidateFixture();
    const state = reduceWorldstateLedger(fixture.ledger);
    const proposal = compileArtifactPromotionProposal(state, {
      reconciliationDeltaId: fixture.deltaId,
    });

    expect(proposal.id).toBe(
      artifactPromotionId({
        candidateId: proposal.candidateId,
        repositoryId: proposal.repositoryId,
        targetRef: proposal.targetRef,
        expectedBaseCommit: proposal.expectedBaseCommit,
        candidateCommit: proposal.candidateCommit,
      }),
    );
    expect(proposal.proposalSourceId).toBe(
      artifactPromotionProposalSourceId(proposal.id),
    );
    expect(proposal.changedPaths).toEqual([
      { path: "demo/moving-costs.html", status: "modified" },
    ]);
  });

  it("persists the integrity-bound proposal before its manager event", () => {
    const fixture = proposedFixture();
    const state = reduceWorldstateLedger(fixture.ledger);
    const source = state.operational.sources[fixture.proposal.proposalSourceId];

    expect(parseArtifactPromotionProposalSource(source)?.proposal).toEqual(
      fixture.proposal,
    );
    expect(
      assertArtifactPromotionProposalMatchesCurrentState(
        state,
        fixture.proposal.id,
      ),
    ).toEqual(fixture.proposal);
    const sourceIndex = fixture.ledger.events.findIndex(
      (event) => event.eventId === "event-artifact-promotion-proposal-source",
    );
    const proposalIndex = fixture.ledger.events.findIndex(
      (event) => event.eventId === "event-artifact-promotion-proposed",
    );
    expect(sourceIndex).toBeLessThan(proposalIndex);
  });

  it("persists the exact request before human authority and resolves it for CAS", () => {
    const fixture = authorizedFixture();
    const state = reduceWorldstateLedger(fixture.ledger);
    const resolved = resolveAuthorizedArtifactPromotion(
      state,
      fixture.proposal.id,
    );
    const requestSource = state.operational.sources[
      state.operational.artifactPromotions[fixture.proposal.id]!.requestSourceId!
    ];

    expect(parseArtifactPromotionRequestSource(requestSource)).toMatchObject({
      promotionId: fixture.proposal.id,
      integratedRevisionId: fixture.proposal.integratedRevisionId,
      candidateId: fixture.proposal.candidateId,
    });
    expect(resolved.candidate).toEqual(fixture.receipt);
    const requestIndex = fixture.ledger.events.findIndex(
      (event) => event.eventId === "event-artifact-promotion-request-source",
    );
    const authorityIndex = fixture.ledger.events.findIndex(
      (event) => event.eventId === "event-artifact-promotion-authorized",
    );
    expect(requestIndex).toBeLessThan(authorityIndex);
  });

  it("maps the exact signed receipt without mutating semantic truth", () => {
    const fixture = authorizedFixture();
    const before = reduceWorldstateLedger(fixture.ledger);
    const receipt = promotedReceipt(fixture.proposal);
    let ledger = fixture.ledger;
    for (const event of artifactPromotionOutcomeEvents({
      state: before,
      promotionId: fixture.proposal.id,
      receipt,
      sourceEventId: "event-artifact-promotion-response-source",
      sourceCommandId: "command-artifact-promotion-response-source",
      outcomeEventId: "event-artifact-promotion-outcome",
      outcomeCommandId: "command-artifact-promotion-outcome",
      occurredAt: "2026-07-18T13:00:04.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    })) {
      ledger = append(ledger, event);
    }
    const after = reduceWorldstateLedger(ledger);
    const responseSource = after.operational.sources[
      `source-artifact-promotion-response:${fixture.proposal.id}`
    ];

    expect(parseArtifactPromotionResponseSource(responseSource)?.receipt).toEqual(
      receipt,
    );
    expect(after.operational.artifactPromotions[fixture.proposal.id]?.status).toBe(
      "promoted",
    );
    expect(after.canonical.head.id).toBe(before.canonical.head.id);
  });

  it("rejects independently validated candidate substitution and non-human authority", () => {
    const integrated = integratedLiveCandidateFixture();
    const originalState = reduceWorldstateLedger(integrated.ledger);
    const validation = Object.values(originalState.operational.validations).find(
      (candidate) => candidate.id === "validation-independent-live-promotion",
    );
    if (!validation) throw new Error("Missing validation fixture.");
    const source = originalState.operational.sources[validation.evidenceSourceId];
    const artifact = JSON.parse(source.content) as Record<string, unknown>;
    const substituted = {
      ...artifact,
      request: {
        ...(artifact.request as Record<string, unknown>),
        artifactCandidateCommit: "9".repeat(40),
      },
    };
    const sourceEvent = integrated.ledger.events.find(
      (event) =>
        event.type === "source.captured" && event.payload.source.id === source.id,
    );
    if (!sourceEvent || sourceEvent.type !== "source.captured") {
      throw new Error("Missing validator source event.");
    }
    const replaced = sourceCapturedEvent({
      ...sourceEvent,
      payload: {
        source: {
          ...source,
          content: stableStringify(substituted),
          integrity: {
            algorithm: "fnv1a64",
            digest: fingerprint(substituted),
          },
        },
      },
    });
    const tamperedState = reduceWorldstateLedger({
      ...integrated.ledger,
      events: integrated.ledger.events.map((event) =>
        event.eventId === replaced.eventId ? replaced : event,
      ),
    });
    expect(() =>
      compileArtifactPromotionProposal(tamperedState, {
        reconciliationDeltaId: integrated.deltaId,
      }),
    ).toThrow(ArtifactPromotionCompilationError);

    const proposed = proposedFixture();
    expect(() =>
      artifactPromotionAuthorizationEvents({
        state: reduceWorldstateLedger(proposed.ledger),
        promotionId: proposed.proposal.id,
        sourceEventId: "event-bad-request",
        sourceCommandId: "command-bad-request",
        authorizationEventId: "event-bad-authority",
        authorizationCommandId: "command-bad-authority",
        occurredAt: NOW,
        systemActor: HOME_MOVE_ACTORS.system,
        humanActor: HOME_MOVE_ACTORS.manager,
      }),
    ).toThrow(/explicit human authority/i);
  });
});
