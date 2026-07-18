import "server-only";

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import {
  ArtifactCandidateReceiptSchema,
  type ArtifactCandidateReceipt,
} from "@/adapters/artifact-promotion/schema";
import {
  ArtifactPromotionBoundaryError,
  verifyArtifactCandidateReceipt,
} from "@/adapters/artifact-promotion/server";
import {
  parseWorldstateLedgerDocument,
  worldstateStateFromLedgerDocument,
  type WorldstateLedgerDocument,
} from "@/adapters/storage";
import { stableStringify } from "@/domain";
import { authorizedCodexRunRequest } from "@/integration/authorized-codex-run";

import { resolveAuthoritativeLedgerFilePath } from "./ledger-file";
import {
  AgentRuntimeCapabilitySchema,
  LiveAuthorizationRequestSchema,
  LiveRunStatusRequestSchema,
  LiveRunStatusResponseSchema,
  type AgentRuntimeCapability,
  type LiveRunStatusResponse,
} from "./live-authorization";
import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  type AgentRunRequest,
  type AgentRunResponse,
  type AgentRunSuccess,
} from "./schema";

const execFile = promisify(execFileCallback);

export type LiveAuthorityServerErrorCode =
  | "live_not_configured"
  | "workspace_not_ready"
  | "artifact_base_mismatch"
  | "run_not_dispatchable"
  | "authorization_conflict"
  | "authorization_missing"
  | "dispatch_in_progress"
  | "candidate_not_recorded"
  | "outcome_unknown";

export class LiveAuthorityServerError extends Error {
  constructor(
    readonly code: LiveAuthorityServerErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "LiveAuthorityServerError";
  }
}

export interface LiveAuthorityServerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly authorizationTtlMs?: number;
}

export interface VerifiedPrivateLiveCandidate {
  readonly candidate: ArtifactCandidateReceipt;
  readonly request: AgentRunRequest;
  readonly response: AgentRunSuccess;
}

interface PreparedLiveRuntime {
  readonly requestedMode: string;
  readonly workspace: string;
  readonly ledgerFile: string;
  readonly ledgerDirectory: string;
  readonly observedArtifactBaseRef: string;
  readonly secret: string;
}

const PrivateIntentRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().trim().min(1).max(160),
    requestId: z.string().trim().min(1).max(160),
    documentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    request: AgentRunRequestSchema,
    authorizedAt: z.iso.datetime(),
  })
  .strict();

const PrivateDispatchRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().trim().min(1).max(160),
    requestId: z.string().trim().min(1).max(160),
    requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    startedAt: z.iso.datetime(),
  })
  .strict();

const PrivateResponseRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().trim().min(1).max(160),
    requestId: z.string().trim().min(1).max(160),
    response: AgentRunResponseSchema,
    completedAt: z.iso.datetime(),
  })
  .strict();

type PrivateIntentRecord = z.infer<typeof PrivateIntentRecordSchema>;

interface PrivateRunPaths {
  readonly root: string;
  readonly intent: string;
  readonly ledgerSnapshot: string;
  readonly dispatch: string;
  readonly response: string;
  readonly guard: string;
  readonly publicationGuard: string;
  readonly executionClaim: string;
}

const activeDispatches = new Set<string>();

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function runIdentity(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

function requestedMode(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env.ODEU_CODEX_MODE?.trim().toLowerCase() || "replay";
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function git(workspace: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", workspace, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function unsafeIgnoredWorkspaceEntries(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3));
}

async function prepareLiveRuntime(
  options: LiveAuthorityServerOptions = {},
): Promise<PreparedLiveRuntime> {
  const env = options.env ?? process.env;
  const mode = requestedMode(env);
  if (mode !== "live") {
    throw new LiveAuthorityServerError(
      "live_not_configured",
      "The server is not configured for live Codex execution.",
    );
  }

  const workspaceInput = env.ODEU_CODEX_WORKSPACE?.trim();
  const codexHomeInput = env.ODEU_CODEX_HOME?.trim();
  const ledgerInput = env.ODEU_CODEX_LEDGER_FILE?.trim();
  const secret = env.ODEU_CODEX_AUTH_SECRET?.trim();
  const apiKey = env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const repositoryId = env.ODEU_CODEX_REPOSITORY_ID?.trim();
  const targetRef = env.ODEU_CODEX_PROMOTION_TARGET_REF?.trim();
  const candidateStore = env.ODEU_CODEX_CANDIDATE_STORE?.trim();
  const artifactSigningKeyId = env.ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID?.trim();
  const artifactSigningSecret = env.ODEU_CODEX_ARTIFACT_SIGNING_SECRET?.trim();
  if (
    !workspaceInput ||
    !codexHomeInput ||
    !ledgerInput ||
    !secret ||
    !apiKey ||
    !repositoryId ||
    !targetRef ||
    !candidateStore ||
    !artifactSigningKeyId ||
    !artifactSigningSecret
  ) {
    throw new LiveAuthorityServerError(
      "live_not_configured",
      "The live Codex runtime is missing required server-only configuration.",
    );
  }

  try {
    const [workspace, codexHome, ledgerFile] = await Promise.all([
      realpath(resolve(workspaceInput)),
      realpath(resolve(codexHomeInput)),
      resolveAuthoritativeLedgerFilePath(ledgerInput),
    ]);
    const ledgerDirectory = dirname(ledgerFile);
    if (
      containsPath(workspace, codexHome) ||
      containsPath(codexHome, workspace) ||
      containsPath(workspace, ledgerDirectory) ||
      containsPath(ledgerDirectory, workspace) ||
      containsPath(codexHome, ledgerDirectory) ||
      containsPath(ledgerDirectory, codexHome)
    ) {
      throw new Error("runtime paths are not disjoint");
    }

    await git(workspace, ["check-ref-format", targetRef]);
    const [
      gitDirectory,
      commonDirectory,
      topLevel,
      head,
      targetCommit,
      dirty,
      ignored,
    ] = await Promise.all([
      git(workspace, ["rev-parse", "--path-format=absolute", "--git-dir"]),
      git(workspace, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      git(workspace, ["rev-parse", "--show-toplevel"]),
      git(workspace, ["rev-parse", "HEAD"]),
      git(workspace, ["rev-parse", "--verify", `${targetRef}^{commit}`]),
      git(workspace, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
      git(workspace, [
        "status",
        "--ignored",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ]),
    ]);
    if (
      resolve(topLevel) !== workspace ||
      containsPath(resolve(gitDirectory), ledgerFile) ||
      containsPath(resolve(commonDirectory), ledgerFile) ||
      (resolve(gitDirectory) === resolve(commonDirectory) &&
        env.ODEU_CODEX_ALLOW_PRIMARY_WORKTREE !== "true") ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ||
      targetCommit !== head ||
      dirty.length > 0 ||
      unsafeIgnoredWorkspaceEntries(ignored).length > 0
    ) {
      throw new Error("workspace is not an exact prepared execution artifact");
    }

    return {
      requestedMode: mode,
      workspace,
      ledgerFile,
      ledgerDirectory,
      observedArtifactBaseRef: `git:${head}`,
      secret,
    };
  } catch (cause) {
    if (cause instanceof LiveAuthorityServerError) throw cause;
    throw new LiveAuthorityServerError(
      "workspace_not_ready",
      "The live Codex execution workspace is not prepared.",
      { cause },
    );
  }
}

export async function getAgentRuntimeCapability(
  options: LiveAuthorityServerOptions = {},
): Promise<AgentRuntimeCapability> {
  const env = options.env ?? process.env;
  const mode = requestedMode(env);
  if (mode === "replay") {
    return AgentRuntimeCapabilitySchema.parse({
      requestedMode: mode,
      effectiveMode: "replay",
      status: "available",
      artifactBaseRef: null,
      reason: null,
    });
  }
  if (mode !== "live") {
    return AgentRuntimeCapabilitySchema.parse({
      requestedMode: mode,
      effectiveMode: null,
      status: "unavailable",
      artifactBaseRef: null,
      reason: "The configured Codex mode is not supported.",
    });
  }

  try {
    const runtime = await prepareLiveRuntime(options);
    return AgentRuntimeCapabilitySchema.parse({
      requestedMode: runtime.requestedMode,
      effectiveMode: "live",
      status: "available",
      artifactBaseRef: runtime.observedArtifactBaseRef,
      reason: null,
    });
  } catch (error) {
    return AgentRuntimeCapabilitySchema.parse({
      requestedMode: mode,
      effectiveMode: "live",
      status: "unavailable",
      artifactBaseRef: null,
      reason:
        error instanceof LiveAuthorityServerError &&
        error.code === "live_not_configured"
          ? "Live execution is not fully configured."
          : "The live execution workspace is not prepared.",
    });
  }
}

async function privateRunPaths(
  ledgerFile: string,
  runId: string,
  createRoot = true,
): Promise<PrivateRunPaths> {
  const ledgerDirectory = dirname(ledgerFile);
  const root = resolve(ledgerDirectory, "odeu-live-runs");
  if (createRoot) {
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  let resolvedRoot: string | null = null;
  try {
    resolvedRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (resolvedRoot !== null && resolvedRoot !== root) {
    throw new LiveAuthorityServerError(
      "live_not_configured",
      "The private live-run store is not a direct host path.",
    );
  }
  const identity = runIdentity(runId);
  return {
    root,
    intent: resolve(root, `${identity}.intent.json`),
    ledgerSnapshot: resolve(root, `${identity}.ledger.json`),
    dispatch: resolve(root, `${identity}.dispatch.json`),
    response: resolve(root, `${identity}.response.json`),
    guard: resolve(root, `${identity}.guard`),
    publicationGuard: resolve(root, "publication.guard"),
    executionClaim: resolve(
      ledgerDirectory,
      "odeu-run-claims",
      `${identity}.claimed.json`,
    ),
  };
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readStatusRecord(
  path: string,
): Promise<
  | { readonly posture: "absent" }
  | { readonly posture: "present"; readonly value: unknown }
  | { readonly posture: "unreadable" }
> {
  try {
    return {
      posture: "present",
      value: JSON.parse(await readFile(path, "utf8")) as unknown,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { posture: "absent" };
    }
    return { posture: "unreadable" };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function atomicCreateJson(
  path: string,
  value: unknown,
): Promise<boolean> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function compareAndPublishLedgerSnapshot(
  ledgerFile: string,
  document: WorldstateLedgerDocument,
  expectedCurrentDigest: string,
): Promise<void> {
  // Recheck immediately before replacement so a swapped symlink fails closed.
  const validatedPath = await resolveAuthoritativeLedgerFilePath(ledgerFile);
  const current = await readJsonIfPresent(validatedPath);
  if (current === null || sha256(current) !== expectedCurrentDigest) {
    throw new LiveAuthorityServerError(
      "outcome_unknown",
      "The authoritative execution ledger changed during publication.",
    );
  }
  await atomicWriteJson(validatedPath, document);
  await resolveAuthoritativeLedgerFilePath(validatedPath);
  const published = await readJsonIfPresent(validatedPath);
  if (published === null || sha256(published) !== sha256(document)) {
    throw new LiveAuthorityServerError(
      "outcome_unknown",
      "The authoritative execution ledger could not be verified after publication.",
    );
  }
}

async function publishExactLedgerUnderGuard(
  ledgerFile: string,
  document: WorldstateLedgerDocument,
): Promise<void> {
  const validatedPath = await resolveAuthoritativeLedgerFilePath(ledgerFile);
  const observed = await readJsonIfPresent(validatedPath);
  if (observed === null) {
    throw new LiveAuthorityServerError(
      "outcome_unknown",
      "The authoritative execution ledger disappeared before publication.",
    );
  }
  if (sha256(observed) === sha256(document)) {
    await resolveAuthoritativeLedgerFilePath(validatedPath);
    return;
  }
  await compareAndPublishLedgerSnapshot(
    validatedPath,
    document,
    sha256(observed),
  );
}

async function ensureImmutableLedgerSnapshot(
  paths: PrivateRunPaths,
  document: WorldstateLedgerDocument,
  documentDigest: string,
): Promise<void> {
  const existing = await readJsonIfPresent(paths.ledgerSnapshot);
  if (existing !== null) {
    if (sha256(existing) !== documentDigest) {
      throw new LiveAuthorityServerError(
        "authorization_conflict",
        "This live run already has a different private ledger snapshot.",
      );
    }
    return;
  }

  const created = await atomicCreateJson(paths.ledgerSnapshot, document);
  if (created) return;
  const raced = await readJsonIfPresent(paths.ledgerSnapshot);
  if (raced === null || sha256(raced) !== documentDigest) {
    throw new LiveAuthorityServerError(
      "authorization_conflict",
      "This live run already has a different private ledger snapshot.",
    );
  }
}

async function withPublicationGuard<T>(
  paths: PrivateRunPaths,
  operationKind: "authorization" | "dispatch",
  operation: () => Promise<T>,
): Promise<T> {
  let guard;
  try {
    guard = await open(paths.publicationGuard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const busyCode =
        operationKind === "dispatch" && activeDispatches.has(paths.guard)
          ? "dispatch_in_progress"
          : "outcome_unknown";
      throw new LiveAuthorityServerError(
        busyCode,
        busyCode === "dispatch_in_progress"
          ? "The live run dispatch is already in progress."
          : "The shared live ledger has an unreconciled prior operation.",
      );
    }
    throw error;
  }

  try {
    await guard.writeFile(
      `${JSON.stringify({ acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await guard.sync();
    return await operation();
  } finally {
    await guard.close();
    await unlink(paths.publicationGuard);
  }
}

async function withRunGuard<T>(
  paths: PrivateRunPaths,
  operation: () => Promise<T>,
): Promise<T> {
  let guard;
  try {
    guard = await open(paths.guard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LiveAuthorityServerError(
        activeDispatches.has(paths.guard)
          ? "dispatch_in_progress"
          : "outcome_unknown",
        activeDispatches.has(paths.guard)
          ? "The live run dispatch is already in progress."
          : "The live run has an unreconciled prior operation.",
      );
    }
    throw error;
  }

  try {
    await guard.writeFile(
      `${JSON.stringify({ acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await guard.sync();
    return await operation();
  } finally {
    await guard.close();
    await unlink(paths.guard);
  }
}

function exactIntentMatches(
  intent: PrivateIntentRecord,
  request: AgentRunRequest,
): boolean {
  return (
    intent.runId === request.runId &&
    intent.requestId === request.requestId &&
    stableStringify(intent.request) === stableStringify(request)
  );
}

export async function authorizeAndPublishLiveRun(
  input: unknown,
  options: LiveAuthorityServerOptions = {},
): Promise<AgentRunRequest> {
  const bounded = LiveAuthorizationRequestSchema.parse(input);
  const document = parseWorldstateLedgerDocument(bounded.document);
  const runtime = await prepareLiveRuntime(options);
  const state = worldstateStateFromLedgerDocument(document);
  let request: AgentRunRequest;
  try {
    request = authorizedCodexRunRequest({
      state,
      runId: bounded.runId,
      requestId: bounded.requestId,
      secret: runtime.secret,
      now: options.now?.() ?? new Date(),
      nonce: options.nonce?.(),
      authorizationTtlMs: options.authorizationTtlMs,
    });
  } catch (cause) {
    throw new LiveAuthorityServerError(
      "run_not_dispatchable",
      "The supplied ledger does not authorize this queued live run.",
      { cause },
    );
  }
  if (request.brief.artifactBaseRef !== runtime.observedArtifactBaseRef) {
    throw new LiveAuthorityServerError(
      "artifact_base_mismatch",
      "The queued run artifact base does not match the prepared workspace.",
    );
  }

  const paths = await privateRunPaths(runtime.ledgerFile, bounded.runId);
  const documentDigest = sha256(document);
  return withPublicationGuard(paths, "authorization", () =>
    withRunGuard(paths, async () => {
      const existingRaw = await readJsonIfPresent(paths.intent);
      if (existingRaw !== null) {
        const existing = PrivateIntentRecordSchema.safeParse(existingRaw);
        if (
          !existing.success ||
          existing.data.requestId !== bounded.requestId ||
          existing.data.documentDigest !== documentDigest
        ) {
          throw new LiveAuthorityServerError(
            "authorization_conflict",
            "This live run already has a different private authorization intent.",
          );
        }
        const privateSnapshot = await readJsonIfPresent(paths.ledgerSnapshot);
        if (
          privateSnapshot === null ||
          sha256(privateSnapshot) !== documentDigest
        ) {
          throw new LiveAuthorityServerError(
            "outcome_unknown",
            "This live run no longer has its exact private ledger snapshot.",
          );
        }
        return existing.data.request;
      }
      if (await exists(paths.executionClaim)) {
        throw new LiveAuthorityServerError(
          "outcome_unknown",
          "This live run has a dispatch claim without a durable response.",
        );
      }

      await ensureImmutableLedgerSnapshot(paths, document, documentDigest);
      await publishExactLedgerUnderGuard(runtime.ledgerFile, document);
      const intent = PrivateIntentRecordSchema.parse({
        version: 1,
        runId: bounded.runId,
        requestId: bounded.requestId,
        documentDigest,
        request,
        authorizedAt: options.now?.().toISOString() ?? new Date().toISOString(),
      });
      await atomicWriteJson(paths.intent, intent);
      return request;
    }),
  );
}

async function configuredLedgerFile(
  options: LiveAuthorityServerOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const ledgerInput = env.ODEU_CODEX_LEDGER_FILE?.trim();
  if (!ledgerInput) {
    throw new LiveAuthorityServerError(
      "live_not_configured",
      "The private live-run store is not configured.",
    );
  }
  try {
    return await resolveAuthoritativeLedgerFilePath(ledgerInput);
  } catch (cause) {
    throw new LiveAuthorityServerError(
      "live_not_configured",
      "The private live-run store is not available.",
      { cause },
    );
  }
}

/**
 * Executes only the exact server-issued intent. The private dispatch marker is
 * durable before execution; a crash therefore becomes outcome_unknown rather
 * than an accidental retry. The exact typed response is durable before return.
 */
export async function dispatchAuthorizedLiveRequest(
  requestInput: AgentRunRequest,
  execute: () => Promise<AgentRunResponse>,
  options: LiveAuthorityServerOptions = {},
): Promise<AgentRunResponse> {
  const request = AgentRunRequestSchema.parse(requestInput);
  if (request.mode !== "live" || request.authorization === null) {
    throw new LiveAuthorityServerError(
      "authorization_missing",
      "A live dispatch requires an exact server-issued authorization intent.",
    );
  }
  const ledgerFile = await configuredLedgerFile(options);
  const paths = await privateRunPaths(ledgerFile, request.runId);

  const [intentBeforeGuardRaw, completedBeforeGuardRaw] = await Promise.all([
    readJsonIfPresent(paths.intent),
    readJsonIfPresent(paths.response),
  ]);
  const intentBeforeGuard =
    PrivateIntentRecordSchema.safeParse(intentBeforeGuardRaw);
  const completedBeforeGuard = PrivateResponseRecordSchema.safeParse(
    completedBeforeGuardRaw,
  );
  if (
    intentBeforeGuard.success &&
    exactIntentMatches(intentBeforeGuard.data, request) &&
    completedBeforeGuard.success &&
    completedBeforeGuard.data.runId === request.runId &&
    completedBeforeGuard.data.requestId === request.requestId
  ) {
    return completedBeforeGuard.data.response;
  }

  return withPublicationGuard(paths, "dispatch", () =>
    withRunGuard(paths, async () => {
      const intent = PrivateIntentRecordSchema.safeParse(
        await readJsonIfPresent(paths.intent),
      );
      if (!intent.success || !exactIntentMatches(intent.data, request)) {
        throw new LiveAuthorityServerError(
          "authorization_missing",
          "The live request does not match a private server-issued intent.",
        );
      }

      const response = PrivateResponseRecordSchema.safeParse(
        await readJsonIfPresent(paths.response),
      );
      if (
        response.success &&
        response.data.runId === request.runId &&
        response.data.requestId === request.requestId
      ) {
        return response.data.response;
      }
      if (
        (await exists(paths.dispatch)) ||
        (await exists(paths.executionClaim))
      ) {
        throw new LiveAuthorityServerError(
          "outcome_unknown",
          "The live run has durable execution evidence but no durable response.",
        );
      }

      const privateSnapshotRaw = await readJsonIfPresent(paths.ledgerSnapshot);
      if (
        privateSnapshotRaw === null ||
        sha256(privateSnapshotRaw) !== intent.data.documentDigest
      ) {
        throw new LiveAuthorityServerError(
          "outcome_unknown",
          "The live run no longer has its exact private ledger snapshot.",
        );
      }
      let privateSnapshot: WorldstateLedgerDocument;
      try {
        privateSnapshot = parseWorldstateLedgerDocument(privateSnapshotRaw);
      } catch (cause) {
        throw new LiveAuthorityServerError(
          "outcome_unknown",
          "The live run private ledger snapshot is unreadable.",
          { cause },
        );
      }
      await publishExactLedgerUnderGuard(ledgerFile, privateSnapshot);

      await atomicWriteJson(
        paths.dispatch,
        PrivateDispatchRecordSchema.parse({
          version: 1,
          runId: request.runId,
          requestId: request.requestId,
          requestDigest: sha256(request),
          startedAt: options.now?.().toISOString() ?? new Date().toISOString(),
        }),
      );
      activeDispatches.add(paths.guard);
      try {
        const exactResponse = AgentRunResponseSchema.parse(await execute());
        await atomicWriteJson(
          paths.response,
          PrivateResponseRecordSchema.parse({
            version: 1,
            runId: request.runId,
            requestId: request.requestId,
            response: exactResponse,
            completedAt:
              options.now?.().toISOString() ?? new Date().toISOString(),
          }),
        );
        return exactResponse;
      } finally {
        activeDispatches.delete(paths.guard);
      }
    }),
  );
}

/**
 * Establishes that a signed staged candidate came from the exact private,
 * completed, returned live response for its run. Browser ledger actor labels
 * are deliberately irrelevant to this server-private provenance check.
 */
export async function verifyPrivateCompletedLiveCandidate(
  candidateInput: ArtifactCandidateReceipt,
  options: LiveAuthorityServerOptions = {},
): Promise<VerifiedPrivateLiveCandidate> {
  const candidate = ArtifactCandidateReceiptSchema.parse(candidateInput);
  const env = options.env ?? process.env;
  const keyId = env.ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID?.trim();
  const secret = env.ODEU_CODEX_ARTIFACT_SIGNING_SECRET?.trim();
  if (!keyId || !secret) {
    throw new LiveAuthorityServerError(
      "live_not_configured",
      "Private live-candidate verification is not configured.",
    );
  }
  try {
    verifyArtifactCandidateReceipt(candidate, { [keyId]: secret });
  } catch (cause) {
    if (cause instanceof ArtifactPromotionBoundaryError) {
      throw new LiveAuthorityServerError(
        cause.code === "invalid_configuration"
          ? "live_not_configured"
          : "candidate_not_recorded",
        cause.code === "invalid_configuration"
          ? "Private live-candidate verification is not configured."
          : "The supplied candidate receipt is not an intact signed live candidate.",
        { cause },
      );
    }
    throw cause;
  }

  const ledgerFile = await configuredLedgerFile(options);
  const paths = await privateRunPaths(
    ledgerFile,
    candidate.metadata.runId,
    false,
  );
  const [intentRecord, dispatchRecord, responseRecord, privateLedgerSnapshot] =
    await Promise.all([
      readStatusRecord(paths.intent),
      readStatusRecord(paths.dispatch),
      readStatusRecord(paths.response),
      readStatusRecord(paths.ledgerSnapshot),
    ]);
  const intent =
    intentRecord.posture === "present"
      ? PrivateIntentRecordSchema.safeParse(intentRecord.value)
      : null;
  const dispatch =
    dispatchRecord.posture === "present"
      ? PrivateDispatchRecordSchema.safeParse(dispatchRecord.value)
      : null;
  const completed =
    responseRecord.posture === "present"
      ? PrivateResponseRecordSchema.safeParse(responseRecord.value)
      : null;
  const snapshot =
    privateLedgerSnapshot.posture === "present"
      ? privateLedgerSnapshot.value
      : null;
  if (
    !intent?.success ||
    !dispatch?.success ||
    !completed?.success ||
    snapshot === null
  ) {
    throw new LiveAuthorityServerError(
      "candidate_not_recorded",
      "The candidate has no exact complete private live-run provenance chain.",
    );
  }

  const request = intent.data.request;
  const response = completed.data.response;
  const responseCandidate = response.ok
    ? response.closure.artifactCandidate
    : null;
  if (
    request.mode !== "live" ||
    request.authorization === null ||
    intent.data.runId !== candidate.metadata.runId ||
    request.runId !== candidate.metadata.runId ||
    request.brief.briefId !== candidate.metadata.briefId ||
    request.brief.sourceRevisionId !== candidate.metadata.baseRevisionId ||
    request.brief.artifactBaseRef !==
      `git:${candidate.metadata.git.baseCommit}` ||
    dispatch.data.runId !== request.runId ||
    dispatch.data.requestId !== request.requestId ||
    dispatch.data.requestDigest !== sha256(request) ||
    completed.data.runId !== request.runId ||
    completed.data.requestId !== request.requestId ||
    sha256(snapshot) !== intent.data.documentDigest ||
    !response.ok ||
    response.runtime.requestedMode !== "live" ||
    response.runtime.effectiveMode !== "live" ||
    response.runtime.status !== "returned" ||
    response.closure.runId !== request.runId ||
    response.closure.briefId !== request.brief.briefId ||
    response.closure.sourceRevisionIdUsed !== request.brief.sourceRevisionId ||
    response.closure.artifactBaseRefUsed !== request.brief.artifactBaseRef ||
    response.closure.report.outcome !== "returned" ||
    responseCandidate === null ||
    stableStringify(responseCandidate) !== stableStringify(candidate)
  ) {
    throw new LiveAuthorityServerError(
      "candidate_not_recorded",
      "The supplied candidate does not match an exact private returned live response.",
    );
  }
  return { candidate, request, response };
}

export async function getLiveRunStatus(
  input: unknown,
  options: LiveAuthorityServerOptions = {},
): Promise<LiveRunStatusResponse> {
  const query = LiveRunStatusRequestSchema.parse(input);
  const ledgerFile = await configuredLedgerFile(options);
  const paths = await privateRunPaths(ledgerFile, query.runId, false);
  const [intentRecord, responseRecord] = await Promise.all([
    readStatusRecord(paths.intent),
    readStatusRecord(paths.response),
  ]);
  const intent =
    intentRecord.posture === "present"
      ? PrivateIntentRecordSchema.safeParse(intentRecord.value)
      : null;
  const response =
    responseRecord.posture === "present"
      ? PrivateResponseRecordSchema.safeParse(responseRecord.value)
      : null;
  if (
    intent?.success &&
    intent.data.requestId === query.requestId &&
    response?.success &&
    response.data.runId === query.runId &&
    response.data.requestId === query.requestId
  ) {
    return LiveRunStatusResponseSchema.parse({
      status: "completed",
      response: response.data.response,
    });
  }

  const hasExecutionEvidence =
    activeDispatches.has(paths.guard) ||
    (await exists(paths.dispatch)) ||
    (await exists(paths.executionClaim)) ||
    (await exists(paths.guard)) ||
    responseRecord.posture !== "absent";
  if (
    intentRecord.posture === "unreadable" ||
    (intentRecord.posture === "present" && !intent?.success) ||
    responseRecord.posture === "unreadable" ||
    (responseRecord.posture === "present" && !response?.success)
  ) {
    return LiveRunStatusResponseSchema.parse({
      status: "outcome_unknown",
      response: null,
    });
  }
  if (!intent?.success || intent.data.requestId !== query.requestId) {
    return LiveRunStatusResponseSchema.parse({
      status: hasExecutionEvidence ? "outcome_unknown" : "not_started",
      response: null,
    });
  }
  if (activeDispatches.has(paths.guard)) {
    return LiveRunStatusResponseSchema.parse({
      status: "in_progress",
      response: null,
    });
  }
  if (hasExecutionEvidence) {
    return LiveRunStatusResponseSchema.parse({
      status: "outcome_unknown",
      response: null,
    });
  }
  return LiveRunStatusResponseSchema.parse({
    status: "not_started",
    response: null,
  });
}
