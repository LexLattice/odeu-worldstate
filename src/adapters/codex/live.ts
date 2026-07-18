import "server-only";

import { Codex, type ThreadItem } from "@openai/codex-sdk";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import {
  sealLiveWorkspaceCandidate,
  type ArtifactCandidateReceipt,
} from "@/adapters/artifact-promotion";

import {
  claimQueuedRunAuthorization,
  RunAuthorizationConsumedError,
  RunClaimBusyError,
} from "./consumption";
import { authorizationMatches, executionBriefDigest } from "./integrity";
import {
  AuthoritativeLedgerSymlinkError,
  resolveAuthoritativeLedgerFilePath,
} from "./ledger-file";
import { assertCodexRequestMode } from "./mode";
import { compileCodexPrompt } from "./prompt";
import { assertCurrentRunIsQueued, LiveRunStateError } from "./run-state";
import {
  AgentBlockedRunSchema,
  AgentRunSuccessSchema,
  CodexBlockedReportSchema,
  CodexReportedClosureSchema,
  CodexReportedResultSchema,
  type AgentBlockedRun,
  type AgentLifecycleEvent,
  type AgentRunRequest,
  type AgentRunSuccess,
} from "./schema";
import {
  acquireWorkspaceLease,
  type WorkspaceLease,
  WorkspaceLeaseUnavailableError,
} from "./workspace-lease";

const execFile = promisify(execFileCallback);

export class LiveCodexConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCodexConfigurationError";
  }
}

export class LiveCodexPreflightError extends Error {
  constructor(
    readonly code:
      | "authorization_invalid"
      | "authorization_consumed"
      | "run_claim_busy"
      | "revision_stale"
      | "artifact_base_mismatch"
      | "run_not_dispatchable"
      | "workspace_busy"
      | "workspace_dirty"
      | "workspace_private_data",
    message: string,
  ) {
    super(message);
    this.name = "LiveCodexPreflightError";
  }
}

export class LiveCodexBlockedError extends Error {
  constructor(readonly blockedRun: AgentBlockedRun) {
    const summary = blockedRun.report.unresolved
      .slice(0, 3)
      .join("; ")
      .slice(0, 2_000);
    super(
      summary
        ? `The Codex worker reported a blocked domain state: ${summary}. The v0 adapter does not support thread resume.`
        : "The Codex worker reported a blocked domain state without a closure witness. The v0 adapter does not support thread resume.",
    );
    this.name = "LiveCodexBlockedError";
  }
}

const MAX_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 30 * 1_000;
const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function authorizationWindowIsValid(
  issuedAt: string,
  expiresAt: string,
  now: Date,
): boolean {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  return (
    Number.isFinite(issued) &&
    Number.isFinite(expires) &&
    expires > issued &&
    expires - issued <= MAX_AUTHORIZATION_TTL_MS &&
    issued <= now.getTime() + MAX_CLOCK_SKEW_MS &&
    expires > now.getTime()
  );
}

export function isolatedPreflightGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of [
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

export async function runPreflightGit(
  workspace: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFile(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${GIT_NULL_DEVICE}`,
      "-c",
      "credential.helper=",
      "-C",
      workspace,
      ...args,
    ],
    {
      encoding: "utf8",
      env: isolatedPreflightGitEnvironment(),
    },
  );
  return result.stdout.trim();
}

export function isolatedEnvironment(codexHome: string): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: codexHome,
    CODEX_HOME: codexHome,
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  for (const name of [
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

/**
 * The Codex process receives its API credential through the SDK, but worker
 * commands inherit only this explicit non-secret allow-list. This prevents a
 * repository command from observing the server credential or unrelated host
 * environment variables.
 */
export function isolatedWorkerShellEnvironment(codexHome: string) {
  const processEnvironment = isolatedEnvironment(codexHome);
  return {
    inherit: "none" as const,
    set: processEnvironment,
  };
}

function observedSdkEvidence(items: ThreadItem[]) {
  return {
    fileChanges: items.flatMap((item) =>
      item.type === "file_change"
        ? item.changes.map((change) => ({
            itemId: item.id,
            path: change.path,
            kind: change.kind,
            status: item.status,
          }))
        : [],
    ),
    commands: items.flatMap((item) =>
      item.type === "command_execution" && item.status !== "in_progress"
        ? [
            {
              itemId: item.id,
              command: item.command,
              status: item.status,
              exitCode: item.exit_code ?? null,
            },
          ]
        : [],
    ),
  };
}

export function unsafeIgnoredWorkspaceEntries(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3));
}

async function assertCurrentExecutionLedger(
  ledgerFile: string,
  request: AgentRunRequest,
): Promise<void> {
  try {
    const document = JSON.parse(await readFile(ledgerFile, "utf8")) as unknown;
    assertCurrentRunIsQueued(document, request);
  } catch (error) {
    if (error instanceof LiveCodexPreflightError) throw error;
    throw new LiveCodexPreflightError(
      "run_not_dispatchable",
      error instanceof LiveRunStateError
        ? error.message
        : "The execution host could not validate a current queued run from ODEU_CODEX_LEDGER_FILE.",
    );
  }
}

async function preflightLiveRun(request: AgentRunRequest, preflightAt: Date) {
  const workspaceInput = process.env.ODEU_CODEX_WORKSPACE?.trim();
  const codexHomeInput = process.env.ODEU_CODEX_HOME?.trim();
  const ledgerFileInput = process.env.ODEU_CODEX_LEDGER_FILE?.trim();
  const secret = process.env.ODEU_CODEX_AUTH_SECRET?.trim();
  const apiKey =
    process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  const repositoryId = process.env.ODEU_CODEX_REPOSITORY_ID?.trim();
  const targetRef = process.env.ODEU_CODEX_PROMOTION_TARGET_REF?.trim();
  const candidateStoreDirectory =
    process.env.ODEU_CODEX_CANDIDATE_STORE?.trim();
  const artifactSigningKeyId =
    process.env.ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID?.trim();
  const artifactSigningSecret =
    process.env.ODEU_CODEX_ARTIFACT_SIGNING_SECRET?.trim();

  if (
    !workspaceInput ||
    !codexHomeInput ||
    !ledgerFileInput ||
    !secret ||
    !repositoryId ||
    !targetRef ||
    !candidateStoreDirectory ||
    !artifactSigningKeyId ||
    !artifactSigningSecret
  ) {
    throw new LiveCodexConfigurationError(
      "Live Codex mode requires its workspace, isolated home, authoritative ledger, run-authority secret, repository identity, promotion target, external candidate store, and artifact-receipt signing configuration.",
    );
  }
  if (!apiKey) {
    throw new LiveCodexConfigurationError(
      "Live Codex mode requires CODEX_API_KEY or OPENAI_API_KEY on the server.",
    );
  }

  const authorization = request.authorization;
  const digest = executionBriefDigest(request.brief);
  if (
    authorization === null ||
    authorization.mode !== "live" ||
    authorization.requestId !== request.requestId ||
    !authorizationWindowIsValid(
      authorization.issuedAt,
      authorization.expiresAt,
      preflightAt,
    ) ||
    authorization.briefDigest !== digest ||
    authorization.baseRevisionId !== request.brief.sourceRevisionId ||
    authorization.artifactBaseRef !== request.brief.artifactBaseRef ||
    !authorizationMatches(authorization, authorization.capability, secret)
  ) {
    throw new LiveCodexPreflightError(
      "authorization_invalid",
      "The live run is not bound to a valid server-issued run authorization.",
    );
  }

  const workspacePath = resolve(workspaceInput);
  const codexHomePath = resolve(codexHomeInput);
  await mkdir(codexHomePath, { recursive: true, mode: 0o700 });
  const [workspace, codexHome] = await Promise.all([
    realpath(workspacePath),
    realpath(codexHomePath),
  ]);
  let ledgerFile: string;
  try {
    ledgerFile = await resolveAuthoritativeLedgerFilePath(ledgerFileInput);
  } catch (error) {
    if (error instanceof AuthoritativeLedgerSymlinkError) {
      throw new LiveCodexConfigurationError(error.message);
    }
    throw error;
  }
  const ledgerDirectory = dirname(ledgerFile);
  if (
    containsPath(workspace, codexHome) ||
    containsPath(codexHome, workspace) ||
    containsPath(workspace, ledgerDirectory) ||
    containsPath(ledgerDirectory, workspace) ||
    containsPath(codexHome, ledgerDirectory) ||
    containsPath(ledgerDirectory, codexHome)
  ) {
    throw new LiveCodexConfigurationError(
      "The Codex workspace, isolated home, and authoritative ledger file must be disjoint.",
    );
  }

  const [gitDirectory, commonDirectory, topLevel] = await Promise.all([
    runPreflightGit(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]),
    runPreflightGit(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    runPreflightGit(workspace, ["rev-parse", "--show-toplevel"]),
  ]);
  if (resolve(topLevel) !== workspace) {
    throw new LiveCodexConfigurationError(
      "ODEU_CODEX_WORKSPACE must be the root of its Git worktree.",
    );
  }
  if (
    containsPath(resolve(gitDirectory), ledgerFile) ||
    containsPath(resolve(commonDirectory), ledgerFile)
  ) {
    throw new LiveCodexConfigurationError(
      "ODEU_CODEX_LEDGER_FILE must be outside the worktree's Git metadata.",
    );
  }
  if (
    resolve(gitDirectory) === resolve(commonDirectory) &&
    process.env.ODEU_CODEX_ALLOW_PRIMARY_WORKTREE !== "true"
  ) {
    throw new LiveCodexConfigurationError(
      "Live Codex requires a linked worktree by default. Use a disposable standalone clone only with ODEU_CODEX_ALLOW_PRIMARY_WORKTREE=true.",
    );
  }

  let workspaceLease: WorkspaceLease;
  try {
    workspaceLease = await acquireWorkspaceLease(
      workspace,
      gitDirectory,
      preflightAt,
    );
  } catch (error) {
    if (error instanceof WorkspaceLeaseUnavailableError) {
      throw new LiveCodexPreflightError(
        "workspace_busy",
        "This live Codex worktree already has an active or unreleased execution lease.",
      );
    }
    throw error;
  }

  try {
    const [observedSha, dirtyState, ignoredState] = await Promise.all([
      runPreflightGit(workspace, ["rev-parse", "HEAD"]),
      runPreflightGit(workspace, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
      runPreflightGit(workspace, [
        "status",
        "--ignored",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ]),
    ]);
    const artifactMatch = request.brief.artifactBaseRef.match(
      /^(?:git|commit):([0-9a-f]{40}|[0-9a-f]{64})$/,
    );
    if (!artifactMatch || artifactMatch[1] !== observedSha) {
      throw new LiveCodexPreflightError(
        "artifact_base_mismatch",
        `The authorized artifact base does not match the observed workspace HEAD (${observedSha}).`,
      );
    }
    if (dirtyState) {
      throw new LiveCodexPreflightError(
        "workspace_dirty",
        "The live Codex worktree has tracked or untracked changes and is not an exact execution artifact.",
      );
    }
    const unsafeIgnored = unsafeIgnoredWorkspaceEntries(ignoredState);
    if (unsafeIgnored.length > 0) {
      throw new LiveCodexPreflightError(
        "workspace_private_data",
        "The live Codex worktree contains ignored data; prepare a hermetic worktree with its toolchain outside the worker-visible workspace.",
      );
    }

    try {
      await claimQueuedRunAuthorization(
        ledgerDirectory,
        authorization,
        () => assertCurrentExecutionLedger(ledgerFile, request),
        preflightAt,
      );
    } catch (error) {
      if (error instanceof RunAuthorizationConsumedError) {
        throw new LiveCodexPreflightError(
          "authorization_consumed",
          "This live run was already claimed; authorize a new run instead of repeating unknown side effects.",
        );
      }
      if (error instanceof RunClaimBusyError) {
        throw new LiveCodexPreflightError(
          "run_claim_busy",
          "This live run has an in-progress dispatch or pre-dispatch status mutation; execution failed closed.",
        );
      }
      throw error;
    }

    return {
      apiKey,
      workspace,
      codexHome,
      runId: authorization.runId,
      observedArtifactBaseRef: `git:${observedSha}`,
      observedCommit: observedSha,
      repositoryId,
      targetRef,
      candidateStoreDirectory,
      artifactSigning: {
        keyId: artifactSigningKeyId,
        secret: artifactSigningSecret,
      },
      workspaceLease,
    };
  } catch (error) {
    await workspaceLease.release();
    throw error;
  }
}

type LiveCodexOptions = {
  now?: () => Date;
};

export async function runLiveCodex(
  request: AgentRunRequest,
  options: LiveCodexOptions = {},
): Promise<AgentRunSuccess> {
  assertCodexRequestMode(request, "live");
  const now = options.now ?? (() => new Date());
  const {
    apiKey,
    workspace,
    codexHome,
    runId,
    observedArtifactBaseRef,
    observedCommit,
    repositoryId,
    targetRef,
    candidateStoreDirectory,
    artifactSigning,
    workspaceLease,
  } = await preflightLiveRun(request, now());

  try {
    const startedAt = now().toISOString();
    const codex = new Codex({
      apiKey,
      env: isolatedEnvironment(codexHome),
      config: {
        shell_environment_policy: isolatedWorkerShellEnvironment(codexHome),
      },
    });
    const model = process.env.ODEU_CODEX_MODEL?.trim();
    const thread = codex.startThread({
      workingDirectory: workspace,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      ...(model ? { model } : {}),
    });
    const streamed = await thread.runStreamed(
      compileCodexPrompt(request.brief),
      {
        outputSchema: z.toJSONSchema(CodexReportedResultSchema),
      },
    );
    const items: ThreadItem[] = [];
    let finalResponse = "";
    let receivedRecorded = false;
    let workingRecorded = false;
    const lifecycle: AgentLifecycleEvent[] = [
      {
        sequence: 0,
        status: "queued",
        at: startedAt,
        label: "Brief queued",
        detail:
          "The authorized brief entered the live Codex adapter after preflight checks.",
      },
    ];

    for await (const event of streamed.events) {
      if (event.type === "thread.started" && !receivedRecorded) {
        receivedRecorded = true;
        lifecycle.push({
          sequence: lifecycle.length,
          status: "received",
          at: now().toISOString(),
          label: "Brief received",
          detail: "The Codex SDK reported that the worker thread started.",
        });
      } else if (
        (event.type === "item.started" || event.type === "item.completed") &&
        !workingRecorded
      ) {
        workingRecorded = true;
        lifecycle.push({
          sequence: lifecycle.length,
          status: "working",
          at: now().toISOString(),
          label: "Working",
          detail: "The Codex SDK emitted the first worker item.",
        });
      }

      if (event.type === "item.completed") {
        items.push(event.item);
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
      } else if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    let reported: z.infer<typeof CodexReportedResultSchema>;
    try {
      reported = CodexReportedResultSchema.parse(JSON.parse(finalResponse));
    } catch (error) {
      throw new Error(
        `Codex returned a worker result that failed validation: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    if (
      reported.completionClaim.criteriaClaimedSatisfied.length !==
      request.brief.doneMeans.length
    ) {
      throw new Error(
        "Codex returned a completion claim whose criteria count does not match the authorized brief.",
      );
    }
    const allowedCheckIds = new Set(
      request.brief.evidenceContract.requiredChecks.map(
        (check) => check.checkId,
      ),
    );
    const reportedCheckIds = reported.claimedChecks.map(
      (check) => check.checkId,
    );
    if (
      new Set(reportedCheckIds).size !== reportedCheckIds.length ||
      reportedCheckIds.some((checkId) => !allowedCheckIds.has(checkId)) ||
      [...allowedCheckIds].some(
        (checkId) => !reportedCheckIds.includes(checkId),
      )
    ) {
      throw new Error(
        "Codex returned check claims that do not correspond one-to-one with the authorized evidence contract.",
      );
    }

    const sdkObservations = observedSdkEvidence(items);
    const sealReturnedCandidate = async (): Promise<ArtifactCandidateReceipt> =>
      (
        await sealLiveWorkspaceCandidate({
          workspace,
          repositoryId,
          targetRef,
          expectedBaseCommit: observedCommit,
          runId,
          briefId: request.brief.briefId,
          baseRevisionId: request.brief.sourceRevisionId,
          sealedAt: now().toISOString(),
          candidateStoreDirectory,
          signing: artifactSigning,
        })
      ).receipt;

    if (reported.outcome === "blocked") {
      lifecycle.push({
        sequence: lifecycle.length,
        status: "blocked",
        at: now().toISOString(),
        label: "Worker blocked",
        detail:
          "The worker returned a resumable domain state, not a closure. The v0 adapter does not implement thread resume.",
      });
      throw new LiveCodexBlockedError(
        AgentBlockedRunSchema.parse({
          runId,
          briefId: request.brief.briefId,
          sourceRevisionIdUsed: request.brief.sourceRevisionId,
          artifactBaseRefUsed: observedArtifactBaseRef,
          workerThreadId: thread.id,
          workerItemIds: items.map((item) => item.id),
          events: lifecycle,
          report: CodexBlockedReportSchema.parse(reported),
          sdkObservations,
          artifactCandidate: null,
        }),
      );
    }

    const terminalStatus =
      reported.outcome === "failed"
        ? "failed"
        : reported.outcome === "cancelled"
          ? "cancelled"
          : "returned";
    lifecycle.push({
      sequence: lifecycle.length,
      status: terminalStatus,
      at: now().toISOString(),
      label:
        terminalStatus === "returned"
          ? "Result returned"
          : terminalStatus === "cancelled"
            ? "Worker cancelled"
            : "Worker failed",
      detail:
        "The terminal worker report is staged as claims and SDK observations; canonical worldstate is unchanged.",
    });

    const artifactCandidate =
      terminalStatus === "returned" ? await sealReturnedCandidate() : null;

    return AgentRunSuccessSchema.parse({
      ok: true,
      runtime: {
        requestedMode: "live",
        effectiveMode: "live",
        status: terminalStatus,
        provider: "codex",
        replayIdentity: null,
        replayKind: null,
      },
      events: lifecycle,
      closure: {
        runId,
        briefId: request.brief.briefId,
        sourceRevisionIdUsed: request.brief.sourceRevisionId,
        artifactBaseRefUsed: observedArtifactBaseRef,
        workerThreadId: thread.id,
        workerItemIds: items.map((item) => item.id),
        report: CodexReportedClosureSchema.parse(reported),
        sdkObservations,
        artifactCandidate,
      },
    });
  } finally {
    await workspaceLease.release();
  }
}
