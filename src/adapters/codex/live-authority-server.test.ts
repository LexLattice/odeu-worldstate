import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sealLiveWorkspaceCandidate } from "@/adapters/artifact-promotion/server";
import type { ArtifactCandidateReceipt } from "@/adapters/artifact-promotion/schema";
import {
  parseWorldstateLedgerDocument,
  worldstateLedgerDocument,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";
import {
  appendLedgerEvent,
  RevisionRecordSchema,
  runAuthorizedEvent,
  type LedgerEvent,
  type WorldstateLedger,
} from "@/domain";
import { createLiveWorkerClosureFixture } from "@/fixtures";

import {
  authorizeAndPublishLiveRun,
  dispatchAuthorizedLiveRequest,
  getAgentRuntimeCapability,
  getLiveRunStatus,
  LiveAuthorityServerError,
  verifyPrivateCompletedLiveCandidate,
} from "./live-authority-server";
import {
  AgentRunFailureSchema,
  AgentRunSuccessSchema,
  type AgentRunRequest,
  type AgentRunResponse,
} from "./schema";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

interface PreparedFixture {
  readonly root: string;
  readonly workspace: string;
  readonly ledgerFile: string;
  readonly head: string;
  readonly document: WorldstateLedgerDocument;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runId: string;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function queuedLiveDocument(artifactBaseRef: string): {
  readonly document: WorldstateLedgerDocument;
  readonly runId: string;
} {
  const fixture = createLiveWorkerClosureFixture();
  const authorizationIndex = fixture.ledger.events.findIndex(
    (event) => event.type === "run.authorized",
  );
  if (authorizationIndex < 0)
    throw new Error("Expected an authorized live run fixture.");
  const events = structuredClone(
    fixture.ledger.events.slice(0, authorizationIndex + 1),
  ).map((event): LedgerEvent => {
    if (event.type === "brief.compiled") {
      return {
        ...event,
        payload: {
          brief: { ...event.payload.brief, artifactBaseRef },
        },
      };
    }
    if (event.type === "run.authorized") {
      return {
        ...event,
        payload: {
          run: { ...event.payload.run, artifactBaseRef },
        },
      };
    }
    return event;
  });
  return {
    runId: fixture.ids.run,
    document: worldstateLedgerDocument({
      ledger: { ...fixture.ledger, events },
      projectLabel: "Live authority test",
      updatedAt: "2026-07-18T12:00:00.000Z",
    }),
  };
}

async function git(workspace: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", workspace, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function preparedFixture(): Promise<PreparedFixture> {
  // WSL may map os.tmpdir() to a Windows filesystem that cannot enforce the
  // private POSIX owner/mode contract required by the candidate store.
  const root = await mkdtemp("/tmp/odeu-live-authority-");
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const ledgerDirectory = join(root, "ledger");
  const ledgerFile = join(ledgerDirectory, "worldstate.json");
  await Promise.all([
    mkdir(workspace),
    mkdir(codexHome),
    mkdir(ledgerDirectory),
  ]);
  await git(workspace, "init");
  await git(workspace, "config", "user.name", "ODEU Test");
  await git(workspace, "config", "user.email", "odeu@example.invalid");
  await writeFile(join(workspace, "README.md"), "prepared\n", "utf8");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-m", "prepared fixture");
  const head = await git(workspace, "rev-parse", "HEAD");
  const targetRef = await git(workspace, "symbolic-ref", "HEAD");
  const queued = queuedLiveDocument(`git:${head}`);
  await writeFile(ledgerFile, "{}\n", { encoding: "utf8", mode: 0o600 });
  return {
    root,
    workspace,
    ledgerFile,
    head,
    document: queued.document,
    runId: queued.runId,
    env: {
      PATH: process.env.PATH,
      ODEU_CODEX_MODE: "live",
      ODEU_CODEX_WORKSPACE: workspace,
      ODEU_CODEX_HOME: codexHome,
      ODEU_CODEX_LEDGER_FILE: ledgerFile,
      ODEU_CODEX_AUTH_SECRET: "test-live-authority-secret",
      ODEU_CODEX_REPOSITORY_ID: "repository-live-authority-test",
      ODEU_CODEX_PROMOTION_TARGET_REF: targetRef,
      ODEU_CODEX_CANDIDATE_STORE: join(root, "candidate-store"),
      ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID: "artifact-key-test",
      ODEU_CODEX_ARTIFACT_SIGNING_SECRET:
        "artifact-signing-secret-at-least-32-bytes",
      CODEX_API_KEY: "test-api-key",
      ODEU_CODEX_ALLOW_PRIMARY_WORKTREE: "true",
    },
  };
}

function requestInput(
  fixture: PreparedFixture,
  requestId = "request-live-authority",
) {
  return {
    document: fixture.document,
    runId: fixture.runId,
    requestId,
  };
}

function additionalQueuedLiveDocument(fixture: PreparedFixture): {
  readonly document: WorldstateLedgerDocument;
  readonly runId: string;
} {
  const originalAuthorization = fixture.document.events.find(
    (event) => event.type === "run.authorized",
  );
  if (!originalAuthorization) {
    throw new Error("Expected an existing queued live authorization.");
  }
  const runId = `${fixture.runId}-second`;
  const ledger: WorldstateLedger = {
    projectId: fixture.document.projectId,
    genesisRevision: RevisionRecordSchema.parse(
      fixture.document.metadata.genesisRevision,
    ),
    events: fixture.document.events,
  };
  const withSecondRun = appendLedgerEvent(
    ledger,
    runAuthorizedEvent({
      eventId: "event-authorize-second-live-run",
      commandId: "command-authorize-second-live-run",
      occurredAt: "2026-07-18T12:00:01.000Z",
      actor: originalAuthorization.actor,
      payload: {
        run: { ...originalAuthorization.payload.run, id: runId },
      },
    }),
  ).ledger;
  return {
    runId,
    document: worldstateLedgerDocument({
      ledger: withSecondRun,
      projectLabel: "Live authority test with second run",
      updatedAt: "2026-07-18T12:00:01.000Z",
    }),
  };
}

function typedFailure(): AgentRunResponse {
  return AgentRunFailureSchema.parse({
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
      message: "The test worker returned a typed failure.",
      issues: [],
    },
    briefPreserved: true,
    resumable: false,
    resumeSupported: false,
    blockedRun: null,
  });
}

async function sealedCandidate(
  fixture: PreparedFixture,
  request: AgentRunRequest,
): Promise<ArtifactCandidateReceipt> {
  await writeFile(
    join(fixture.workspace, "README.md"),
    "candidate result\n",
    "utf8",
  );
  return (
    await sealLiveWorkspaceCandidate({
      workspace: fixture.workspace,
      repositoryId: fixture.env.ODEU_CODEX_REPOSITORY_ID!,
      targetRef: fixture.env.ODEU_CODEX_PROMOTION_TARGET_REF!,
      expectedBaseCommit: fixture.head,
      runId: request.runId,
      briefId: request.brief.briefId,
      baseRevisionId: request.brief.sourceRevisionId,
      sealedAt: "2026-07-18T12:02:00.000Z",
      candidateStoreDirectory: fixture.env.ODEU_CODEX_CANDIDATE_STORE!,
      signing: {
        keyId: fixture.env.ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID!,
        secret: fixture.env.ODEU_CODEX_ARTIFACT_SIGNING_SECRET!,
      },
    })
  ).receipt;
}

function returnedResponse(
  request: AgentRunRequest,
  candidate: ArtifactCandidateReceipt,
): AgentRunResponse {
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
        at: "2026-07-18T12:01:00.000Z",
        label: "Queued",
        detail: "Queued privately.",
      },
      {
        sequence: 1,
        status: "received",
        at: "2026-07-18T12:01:10.000Z",
        label: "Received",
        detail: "Received privately.",
      },
      {
        sequence: 2,
        status: "working",
        at: "2026-07-18T12:01:20.000Z",
        label: "Working",
        detail: "Working privately.",
      },
      {
        sequence: 3,
        status: "returned",
        at: "2026-07-18T12:02:00.000Z",
        label: "Returned",
        detail: "Returned exact candidate.",
      },
    ],
    closure: {
      runId: request.runId,
      briefId: request.brief.briefId,
      sourceRevisionIdUsed: request.brief.sourceRevisionId,
      artifactBaseRefUsed: request.brief.artifactBaseRef,
      workerThreadId: "thread-private-returned",
      workerItemIds: [],
      report: {
        outcome: "returned",
        claimedEffects: ["Changed the declared artifact."],
        claimedArtifacts: [],
        claimedChecks: [],
        failures: [],
        unresolved: [],
        completionClaim: {
          claimedDone: true,
          criteriaClaimedSatisfied: request.brief.doneMeans.map(() => true),
        },
        candidateReconciliationSummary: "Review the exact private candidate.",
      },
      sdkObservations: { fileChanges: [], commands: [] },
      artifactCandidate: candidate,
    },
  });
}

describe("live browser-to-server authority handoff", () => {
  it("reports only a safe capability and atomically publishes an exact queued run intent", async () => {
    const fixture = await preparedFixture();
    const options = {
      env: fixture.env,
      now: () => new Date("2026-07-18T12:01:00.000Z"),
      nonce: () => "00000000-0000-4000-8000-000000000099",
    };

    const capability = await getAgentRuntimeCapability(options);
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );

    expect(capability).toEqual({
      requestedMode: "live",
      effectiveMode: "live",
      status: "available",
      artifactBaseRef: `git:${fixture.head}`,
      reason: null,
    });
    expect(JSON.stringify(capability)).not.toContain(fixture.root);
    expect(JSON.stringify(capability)).not.toContain(
      "test-live-authority-secret",
    );
    expect(request).toMatchObject({
      runId: fixture.runId,
      requestId: "request-live-authority",
      mode: "live",
      brief: { artifactBaseRef: `git:${fixture.head}` },
      authorization: {
        nonce: "00000000-0000-4000-8000-000000000099",
        issuedAt: "2026-07-18T12:01:00.000Z",
      },
    });
    expect(
      parseWorldstateLedgerDocument(
        JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
      ),
    ).toEqual(fixture.document);
    await expect(
      getLiveRunStatus(
        { runId: fixture.runId, requestId: "request-live-authority" },
        options,
      ),
    ).resolves.toEqual({ status: "not_started", response: null });

    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), options),
    ).resolves.toEqual(request);
    await expect(
      authorizeAndPublishLiveRun(
        requestInput(fixture, "request-live-authority-other"),
        options,
      ),
    ).rejects.toMatchObject({ code: "authorization_conflict" });
  });

  it("refuses a dirty workspace and an artifact base that differs from its actual HEAD", async () => {
    const dirtyFixture = await preparedFixture();
    await writeFile(
      join(dirtyFixture.workspace, "untracked.txt"),
      "dirty\n",
      "utf8",
    );

    await expect(
      authorizeAndPublishLiveRun(requestInput(dirtyFixture), {
        env: dirtyFixture.env,
      }),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });

    const mismatchFixture = await preparedFixture();
    const mismatch = queuedLiveDocument(`git:${"a".repeat(40)}`);
    await expect(
      authorizeAndPublishLiveRun(
        {
          document: mismatch.document,
          runId: mismatch.runId,
          requestId: "request-base-mismatch",
        },
        { env: mismatchFixture.env },
      ),
    ).rejects.toMatchObject({ code: "artifact_base_mismatch" });
  });

  it("rejects a symlinked authoritative ledger without modifying its target", async () => {
    const fixture = await preparedFixture();
    const target = join(fixture.root, "ledger-target.json");
    await writeFile(target, "target remains exact\n", "utf8");
    await unlink(fixture.ledgerFile);
    await symlink(target, fixture.ledgerFile, "file");

    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), { env: fixture.env }),
    ).rejects.toMatchObject({ code: "workspace_not_ready" });
    await expect(readFile(target, "utf8")).resolves.toBe(
      "target remains exact\n",
    );
  });

  it("stores the exact typed response before return and makes retries read-only", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const response = typedFailure();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      markStarted();
      await wait;
      return response;
    });
    const dispatch = dispatchAuthorizedLiveRequest(request, execute, options);
    await started;

    await expect(
      getLiveRunStatus(
        { runId: request.runId, requestId: request.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "in_progress", response: null });
    release();
    await expect(dispatch).resolves.toEqual(response);
    await expect(
      getLiveRunStatus(
        { runId: request.runId, requestId: request.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "completed", response });

    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).resolves.toEqual(response);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("verifies a signed candidate only when the private completed response returned it exactly", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const candidate = await sealedCandidate(fixture, request);
    const response = returnedResponse(request, candidate);
    await dispatchAuthorizedLiveRequest(request, async () => response, options);

    await expect(
      verifyPrivateCompletedLiveCandidate(candidate, options),
    ).resolves.toMatchObject({
      candidate,
      request,
      response,
    });

    if (!response.ok) throw new Error("Expected returned response fixture.");
    expect(
      AgentRunSuccessSchema.safeParse({
        ...response,
        runtime: { ...response.runtime, status: "failed" },
        events: response.events.map((event, index) =>
          index === response.events.length - 1
            ? { ...event, status: "failed" }
            : event,
        ),
        closure: {
          ...response.closure,
          report: { ...response.closure.report, outcome: "failed" },
          artifactCandidate: candidate,
        },
      }).success,
    ).toBe(false);
  });

  it("serializes shared-ledger execution and retains immutable provenance across later runs", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const second = additionalQueuedLiveDocument(fixture);
    const firstRequest = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const secondRequest = await authorizeAndPublishLiveRun(
      {
        document: second.document,
        runId: second.runId,
        requestId: "request-second-live-run",
      },
      options,
    );

    await expect(
      authorizeAndPublishLiveRun(requestInput(fixture), options),
    ).resolves.toEqual(firstRequest);
    expect(
      parseWorldstateLedgerDocument(
        JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
      ),
    ).toEqual(second.document);

    const candidate = await sealedCandidate(fixture, firstRequest);
    const firstResponse = returnedResponse(firstRequest, candidate);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstDispatch = dispatchAuthorizedLiveRequest(
      firstRequest,
      async () => {
        expect(
          parseWorldstateLedgerDocument(
            JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
          ),
        ).toEqual(fixture.document);
        markFirstStarted();
        await firstWait;
        return firstResponse;
      },
      options,
    );
    await firstStarted;

    const executeSecond = vi.fn(async () => typedFailure());
    await expect(
      dispatchAuthorizedLiveRequest(secondRequest, executeSecond, options),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(executeSecond).not.toHaveBeenCalled();
    await expect(
      getLiveRunStatus(
        { runId: secondRequest.runId, requestId: secondRequest.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "not_started", response: null });

    releaseFirst();
    await expect(firstDispatch).resolves.toEqual(firstResponse);
    await expect(
      dispatchAuthorizedLiveRequest(secondRequest, executeSecond, options),
    ).resolves.toEqual(typedFailure());
    expect(executeSecond).toHaveBeenCalledOnce();
    expect(
      parseWorldstateLedgerDocument(
        JSON.parse(await readFile(fixture.ledgerFile, "utf8")),
      ),
    ).toEqual(second.document);

    await expect(
      verifyPrivateCompletedLiveCandidate(candidate, options),
    ).resolves.toMatchObject({
      candidate,
      request: firstRequest,
      response: firstResponse,
    });
  });

  it("rejects a signed candidate when the private completed response failed without returning it", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const candidate = await sealedCandidate(fixture, request);
    await dispatchAuthorizedLiveRequest(
      request,
      async () => typedFailure(),
      options,
    );

    await expect(
      verifyPrivateCompletedLiveCandidate(candidate, options),
    ).rejects.toMatchObject({ code: "candidate_not_recorded" });
  });

  it("never repeats an execution whose durable start has no typed response", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const execute = vi.fn(async (): Promise<AgentRunResponse> => {
      throw new Error("simulated worker process loss");
    });

    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).rejects.toThrow("simulated worker process loss");
    await expect(
      getLiveRunStatus(
        { runId: request.runId, requestId: request.requestId },
        options,
      ),
    ).resolves.toEqual({ status: "outcome_unknown", response: null });
    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).rejects.toBeInstanceOf(LiveAuthorityServerError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("treats a run claim without a response as outcome unknown", async () => {
    const fixture = await preparedFixture();
    const options = { env: fixture.env };
    const request = await authorizeAndPublishLiveRun(
      requestInput(fixture),
      options,
    );
    const identity = createHash("sha256").update(request.runId).digest("hex");
    const claimDirectory = join(fixture.root, "ledger", "odeu-run-claims");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(
      join(claimDirectory, `${identity}.claimed.json`),
      "{}\n",
      "utf8",
    );
    const execute = vi.fn(async () => typedFailure());

    await expect(
      dispatchAuthorizedLiveRequest(request, execute, options),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(execute).not.toHaveBeenCalled();
  });
});
