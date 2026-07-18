import { describe, expect, it } from "vitest";

import {
  AgentRunFailureSchema,
  AgentRunSuccessSchema,
  type AgentRunResponse,
} from "@/adapters/codex/schema";
import {
  appendLedgerEvent,
  reduceWorldstateLedger,
  runAuthorizedEvent,
  type AgentRun,
  type WorldstateLedger,
} from "@/domain";
import { createPrivateProjectionFixture, HOME_MOVE_ACTORS } from "@/fixtures";

import { domainBriefToCodexRunRequest } from "./domain-brief-to-codex";
import {
  CODEX_RUN_NORMALIZATION_FAILURE_MESSAGE_MAX_LENGTH,
  CodexRunEvidenceAuthorityError,
  CodexRunResponseCoherenceError,
  assertCodexRunResponseMatchesRun,
  codexRunAttemptSourceEvent,
  codexRunExchangeSourceEvent,
  codexRunExchangeSourceId,
  codexRunNormalizationFailureSourceEvent,
  codexRunNormalizationFailureSourceId,
  codexRunResponseEvents,
  parseCodexRunAttemptSource,
  parseCodexRunExchangeSource,
  parseCodexRunNormalizationFailureSource,
} from "./codex-run-evidence";

function append(
  ledger: WorldstateLedger,
  event: Parameters<typeof appendLedgerEvent>[1],
) {
  return appendLedgerEvent(ledger, event).ledger;
}

function authorizedFixture(mode: "live" | "replay") {
  const fixture = createPrivateProjectionFixture({
    executionMode: mode,
    artifactBaseRef:
      mode === "live" ? `git:${"a".repeat(40)}` : "git:demo-base-001",
  });
  const run: AgentRun = {
    id: `run-evidence-${mode}`,
    briefId: fixture.brief.id,
    baseRevisionId: fixture.brief.baseRevisionId,
    artifactBaseRef: fixture.brief.artifactBaseRef,
    mode,
  };
  const ledger = append(
    fixture.ledger,
    runAuthorizedEvent({
      eventId: `event-run-authorized-evidence-${mode}`,
      commandId: `command-run-authorized-evidence-${mode}`,
      occurredAt: "2026-07-17T14:00:00.000Z",
      actor: HOME_MOVE_ACTORS.human,
      payload: { run },
    }),
  );
  const request = domainBriefToCodexRunRequest(
    fixture.brief,
    run.id,
    run.mode,
    `request-evidence-${mode}`,
  );
  return { fixture, ledger, run, request };
}

function liveCandidate(input: ReturnType<typeof authorizedFixture>) {
  const digest = "2".repeat(64);
  return {
    metadata: {
      kind: "odeu.git-artifact-candidate" as const,
      version: 1 as const,
      candidateId: `artifact-candidate:sha256:${digest}`,
      candidateRef: `refs/odeu/candidates/${digest}`,
      repositoryId: "repository-codex-evidence-test",
      targetRef: "refs/heads/main",
      runId: input.run.id,
      briefId: input.fixture.brief.id,
      baseRevisionId: input.run.baseRevisionId,
      sealedAt: "2026-07-17T14:00:04.000Z",
      git: {
        objectFormat: "sha1" as const,
        baseCommit: "a".repeat(40),
        baseTree: "b".repeat(40),
        candidateCommit: "c".repeat(40),
        candidateTree: "d".repeat(40),
      },
      patch: {
        format: "git-binary-diff-v1" as const,
        digest: `sha256:${"e".repeat(64)}`,
        byteLength: 128,
      },
      manifest: {
        digest: `sha256:${"f".repeat(64)}`,
        entries: [
          {
            path: "demo/moving-costs.html",
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
      keyId: "artifact-key-codex-evidence-test",
      digest: `hmac-sha256:${"4".repeat(64)}`,
    },
  };
}

function replaySuccess(
  input: ReturnType<typeof authorizedFixture>,
): Extract<AgentRunResponse, { ok: true }> {
  return AgentRunSuccessSchema.parse({
    ok: true,
    runtime: {
      requestedMode: "replay",
      effectiveMode: "replay",
      status: "replayed",
      provider: "codex",
      replayIdentity: "home-move-fixture-replay-v0",
      replayKind: "fixture",
    },
    events: [
      {
        sequence: 0,
        status: "queued",
        at: "2026-07-17T14:00:01.000Z",
        label: "Brief queued",
        detail: "The immutable replay brief was queued.",
      },
      {
        sequence: 1,
        status: "received",
        at: "2026-07-17T14:00:02.000Z",
        label: "Brief received",
        detail: "The replay boundary received the brief.",
      },
      {
        sequence: 2,
        status: "working",
        at: "2026-07-17T14:00:03.000Z",
        label: "Working",
        detail: "Recorded implementation evidence is being projected.",
      },
      {
        sequence: 3,
        status: "returned",
        at: "2026-07-17T14:00:04.000Z",
        label: "Result returned",
        detail: "The replay result returned for staged review.",
      },
    ],
    closure: {
      runId: input.run.id,
      briefId: input.fixture.brief.id,
      sourceRevisionIdUsed: input.run.baseRevisionId,
      artifactBaseRefUsed: input.run.artifactBaseRef,
      workerThreadId: "thread-recorded-evidence",
      workerItemIds: ["item-file", "item-command"],
      report: {
        outcome: "returned",
        claimedEffects: [
          "The quote comparison can calculate two provider totals.",
        ],
        claimedArtifacts: [
          {
            path: "demo/moving-costs.html",
            kind: "updated",
            summary: "Added the moving-cost comparison form.",
            reference: "replay://artifact/moving-costs",
          },
        ],
        claimedChecks: [
          {
            checkId: "requirement-focused-tests",
            label: "Focused moving-cost calculation tests pass",
            status: "passed",
            detail: "The recorded focused test passed.",
            reference: "replay://check/focused-tests",
          },
          {
            checkId: "requirement-artifact-change",
            label: "The planning-page artifact change is addressable",
            status: "passed",
            detail: "The recorded artifact diff is addressable.",
            reference: "replay://check/artifact-change",
          },
        ],
        unresolved: [
          "Decide whether recurring storage costs need a separate row.",
        ],
        completionClaim: {
          claimedDone: true,
          criteriaClaimedSatisfied: input.fixture.brief.doneMeans.map(
            () => true,
          ),
        },
        candidateReconciliationSummary:
          "Stage the returned comparison artifact and checks for human review.",
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
            itemId: "item-command",
            command: "npm test -- moving-cost",
            status: "completed",
            exitCode: 0,
          },
        ],
      },
    },
  });
}

function schemaValidSuccessWithOutcome(
  input: ReturnType<typeof authorizedFixture>,
  outcome: "returned" | "failed" | "cancelled",
): Extract<AgentRunResponse, { ok: true }> {
  const base = replaySuccess(input);
  return AgentRunSuccessSchema.parse({
    ...base,
    runtime: {
      requestedMode: input.run.mode,
      effectiveMode: input.run.mode,
      status: input.run.mode === "replay" ? "replayed" : outcome,
      provider: "codex",
      replayIdentity:
        input.run.mode === "replay" ? "home-move-fixture-replay-v0" : null,
      replayKind: input.run.mode === "replay" ? "fixture" : null,
    },
    events: base.events.map((event, index) =>
      index === base.events.length - 1 ? { ...event, status: outcome } : event,
    ),
    closure: {
      ...base.closure,
      artifactCandidate:
        input.run.mode === "live" && outcome === "returned"
          ? liveCandidate(input)
          : null,
      report: {
        ...base.closure.report,
        outcome,
        completionClaim: {
          claimedDone: outcome === "returned",
          criteriaClaimedSatisfied: input.fixture.brief.doneMeans.map(
            () => outcome === "returned",
          ),
        },
      },
    },
  });
}

describe("Codex run evidence", () => {
  it("round-trips an integrity-bound attempt before dispatch", () => {
    const bound = authorizedFixture("replay");
    const event = codexRunAttemptSourceEvent({
      run: bound.run,
      brief: bound.fixture.brief,
      request: bound.request,
      eventId: "event-codex-attempt-test",
      commandId: "command-codex-attempt-test",
      occurredAt: "2026-07-17T14:00:00.500Z",
      actor: HOME_MOVE_ACTORS.system,
    });

    expect(parseCodexRunAttemptSource(event.payload.source)?.request).toEqual(
      bound.request,
    );
    expect(
      parseCodexRunAttemptSource({
        ...event.payload.source,
        integrity: { algorithm: "fnv1a64", digest: "fnv1a64:0000000000000000" },
      }),
    ).toBeNull();
  });

  it("round-trips a bounded integrity-bound normalization failure", () => {
    const bound = authorizedFixture("replay");
    const event = codexRunNormalizationFailureSourceEvent({
      requestId: bound.request.requestId,
      runId: bound.run.id,
      briefId: bound.fixture.brief.id,
      code: "state_conflict",
      message: `state conflict: ${"x".repeat(
        CODEX_RUN_NORMALIZATION_FAILURE_MESSAGE_MAX_LENGTH,
      )}`,
      eventId: "event-codex-normalization-failure",
      commandId: "command-codex-normalization-failure",
      occurredAt: "2026-07-17T14:00:06.000Z",
      actor: HOME_MOVE_ACTORS.system,
    });
    const parsed = parseCodexRunNormalizationFailureSource(
      event.payload.source,
    );

    expect(event.payload.source.id).toBe(
      codexRunNormalizationFailureSourceId(
        bound.request.requestId,
        "state_conflict",
      ),
    );
    expect(parsed).toMatchObject({
      requestId: bound.request.requestId,
      runId: bound.run.id,
      briefId: bound.fixture.brief.id,
      code: "state_conflict",
    });
    expect(parsed?.message).toHaveLength(
      CODEX_RUN_NORMALIZATION_FAILURE_MESSAGE_MAX_LENGTH,
    );
    expect(parsed?.message.endsWith("…")).toBe(true);
    expect(
      parseCodexRunNormalizationFailureSource({
        ...event.payload.source,
        visibility: "private",
      }),
    ).toBeNull();
    expect(
      parseCodexRunNormalizationFailureSource({
        ...event.payload.source,
        id: "source-codex-normalization-failure:another-request:state_conflict",
      }),
    ).toBeNull();
    expect(
      parseCodexRunNormalizationFailureSource({
        ...event.payload.source,
        integrity: { algorithm: "fnv1a64", digest: "fnv1a64:0000000000000000" },
      }),
    ).toBeNull();
  });

  it("rejects agent-authored Codex run evidence before constructing an event", () => {
    const bound = authorizedFixture("replay");
    const response = replaySuccess(bound);

    expect(() =>
      codexRunAttemptSourceEvent({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        eventId: "event-agent-forged-codex-attempt",
        commandId: "command-agent-forged-codex-attempt",
        occurredAt: "2026-07-17T14:00:00.500Z",
        actor: HOME_MOVE_ACTORS.codex,
      }),
    ).toThrow(CodexRunEvidenceAuthorityError);
    expect(() =>
      codexRunExchangeSourceEvent({
        request: bound.request,
        response,
        eventId: "event-agent-forged-codex-exchange",
        commandId: "command-agent-forged-codex-exchange",
        occurredAt: "2026-07-17T14:00:05.000Z",
        actor: HOME_MOVE_ACTORS.codex,
      }),
    ).toThrow(CodexRunEvidenceAuthorityError);
    expect(() =>
      codexRunNormalizationFailureSourceEvent({
        requestId: bound.request.requestId,
        runId: bound.run.id,
        briefId: bound.fixture.brief.id,
        code: "state_conflict",
        message: "forged by worker",
        eventId: "event-agent-forged-codex-normalization-failure",
        commandId: "command-agent-forged-codex-normalization-failure",
        occurredAt: "2026-07-17T14:00:06.000Z",
        actor: HOME_MOVE_ACTORS.codex,
      }),
    ).toThrow(CodexRunEvidenceAuthorityError);
  });

  it("accepts the returned replay runtime mapping", () => {
    const bound = authorizedFixture("replay");

    expect(() =>
      assertCodexRunResponseMatchesRun({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: schemaValidSuccessWithOutcome(bound, "returned"),
      }),
    ).not.toThrow();
  });

  it.each(["returned", "failed", "cancelled"] as const)(
    "accepts a live %s runtime with the same closure outcome",
    (outcome) => {
      const bound = authorizedFixture("live");

      expect(() =>
        assertCodexRunResponseMatchesRun({
          run: bound.run,
          brief: bound.fixture.brief,
          request: bound.request,
          response: schemaValidSuccessWithOutcome(bound, outcome),
        }),
      ).not.toThrow();
    },
  );

  it("rejects a live failed runtime paired with a returned closure", () => {
    const bound = authorizedFixture("live");
    const returned = schemaValidSuccessWithOutcome(bound, "returned");
    const contradictory = AgentRunSuccessSchema.parse({
      ...returned,
      runtime: { ...returned.runtime, status: "failed" },
      closure: { ...returned.closure, artifactCandidate: null },
    });

    expect(() =>
      assertCodexRunResponseMatchesRun({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: contradictory,
      }),
    ).toThrow(/response\.runtime\.status must equal returned/);
  });

  it("rejects replayed runtime paired with a failed replay closure", () => {
    const bound = authorizedFixture("replay");
    const contradictory = schemaValidSuccessWithOutcome(bound, "failed");

    expect(() =>
      assertCodexRunResponseMatchesRun({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: contradictory,
      }),
    ).toThrow(/response\.runtime\.status must equal failed/);
  });

  it("persists exact claims and SDK observations, then stages only operational truth", () => {
    const bound = authorizedFixture("replay");
    const beforeHead = reduceWorldstateLedger(bound.ledger).canonical.head.id;
    let ledger = append(
      bound.ledger,
      codexRunAttemptSourceEvent({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        eventId: "event-codex-attempt-replay",
        commandId: "command-codex-attempt-replay",
        occurredAt: "2026-07-17T14:00:00.500Z",
        actor: HOME_MOVE_ACTORS.system,
      }),
    );
    const response = replaySuccess(bound);
    const batch = codexRunResponseEvents({
      run: bound.run,
      brief: bound.fixture.brief,
      request: bound.request,
      response,
      recordedAt: "2026-07-17T14:00:05.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    });

    expect(batch.map((event) => event.type)).toEqual([
      "source.captured",
      "run.lifecycle_recorded",
      "run.lifecycle_recorded",
      "run.lifecycle_recorded",
      "closure.staged",
    ]);
    expect(
      batch
        .filter((event) => event.type === "run.lifecycle_recorded")
        .map((event) => event.payload.status),
    ).toEqual(["received", "working", "returned"]);
    expect(batch.slice(1).map((event) => event.occurredAt)).toEqual(
      Array.from(
        { length: batch.length - 1 },
        () => "2026-07-17T14:00:05.000Z",
      ),
    );
    for (const event of batch) ledger = append(ledger, event);

    const state = reduceWorldstateLedger(ledger);
    const exchangeSource =
      state.operational.sources[
        codexRunExchangeSourceId(bound.request.requestId)
      ];
    const exchange = parseCodexRunExchangeSource(exchangeSource);
    expect(exchange?.response).toEqual(response);
    if (!exchange?.response.ok)
      throw new Error("Expected a successful exchange.");
    expect(exchange.response.events.map((event) => event.at)).toEqual([
      "2026-07-17T14:00:01.000Z",
      "2026-07-17T14:00:02.000Z",
      "2026-07-17T14:00:03.000Z",
      "2026-07-17T14:00:04.000Z",
    ]);
    expect(exchange.response.closure.report.claimedArtifacts).toHaveLength(1);
    expect(exchange.response.closure.sdkObservations.fileChanges).toHaveLength(
      1,
    );
    expect(state.operational.runs[bound.run.id].status).toBe("returned");
    expect(state.operational.closures[`closure:${bound.run.id}`]).toMatchObject(
      {
        mode: "replay",
        claimedCompletion: true,
        changes: [
          expect.stringMatching(/^Claimed effect:/),
          expect.stringMatching(/^Claimed artifact/),
        ],
        evidenceRefs: expect.arrayContaining([
          codexRunExchangeSourceId(bound.request.requestId),
          "replay://check/focused-tests",
          "codex-item:thread-recorded-evidence/item-file",
        ]),
      },
    );
    expect(Object.keys(state.operational.validations)).toHaveLength(0);
    expect(state.canonical.head.id).toBe(beforeHead);
  });

  it("rejects run, revision, artifact, mode, and lifecycle incoherence atomically", () => {
    const bound = authorizedFixture("replay");
    const response = replaySuccess(bound);

    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: { ...bound.request, runId: "run-tampered" },
        response,
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(CodexRunResponseCoherenceError);
    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: {
          ...response,
          events: response.events.map((event, index) =>
            index === 2 ? { ...event, at: "2026-07-17T14:00:01.500Z" } : event,
          ),
        },
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(/lifecycle timestamp at sequence 2 precedes sequence 1/);
    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: {
          ...bound.request,
          brief: { ...bound.request.brief, goal: "A substituted goal." },
        },
        response,
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(CodexRunResponseCoherenceError);
    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: {
          ...response,
          runtime: {
            ...response.runtime,
            requestedMode: "live",
            effectiveMode: "live",
            status: "returned",
            replayIdentity: null,
            replayKind: null,
          },
        },
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow();
    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: {
          ...response,
          events: response.events.map((event, index) =>
            index === 2 ? { ...event, status: "returned" as const } : event,
          ),
        },
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(CodexRunResponseCoherenceError);
    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: {
          ...response,
          closure: {
            ...response.closure,
            sourceRevisionIdUsed: "revision-returned-for-another-authority",
          },
        },
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(CodexRunResponseCoherenceError);
    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response: {
          ...response,
          closure: {
            ...response.closure,
            artifactBaseRefUsed: "git:different-base",
          },
        },
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(CodexRunResponseCoherenceError);
  });

  it("retains a schema-valid incoherent exchange before rejecting normalization", () => {
    const bound = authorizedFixture("replay");
    const coherent = replaySuccess(bound);
    const response = AgentRunSuccessSchema.parse({
      ...coherent,
      closure: {
        ...coherent.closure,
        runId: "run-returned-for-another-authority",
      },
    });
    const exchangeEvent = codexRunExchangeSourceEvent({
      request: bound.request,
      response,
      eventId: "event-codex-exchange-incoherent",
      commandId: "command-codex-exchange-incoherent",
      occurredAt: "2026-07-17T14:00:05.000Z",
      actor: HOME_MOVE_ACTORS.system,
    });

    expect(
      parseCodexRunExchangeSource(exchangeEvent.payload.source)?.response,
    ).toEqual(response);
    expect(() =>
      codexRunResponseEvents({
        run: bound.run,
        brief: bound.fixture.brief,
        request: bound.request,
        response,
        recordedAt: "2026-07-17T14:00:05.000Z",
        systemActor: HOME_MOVE_ACTORS.system,
      }),
    ).toThrow(CodexRunResponseCoherenceError);
  });

  it("records blocked evidence as a nonterminal status and never as a closure", () => {
    const bound = authorizedFixture("live");
    const response = AgentRunFailureSchema.parse({
      ok: false,
      runtime: {
        requestedMode: "live",
        effectiveMode: "live",
        status: "blocked",
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
      },
      error: {
        code: "worker_blocked",
        message: "A product decision is required.",
        issues: [],
      },
      briefPreserved: true,
      resumable: true,
      resumeSupported: false,
      blockedRun: {
        runId: bound.run.id,
        briefId: bound.fixture.brief.id,
        sourceRevisionIdUsed: bound.run.baseRevisionId,
        artifactBaseRefUsed: bound.run.artifactBaseRef,
        workerThreadId: "thread-blocked",
        workerItemIds: [],
        events: [
          {
            sequence: 0,
            status: "queued",
            at: "2026-07-17T14:10:00.000Z",
            label: "Brief queued",
            detail: "The live brief was queued.",
          },
          {
            sequence: 1,
            status: "received",
            at: "2026-07-17T14:10:01.000Z",
            label: "Brief received",
            detail: "The live worker received the brief.",
          },
          {
            sequence: 2,
            status: "working",
            at: "2026-07-17T14:10:02.000Z",
            label: "Working",
            detail: "The worker inspected the bounded task.",
          },
          {
            sequence: 3,
            status: "blocked",
            at: "2026-07-17T14:10:03.000Z",
            label: "Worker blocked",
            detail: "A product decision is required.",
          },
        ],
        report: {
          outcome: "blocked",
          claimedEffects: [],
          claimedArtifacts: [],
          claimedChecks: [],
          unresolved: ["Choose whether deposits count as recoverable cash."],
          completionClaim: {
            claimedDone: false,
            criteriaClaimedSatisfied: bound.fixture.brief.doneMeans.map(
              () => false,
            ),
          },
          candidateReconciliationSummary: "Keep the run blocked.",
        },
        sdkObservations: { fileChanges: [], commands: [] },
      },
    });
    const batch = codexRunResponseEvents({
      run: bound.run,
      brief: bound.fixture.brief,
      request: bound.request,
      response,
      recordedAt: "2026-07-17T14:10:04.000Z",
      systemActor: HOME_MOVE_ACTORS.system,
    });

    expect(batch.at(-1)).toMatchObject({
      type: "run.lifecycle_recorded",
      payload: { status: "blocked" },
    });
    expect(batch.some((event) => event.type === "closure.staged")).toBe(false);
  });
});
