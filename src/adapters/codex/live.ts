import "server-only";

import { Codex, type ThreadItem } from "@openai/codex-sdk";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export const LIVE_CODEX_PROVIDER_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

export class LiveCodexDeadlineExceededError extends Error {
  constructor(
    readonly timeoutMs: number,
    options: ErrorOptions = {},
  ) {
    super(
      `The live Codex worker exceeded its ${timeoutMs} ms provider deadline.`,
      options,
    );
    this.name = "LiveCodexDeadlineExceededError";
  }
}

function assertLiveCodexProviderTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new LiveCodexConfigurationError(
      `The live Codex provider deadline must be an integer from 1 through ${MAX_TIMER_TIMEOUT_MS} milliseconds.`,
    );
  }
}

export async function withLiveCodexDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = LIVE_CODEX_PROVIDER_TIMEOUT_MS,
): Promise<T> {
  assertLiveCodexProviderTimeout(timeoutMs);

  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new LiveCodexDeadlineExceededError(timeoutMs));
  }, timeoutMs);
  timer.unref();

  try {
    const result = await operation(controller.signal);
    if (expired) throw new LiveCodexDeadlineExceededError(timeoutMs);
    return result;
  } catch (error) {
    if (!expired || error instanceof LiveCodexDeadlineExceededError) {
      throw error;
    }
    throw new LiveCodexDeadlineExceededError(timeoutMs, { cause: error });
  } finally {
    clearTimeout(timer);
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
const GIT_CONFIG_SCAN_CWD =
  process.platform === "win32" ? (process.env.SYSTEMROOT ?? "C:\\") : "/";

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
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
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

async function executePreflightGit(
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
      "-c",
      "protocol.allow=never",
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

function unsafePreflightGitConfigurationKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "include.path" ||
    /^includeif\..+\.path$/.test(normalized) ||
    /^filter\..+\.(?:clean|smudge|process)$/.test(normalized) ||
    normalized === "extensions.partialclone" ||
    /^remote\..+\.(?:promisor|partialclonefilter|uploadpack)$/.test(normalized)
  );
}

async function assertSafePreflightGitConfiguration(
  workspace: string,
): Promise<void> {
  // Run the config builtin outside repository discovery and point it at the
  // repository files explicitly. `git -C <workspace> config --no-includes`
  // is insufficient: Git can parse local includes while dispatching the builtin,
  // before that option takes effect.
  const configuredKeys = (
    await Promise.all(
      (await preflightGitConfigurationFiles(workspace)).map(
        async (configurationFile) => {
          let configurationFileStat;
          try {
            configurationFileStat = await lstat(configurationFile);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return "";
            }
            throw error;
          }
          if (!configurationFileStat.isFile()) {
            throw new LiveCodexConfigurationError(
              "Live Codex Git preflight requires regular repository configuration files.",
            );
          }
          const result = await execFile(
            "git",
            [
              "config",
              "--file",
              configurationFile,
              "--no-includes",
              "--null",
              "--name-only",
              "--list",
            ],
            {
              cwd: GIT_CONFIG_SCAN_CWD,
              encoding: "utf8",
              env: isolatedPreflightGitEnvironment(),
            },
          );
          return result.stdout;
        },
      ),
    )
  )
    .join("")
    .split("\0")
    .filter(Boolean);
  if (configuredKeys.some(unsafePreflightGitConfigurationKey)) {
    throw new LiveCodexConfigurationError(
      "Live Codex Git preflight refuses repository/worktree configuration that can include external files, execute filters, or enable repository-controlled object fetching.",
    );
  }
}

async function preflightGitConfigurationFiles(
  workspace: string,
): Promise<string[]> {
  const dotGitPath = resolve(workspace, ".git");
  const dotGitStat = await lstat(dotGitPath);
  let gitDirectory: string;
  if (dotGitStat.isDirectory()) {
    gitDirectory = await realpath(dotGitPath);
  } else if (dotGitStat.isFile()) {
    const pointer = await readFile(dotGitPath, "utf8");
    const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(pointer);
    if (!match) {
      throw new LiveCodexConfigurationError(
        "Live Codex Git preflight could not safely resolve the worktree Git directory.",
      );
    }
    gitDirectory = await realpath(resolve(dirname(dotGitPath), match[1]));
  } else {
    throw new LiveCodexConfigurationError(
      "Live Codex Git preflight requires a regular .git directory or pointer file.",
    );
  }

  let commonDirectory = gitDirectory;
  const commonDirectoryPointerPath = join(gitDirectory, "commondir");
  let commonDirectoryPointerStat;
  try {
    commonDirectoryPointerStat = await lstat(commonDirectoryPointerPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [
        join(commonDirectory, "config"),
        join(gitDirectory, "config.worktree"),
      ];
    }
    throw error;
  }
  if (!commonDirectoryPointerStat.isFile()) {
    throw new LiveCodexConfigurationError(
      "Live Codex Git preflight requires a regular common-directory pointer file.",
    );
  }
  const commonDirectoryPointer = await readFile(
    commonDirectoryPointerPath,
    "utf8",
  );
  const value = commonDirectoryPointer.replace(/\r?\n$/, "");
  if (!value || /[\0\r\n]/.test(value)) {
    throw new LiveCodexConfigurationError(
      "Live Codex Git preflight could not safely resolve the common Git directory.",
    );
  }
  commonDirectory = await realpath(resolve(gitDirectory, value));

  return [
    join(commonDirectory, "config"),
    join(gitDirectory, "config.worktree"),
  ];
}

async function assertNoPreflightIndexGitlinks(
  workspace: string,
): Promise<void> {
  const indexEntries = await executePreflightGit(workspace, [
    "ls-files",
    "--stage",
    "-z",
  ]);
  if (
    indexEntries
      .split("\0")
      .filter(Boolean)
      .some((entry) => entry.startsWith("160000 "))
  ) {
    throw new LiveCodexConfigurationError(
      "Live Codex Git preflight refuses index gitlinks and submodules.",
    );
  }
}

export async function runPreflightGit(
  workspace: string,
  args: readonly string[],
): Promise<string> {
  await assertSafePreflightGitConfiguration(workspace);
  if (args[0] === "status") {
    await assertNoPreflightIndexGitlinks(workspace);
  }
  return executePreflightGit(workspace, args);
}

export async function observeExactDirectTargetCommit(
  workspace: string,
  targetRef: string,
  expectedCommit?: string,
): Promise<string> {
  if (!targetRef.startsWith("refs/")) {
    throw new LiveCodexConfigurationError(
      "ODEU_CODEX_PROMOTION_TARGET_REF must be a valid full Git ref.",
    );
  }
  try {
    await runPreflightGit(workspace, ["check-ref-format", targetRef]);
  } catch (error) {
    if (error instanceof LiveCodexConfigurationError) throw error;
    throw new LiveCodexConfigurationError(
      "ODEU_CODEX_PROMOTION_TARGET_REF must be a valid full Git ref.",
    );
  }

  const [observedHead, rawTargetRefs] = await Promise.all([
    runPreflightGit(workspace, ["rev-parse", "HEAD"]),
    runPreflightGit(workspace, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
      "--count=2",
      "--",
      targetRef,
    ]),
  ]);
  const exactMatches = rawTargetRefs
    .split("\n")
    .filter(Boolean)
    .map((row) => row.split("\0"))
    .filter(([refName]) => refName === targetRef);
  const [match] = exactMatches;
  const [, objectName, objectType, symbolicTarget] = match ?? [];
  if (
    exactMatches.length !== 1 ||
    objectName !== observedHead ||
    objectType !== "commit" ||
    symbolicTarget !== "" ||
    (expectedCommit !== undefined && observedHead !== expectedCommit)
  ) {
    throw new LiveCodexPreflightError(
      "artifact_base_mismatch",
      `The configured promotion target ${targetRef} must remain an exact direct non-symbolic commit ref equal to workspace HEAD.`,
    );
  }

  return observedHead;
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
    const [dirtyState, ignoredState] = await Promise.all([
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
    const observedSha = await observeExactDirectTargetCommit(
      workspace,
      targetRef,
    );
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
  providerTimeoutMs?: number;
};

export async function finalizeLiveCodexWorkspaceLease(
  workspaceLease: WorkspaceLease,
  executionError: unknown,
): Promise<void> {
  if (executionError instanceof LiveCodexDeadlineExceededError) {
    // The SDK only guarantees cancellation of its direct child. A tool descendant
    // may still hold the worktree, so timeout quarantines the workspace until an
    // operator verifies process quiescence and removes the retained marker.
    await workspaceLease.retain();
    return;
  }
  await workspaceLease.release();
}

export async function runLiveCodex(
  request: AgentRunRequest,
  options: LiveCodexOptions = {},
): Promise<AgentRunSuccess> {
  assertCodexRequestMode(request, "live");
  if (options.providerTimeoutMs !== undefined) {
    assertLiveCodexProviderTimeout(options.providerTimeoutMs);
  }
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

  let executionError: unknown;
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
    const { items, finalResponse, lifecycle } = await withLiveCodexDeadline(
      async (signal) => {
        const streamed = await thread.runStreamed(
          compileCodexPrompt(request.brief),
          {
            outputSchema: z.toJSONSchema(CodexReportedResultSchema),
            signal,
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
            (event.type === "item.started" ||
              event.type === "item.completed") &&
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

        return { items, finalResponse, lifecycle };
      },
      options.providerTimeoutMs,
    );

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
    const sealReturnedCandidate = async (): Promise<ArtifactCandidateReceipt> => {
      await observeExactDirectTargetCommit(
        workspace,
        targetRef,
        observedCommit,
      );
      return (
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
    };

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
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    await finalizeLiveCodexWorkspaceLease(workspaceLease, executionError);
  }
}
