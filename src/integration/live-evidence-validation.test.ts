import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ArtifactCandidateReceiptSchema } from "@/adapters/artifact-promotion/schema";
import { AgentRunSuccessSchema } from "@/adapters/codex/schema";
import {
  LIVE_EVIDENCE_RUNNER_ID,
  LiveEvidenceRequestSchema,
  LiveEvidenceSuccessSchema,
} from "@/adapters/live-evidence";
import { testLiveEvidenceHarnessObservation } from "@/adapters/live-evidence/test-observation";
import {
  appendLedgerEvent,
  fingerprint,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  sourceCapturedEvent,
  stableStringify,
  type AgentRun,
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
  LiveEvidenceValidationAuthorityError,
  LiveEvidenceValidationCoherenceError,
  compileLiveEvidenceRequest,
  liveEvidenceValidationAttemptSourceEvent,
  liveEvidenceValidationExchangeSourceEvent,
  liveEvidenceValidationExchangeSourceId,
  liveEvidenceValidationRecordedEvent,
  parseLiveEvidenceValidationExchangeSource,
} from "./live-evidence-validation";
import {
  assertReconciliationDeltaMatchesCurrentState,
  parseResultReconciliationArtifactSource,
  resultReconciliationDeltaId,
  resultReconciliationProposalEvents,
  resultReconciliationSourceId,
} from "./validated-closure-to-reconciliation";

function append(
  ledger: WorldstateLedger,
  event: Parameters<typeof appendLedgerEvent>[1],
): WorldstateLedger {
  return appendLedgerEvent(ledger, event).ledger;
}

const BASE_COMMIT = "a".repeat(40);
const CANDIDATE_COMMIT = "c".repeat(40);
const ARTIFACT_BLOB = "1".repeat(40);

function candidateReceipt(input: {
  readonly runId: string;
  readonly briefId: string;
  readonly baseRevisionId: string;
  readonly extraChangedPath?: string;
}) {
  return ArtifactCandidateReceiptSchema.parse({
    metadata: {
      kind: "odeu.git-artifact-candidate",
      version: 1,
      candidateId: `artifact-candidate:sha256:${"b".repeat(64)}`,
      candidateRef: "refs/odeu/candidates/run-live-validation",
      repositoryId: "repository-odeu-worldstate",
      targetRef: "refs/heads/main",
      runId: input.runId,
      briefId: input.briefId,
      baseRevisionId: input.baseRevisionId,
      sealedAt: "2026-07-18T11:00:03.000Z",
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
            status: "added",
            oldMode: null,
            newMode: "100644",
            oldBlob: null,
            newBlob: ARTIFACT_BLOB,
          },
          ...(input.extraChangedPath
            ? [
                {
                  path: input.extraChangedPath,
                  status: "added" as const,
                  oldMode: null,
                  newMode: "100644" as const,
                  oldBlob: null,
                  newBlob: "7".repeat(40),
                },
              ]
            : []),
        ],
      },
    },
    signature: {
      algorithm: "hmac-sha256",
      keyId: "artifact-receipt-key-v0",
      digest: `hmac-sha256:${"4".repeat(64)}`,
    },
  });
}

function liveResponse(input: {
  request: ReturnType<typeof authorizedCodexRunRequest>;
  receipt: ReturnType<typeof candidateReceipt>;
}) {
  const { request, receipt } = input;
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
        at: "2026-07-18T11:00:00.000Z",
        label: "Queued",
        detail: "The live request was durably authorized.",
      },
      {
        sequence: 1,
        status: "received",
        at: "2026-07-18T11:00:01.000Z",
        label: "Received",
        detail: "The isolated worker received the brief.",
      },
      {
        sequence: 2,
        status: "working",
        at: "2026-07-18T11:00:02.000Z",
        label: "Working",
        detail: "The isolated worker changed the declared artifact.",
      },
      {
        sequence: 3,
        status: "returned",
        at: "2026-07-18T11:00:03.000Z",
        label: "Returned",
        detail: "The live worker returned a staged candidate.",
      },
    ],
    closure: {
      runId: request.runId,
      briefId: request.brief.briefId,
      sourceRevisionIdUsed: request.brief.sourceRevisionId,
      artifactBaseRefUsed: request.brief.artifactBaseRef,
      workerThreadId: "thread-live-validation",
      workerItemIds: ["item-live-file", "item-live-test"],
      report: {
        outcome: "returned",
        claimedEffects: ["Added the moving-cost comparison tool."],
        claimedArtifacts: [
          {
            path: "demo/moving-costs.html",
            kind: "updated",
            summary: "Moving-cost comparison UI",
            reference: "artifact:demo/moving-costs.html@live-candidate",
          },
        ],
        claimedChecks: request.brief.evidenceContract.requiredChecks.map(
          (check) => ({
            checkId: check.checkId,
            label: check.label,
            status: "passed",
            detail: "The worker reports this check passed.",
            reference: `worker-claim:${check.checkId}`,
          }),
        ),
        failures: [],
        unresolved: ["Recurring storage costs remain a product question."],
        completionClaim: {
          claimedDone: true,
          criteriaClaimedSatisfied: request.brief.doneMeans.map(() => true),
        },
        candidateReconciliationSummary:
          "Review the sealed moving-cost candidate and independent evidence.",
      },
      sdkObservations: {
        fileChanges: [
          {
            itemId: "item-live-file",
            path: "demo/moving-costs.html",
            kind: "update",
            status: "completed",
          },
        ],
        commands: [
          {
            itemId: "item-live-test",
            command: "npm test -- moving-cost",
            status: "completed",
            exitCode: 0,
          },
        ],
      },
      artifactCandidate: receipt,
    },
  });
}

function liveValidationResponse(
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
    observedAt: "2026-07-18T11:00:06.000Z",
    observations: request.evidenceRequirements.map((requirement) =>
      requirement.kind === "artifact"
        ? {
            requirementId: requirement.requirementId,
            result: "passed",
            evidenceRef:
              "git-candidate://repository-odeu-worldstate/candidate/artifact",
            detail: "The exact candidate blob was independently observed.",
            artifact: {
              path: "demo/moving-costs.html",
              blob: ARTIFACT_BLOB,
              byteLength: 2048,
            },
            execution: null,
          }
        : {
            requirementId: requirement.requirementId,
            result: "passed",
            evidenceRef:
              "git-candidate://repository-odeu-worldstate/candidate/check",
            detail: "The registered command passed in the candidate sandbox.",
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

function returnedLiveFixture(
  input: { readonly extraChangedPath?: string } = {},
) {
  const fixture = createPrivateProjectionFixture({
    executionMode: "live",
    artifactBaseRef: `git:${BASE_COMMIT}`,
  });
  const run: AgentRun = {
    id: "run-live-validation",
    briefId: fixture.brief.id,
    baseRevisionId: fixture.brief.baseRevisionId,
    artifactBaseRef: fixture.brief.artifactBaseRef,
    mode: "live",
  };
  let ledger = append(
    fixture.ledger,
    runAuthorizedEvent({
      eventId: "event-live-validation-run",
      commandId: "command-live-validation-run",
      occurredAt: "2026-07-18T11:00:00.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: { run },
    }),
  );
  const request = authorizedCodexRunRequest({
    state: reduceWorldstateLedger(ledger),
    runId: run.id,
    requestId: "request-live-codex",
    secret: "test-live-authorization-secret",
    now: new Date("2026-07-18T11:00:00.000Z"),
    nonce: "00000000-0000-4000-8000-000000000001",
  });
  const receipt = candidateReceipt({
    runId: run.id,
    briefId: fixture.brief.id,
    baseRevisionId: fixture.brief.baseRevisionId,
    extraChangedPath: input.extraChangedPath,
  });
  const response = liveResponse({ request, receipt });
  for (const event of codexRunResponseEvents({
    run,
    brief: fixture.brief,
    request,
    response,
    recordedAt: "2026-07-18T11:00:04.000Z",
    systemActor: HOME_MOVE_ACTORS.system,
  })) {
    ledger = append(ledger, event);
  }
  const returnedState = reduceWorldstateLedger(ledger);
  const closure = Object.values(returnedState.operational.closures).find(
    (candidate) => candidate.runId === run.id,
  );
  const codexExchange = ledger.events
    .filter((event) => event.type === "source.captured")
    .map((event) => parseCodexRunExchangeSource(event.payload.source))
    .find((candidate) => candidate?.request.runId === run.id);
  if (!closure || !codexExchange) {
    throw new Error("Expected a coherent returned live fixture.");
  }
  const validationRequest = compileLiveEvidenceRequest({
    validationRequestId: "request-live-validation",
    validationId: "validation-independent-live",
    run,
    brief: fixture.brief,
    closure,
    codexExchange,
  });
  return {
    fixture,
    run,
    ledger,
    closure,
    codexExchange,
    validationRequest,
    validationResponse: liveValidationResponse(validationRequest),
  };
}

function appendValidationExchange(input: ReturnType<typeof returnedLiveFixture>) {
  let ledger = append(
    input.ledger,
    liveEvidenceValidationAttemptSourceEvent({
      request: input.validationRequest,
      eventId: "event-live-validation-attempt",
      commandId: "command-live-validation-attempt",
      occurredAt: "2026-07-18T11:00:05.000Z",
      actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
    }),
  );
  ledger = append(
    ledger,
    liveEvidenceValidationExchangeSourceEvent({
      request: input.validationRequest,
      response: input.validationResponse,
      eventId: "event-live-validation-exchange",
      commandId: "command-live-validation-exchange",
      occurredAt: "2026-07-18T11:00:06.000Z",
      actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
    }),
  );
  return ledger;
}

describe("independent live-candidate evidence normalization", () => {
  it("refuses to compile validation for a candidate outside its profile envelope", () => {
    expect(() =>
      returnedLiveFixture({ extraChangedPath: "package.json" }),
    ).toThrow(
      /changes paths outside the exact moving-cost-contract-v1 allowed-change envelope: package\.json/i,
    );
  });

  it("keeps a legacy unbound brief ineligible for live validation", () => {
    const fixture = returnedLiveFixture();
    expect(() =>
      compileLiveEvidenceRequest({
        validationRequestId: "request-legacy-unbound-validation",
        validationId: "validation-legacy-unbound",
        run: fixture.run,
        brief: { ...fixture.fixture.brief, delegationProfileId: null },
        closure: fixture.closure,
        codexExchange: fixture.codexExchange,
      }),
    ).toThrow(/no registered delegation profile for candidate validation/i);
  });

  it("normalizes only an exact durable attempt and verifier exchange", () => {
    const fixture = returnedLiveFixture();
    const exchangedLedger = appendValidationExchange(fixture);
    const event = liveEvidenceValidationRecordedEvent({
      state: reduceWorldstateLedger(exchangedLedger),
      request: fixture.validationRequest,
      response: fixture.validationResponse,
      eventId: "event-live-validation-recorded",
      commandId: "command-live-validation-recorded",
      occurredAt: "2026-07-18T11:00:07.000Z",
      actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
    });
    const state = reduceWorldstateLedger(append(exchangedLedger, event));
    const validation =
      state.operational.validations[fixture.validationRequest.validationId];

    expect(validation.validator).toEqual(INDEPENDENT_LIVE_VALIDATOR_ACTOR);
    expect(validation.evidenceSourceId).toBe(
      liveEvidenceValidationExchangeSourceId(
        fixture.validationRequest.validationRequestId,
      ),
    );
    expect(
      validation.observations.every(
        (observation) =>
          observation.result === "passed" &&
          observation.freshness === "current" &&
          observation.evidenceRefs.includes(validation.evidenceSourceId),
      ),
    ).toBe(true);
    const source = state.operational.sources[validation.evidenceSourceId];
    const exchange = parseLiveEvidenceValidationExchangeSource(source);
    expect(exchange?.request.candidateReceipt).toEqual(
      fixture.validationRequest.candidateReceipt,
    );
    expect(state.canonical).toEqual(fixture.fixture.state.canonical);
  });

  it("refuses normalization when the exact attempt was not persisted", () => {
    const fixture = returnedLiveFixture();
    const ledger = append(
      fixture.ledger,
      liveEvidenceValidationExchangeSourceEvent({
        request: fixture.validationRequest,
        response: fixture.validationResponse,
        eventId: "event-live-validation-exchange-only",
        commandId: "command-live-validation-exchange-only",
        occurredAt: "2026-07-18T11:01:00.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    );

    expect(() =>
      liveEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(ledger),
        request: fixture.validationRequest,
        response: fixture.validationResponse,
        eventId: "event-live-validation-without-attempt",
        commandId: "command-live-validation-without-attempt",
        occurredAt: "2026-07-18T11:01:01.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    ).toThrow(/attempt is not durable/i);
  });

  it("rejects a response whose candidate binding was substituted", () => {
    const fixture = returnedLiveFixture();
    const substituted = LiveEvidenceSuccessSchema.parse({
      ...fixture.validationResponse,
      candidate: {
        ...fixture.validationResponse.candidate,
        candidateTree: "9".repeat(40),
      },
    });
    let ledger = append(
      fixture.ledger,
      liveEvidenceValidationAttemptSourceEvent({
        request: fixture.validationRequest,
        eventId: "event-live-substituted-attempt",
        commandId: "command-live-substituted-attempt",
        occurredAt: "2026-07-18T11:02:00.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    );
    ledger = append(
      ledger,
      liveEvidenceValidationExchangeSourceEvent({
        request: fixture.validationRequest,
        response: substituted,
        eventId: "event-live-substituted-exchange",
        commandId: "command-live-substituted-exchange",
        occurredAt: "2026-07-18T11:02:01.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    );

    expect(() =>
      liveEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(ledger),
        request: fixture.validationRequest,
        response: substituted,
        eventId: "event-live-substituted-recorded",
        commandId: "command-live-substituted-recorded",
        occurredAt: "2026-07-18T11:02:02.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    ).toThrow(/signed staged-candidate receipt/i);
  });

  it("rejects replay mode and non-independent authority before minting evidence", () => {
    const fixture = returnedLiveFixture();
    expect(() =>
      compileLiveEvidenceRequest({
        validationRequestId: "request-wrong-mode",
        validationId: "validation-wrong-mode",
        run: { ...fixture.run, mode: "replay" },
        brief: fixture.fixture.brief,
        closure: fixture.closure,
        codexExchange: fixture.codexExchange,
      }),
    ).toThrow(LiveEvidenceValidationCoherenceError);

    expect(() =>
      liveEvidenceValidationAttemptSourceEvent({
        request: LiveEvidenceRequestSchema.parse(fixture.validationRequest),
        eventId: "event-live-human-attempt",
        commandId: "command-live-human-attempt",
        occurredAt: "2026-07-18T11:03:00.000Z",
        actor: HOME_MOVE_ACTORS.human,
      }),
    ).toThrow(LiveEvidenceValidationAuthorityError);
  });

  it("does not accept a validation request recompiled from a different signed receipt", () => {
    const fixture = returnedLiveFixture();
    const exchangedLedger = appendValidationExchange(fixture);
    const substitutedRequest = LiveEvidenceRequestSchema.parse({
      ...fixture.validationRequest,
      candidateReceipt: {
        ...fixture.validationRequest.candidateReceipt,
        signature: {
          ...fixture.validationRequest.candidateReceipt.signature,
          digest: `hmac-sha256:${"8".repeat(64)}`,
        },
      },
    });

    expect(
      stableStringify(substitutedRequest),
    ).not.toBe(stableStringify(fixture.validationRequest));
    expect(() =>
      liveEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(exchangedLedger),
        request: substitutedRequest,
        response: fixture.validationResponse,
        eventId: "event-live-substituted-receipt",
        commandId: "command-live-substituted-receipt",
        occurredAt: "2026-07-18T11:04:00.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    ).toThrow(LiveEvidenceValidationCoherenceError);
  });
});

describe("sealed live-candidate reconciliation", () => {
  it("establishes exact candidate execution without claiming authorship or promotion", () => {
    const fixture = returnedLiveFixture();
    let ledger = appendValidationExchange(fixture);
    ledger = append(
      ledger,
      liveEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(ledger),
        request: fixture.validationRequest,
        response: fixture.validationResponse,
        eventId: "event-live-reconciliation-validation",
        commandId: "command-live-reconciliation-validation",
        occurredAt: "2026-07-18T11:10:00.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    );
    const validated = reduceWorldstateLedger(ledger);
    const deltaId = resultReconciliationDeltaId({
      closureId: fixture.closure.id,
      validationId: fixture.validationRequest.validationId,
      baseRevisionId: validated.canonical.head.id,
    });
    for (const event of resultReconciliationProposalEvents({
      state: validated,
      closureId: fixture.closure.id,
      validationId: fixture.validationRequest.validationId,
      deltaId,
      occurredAt: "2026-07-18T11:10:01.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    })) {
      ledger = append(ledger, event);
    }
    const proposed = reduceWorldstateLedger(ledger);
    const projection = proposed.operational.deltas[deltaId];
    const artifact = parseResultReconciliationArtifactSource(
      proposed.operational.sources[resultReconciliationSourceId(deltaId)],
    );

    expect(artifact).toMatchObject({
      verificationScope: "sealed_live_candidate",
      causalExecutionEstablished: true,
      causalAuthorshipEstablished: false,
      artifactPromotion: "not_performed",
    });
    expect(projection.delta.sourceRefs).toEqual(
      expect.arrayContaining([
        fixture.validationRequest.exchangeSourceId,
        liveEvidenceValidationExchangeSourceId(
          fixture.validationRequest.validationRequestId,
        ),
      ]),
    );
    expect(projection.delta.operations[0]).toMatchObject({
      op: "node.patch",
      patch: {
        data: {
          verificationScope: "sealed_live_candidate",
          causalExecutionEstablished: true,
          causalAuthorshipEstablished: false,
          artifactPromotion: "not_performed",
        },
      },
    });
    expect(proposed.canonical).toEqual(fixture.fixture.state.canonical);
    expect(() =>
      assertReconciliationDeltaMatchesCurrentState(proposed, deltaId),
    ).not.toThrow();
  });

  it("rejects a digest-valid live exchange whose signed receipt was replaced", () => {
    const fixture = returnedLiveFixture();
    let ledger = appendValidationExchange(fixture);
    ledger = append(
      ledger,
      liveEvidenceValidationRecordedEvent({
        state: reduceWorldstateLedger(ledger),
        request: fixture.validationRequest,
        response: fixture.validationResponse,
        eventId: "event-live-reconciliation-tamper-validation",
        commandId: "command-live-reconciliation-tamper-validation",
        occurredAt: "2026-07-18T11:11:00.000Z",
        actor: INDEPENDENT_LIVE_VALIDATOR_ACTOR,
      }),
    );
    const state = reduceWorldstateLedger(ledger);
    const validation =
      state.operational.validations[fixture.validationRequest.validationId];
    const source = state.operational.sources[validation.evidenceSourceId];
    const exchange = parseLiveEvidenceValidationExchangeSource(source);
    if (!exchange) throw new Error("Expected an exact live verifier exchange.");
    const substituted = {
      ...exchange,
      request: {
        ...exchange.request,
        candidateReceipt: {
          ...exchange.request.candidateReceipt,
          signature: {
            ...exchange.request.candidateReceipt.signature,
            digest: `hmac-sha256:${"7".repeat(64)}`,
          },
        },
      },
    };
    const originalSourceEvent = ledger.events.find(
      (event) =>
        event.type === "source.captured" &&
        event.payload.source.id === source.id,
    );
    if (!originalSourceEvent || originalSourceEvent.type !== "source.captured") {
      throw new Error("Expected the original live exchange source event.");
    }
    const substitutedSourceEvent = sourceCapturedEvent({
      ...originalSourceEvent,
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
    const tampered = reduceWorldstateLedger({
      ...ledger,
      events: ledger.events.map((event) =>
        event.eventId === originalSourceEvent.eventId
          ? substitutedSourceEvent
          : event,
      ),
    });
    const deltaId = resultReconciliationDeltaId({
      closureId: fixture.closure.id,
      validationId: validation.id,
      baseRevisionId: tampered.canonical.head.id,
    });

    expect(() =>
      resultReconciliationProposalEvents({
        state: tampered,
        closureId: fixture.closure.id,
        validationId: validation.id,
        deltaId,
        occurredAt: "2026-07-18T11:11:02.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(/does not exactly reproduce|does not exactly recompile/i);
  });
});
