import "server-only";

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

import type {
  ArtifactCandidateChangedPath,
  ArtifactCandidateMetadata,
  ArtifactCandidateReceipt,
} from "@/adapters/artifact-promotion/schema";
import {
  ArtifactPromotionBoundaryError,
  verifyArtifactCandidateReceipt,
} from "@/adapters/artifact-promotion/server";
import { HOME_MOVE_REPLAY_EVIDENCE_VECTORS } from "@/adapters/replay-evidence/bundle";

import {
  LIVE_EVIDENCE_ARTIFACT_PATH,
  LIVE_EVIDENCE_HARNESS_DIGEST,
  LIVE_EVIDENCE_HARNESS_PROFILE_ID,
  LIVE_EVIDENCE_OUTPUT_EXCERPT_MAX_BYTES,
  LIVE_EVIDENCE_RUNNER_ID,
  LIVE_EVIDENCE_SUPPORT_PATH,
  LIVE_EVIDENCE_TEST_COMMAND,
  LIVE_EVIDENCE_VERIFIER_IDENTITY,
  LiveEvidenceFailureSchema,
  LiveEvidenceRequestSchema,
  LiveEvidenceSuccessSchema,
  type LiveEvidenceBindings,
  type LiveEvidenceCommandOutput,
  type LiveEvidenceExecutionObservation,
  type LiveEvidenceFailure,
  type LiveEvidenceObservation,
  type LiveEvidenceRequest,
  type LiveEvidenceSuccess,
} from "./schema";
import {
  LIVE_EVIDENCE_HARNESS_FILE_NAME,
  LIVE_EVIDENCE_HARNESS_SOURCE,
} from "./harness-source";

const LIVE_EVIDENCE_TEST_LABEL =
  "Focused moving-cost calculation tests pass";
const LIVE_EVIDENCE_ARTIFACT_LABEL =
  "The planning-page artifact change is addressable";
const MAX_GIT_OUTPUT_BYTES = 16 * 1_024 * 1_024;
const MAX_PATCH_BYTES = 16 * 1_024 * 1_024;
const MAX_CANDIDATE_TREE_BYTES = 64 * 1_024 * 1_024;
const MAX_CANDIDATE_TREE_ENTRIES = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 30_000;
const SANDBOX_TMPFS_BYTES = 16_777_216;
const SANDBOX_ADDRESS_SPACE_BYTES = 2_147_483_648;
const SANDBOX_FILE_BYTES = 1_048_576;
const SANDBOX_STACK_BYTES = 8_388_608;
const SANDBOX_MAX_PROCESSES = 16;
const SANDBOX_MAX_OPEN_FILES = 64;
const SANDBOX_CPU_SOFT_SECONDS = 4;
const SANDBOX_CPU_HARD_SECONDS = 5;
const SANDBOX_NODE_OLD_SPACE_MIB = 128;
const SANDBOX_OUTPUT_BYTES = 65_536;
const SANDBOX_VISIBLE_SYSTEM_ROOTS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
] as const;

const SECRET_FREE_TOOL_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  HOME: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/bin:/bin",
  // Candidate repositories are local-only verifier inputs. Never permit an
  // object lookup to select a transport or lazily fetch a missing object.
  GIT_ALLOW_PROTOCOL: "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_TERMINAL_PROMPT: "0",
});

export interface LiveEvidenceRepositoryConfiguration {
  readonly repositoryPath: string;
  /**
   * Optional trusted Node distribution root containing bin/node. Candidate
   * packages and node_modules are never mounted or resolved by the harness.
   */
  readonly toolchainPath?: string;
}

export interface LiveEvidenceVerifierOptions {
  readonly signingSecrets: Readonly<Record<string, string>>;
  readonly repositories: Readonly<
    Record<string, LiveEvidenceRepositoryConfiguration>
  >;
  readonly now?: () => Date;
  readonly commandTimeoutMs?: number;
  readonly runSandbox?: LiveEvidenceSandboxRunner;
}

export interface LiveEvidenceSandboxInput {
  readonly checkoutPath: string;
  readonly supportBlob: string;
  readonly supportByteLength: number;
  readonly toolchainPath?: string;
  readonly timeoutMs: number;
}

export type LiveEvidenceSandboxRunner = (
  input: LiveEvidenceSandboxInput,
) => Promise<LiveEvidenceSandboxResult>;

export interface LiveEvidenceSandboxResult {
  readonly observation: LiveEvidenceExecutionObservation;
  /** A strict server-private harness report is required; exit zero alone is not pass. */
  readonly passed: boolean;
}

type CapturedProcessResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

type RegisteredRequirementIds = {
  readonly test: string;
  readonly artifact: string;
};

export class LiveEvidenceReplayNotApplicableError extends Error {
  constructor() {
    super("Independent live-candidate verification does not accept replay runs.");
    this.name = "LiveEvidenceReplayNotApplicableError";
  }
}

export class LiveEvidenceVerificationFailedError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "LiveEvidenceVerificationFailedError";
    this.issues = issues;
  }
}

export class LiveEvidenceUnavailableError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "LiveEvidenceUnavailableError";
  }
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Matches artifact-promotion's recursively key-sorted receipt encoding. */
export function canonicalArtifactCandidateMetadata(
  value: ArtifactCandidateMetadata,
): string {
  function canonical(valueAtKey: unknown): string {
    if (valueAtKey === null || typeof valueAtKey !== "object") {
      return JSON.stringify(valueAtKey) ?? "null";
    }
    if (Array.isArray(valueAtKey)) {
      return `[${valueAtKey.map((item) => canonical(item)).join(",")}]`;
    }
    const record = valueAtKey as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return canonical(value);
}

function bindingProjection(request: LiveEvidenceRequest): LiveEvidenceBindings {
  return {
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
  };
}

function registeredRequirements(
  request: LiveEvidenceRequest,
): RegisteredRequirementIds {
  if (
    request.expectedArtifacts.length !== 1 ||
    request.expectedArtifacts[0] !== LIVE_EVIDENCE_ARTIFACT_PATH ||
    request.evidenceRequirements.length !== 2
  ) {
    throw new LiveEvidenceVerificationFailedError(
      "No independent live verifier is registered for this artifact contract.",
    );
  }

  const test = request.evidenceRequirements.filter(
    (requirement) =>
      requirement.label === LIVE_EVIDENCE_TEST_LABEL &&
      requirement.kind === "test" &&
      requirement.command === LIVE_EVIDENCE_TEST_COMMAND &&
      requirement.required,
  );
  const artifact = request.evidenceRequirements.filter(
    (requirement) =>
      requirement.label === LIVE_EVIDENCE_ARTIFACT_LABEL &&
      requirement.kind === "artifact" &&
      requirement.command === null &&
      requirement.required,
  );
  if (test.length !== 1 || artifact.length !== 1) {
    throw new LiveEvidenceVerificationFailedError(
      "The live verifier applies only to the exact authored moving-cost evidence contract.",
    );
  }
  return {
    test: test[0]!.requirementId,
    artifact: artifact[0]!.requirementId,
  };
}

function assertReceiptBindings(request: LiveEvidenceRequest): void {
  const metadata = request.candidateReceipt.metadata;
  const issues: string[] = [];
  const equal = (label: string, observed: string, expected: string) => {
    if (observed !== expected) issues.push(`${label} does not match the signed candidate receipt.`);
  };
  equal("runId", request.runId, metadata.runId);
  equal("briefId", request.briefId, metadata.briefId);
  equal("baseRevisionId", request.baseRevisionId, metadata.baseRevisionId);
  equal("artifactBaseRef", request.artifactBaseRef, `git:${metadata.git.baseCommit}`);
  equal("artifactCandidateId", request.artifactCandidateId, metadata.candidateId);
  equal(
    "artifactCandidateCommit",
    request.artifactCandidateCommit,
    metadata.git.candidateCommit,
  );
  if (issues.length > 0) {
    throw new LiveEvidenceVerificationFailedError(
      "The live evidence request is not bound to the signed candidate.",
      issues,
    );
  }
}

function configuredRepository(
  repositoryId: string,
  repositories: LiveEvidenceVerifierOptions["repositories"],
): LiveEvidenceRepositoryConfiguration {
  if (!Object.prototype.hasOwnProperty.call(repositories, repositoryId)) {
    throw new LiveEvidenceVerificationFailedError(
      "The signed candidate names no server-registered repository.",
    );
  }
  const configured = repositories[repositoryId];
  if (!configured?.repositoryPath) {
    throw new LiveEvidenceUnavailableError(
      "The live evidence repository registry is unavailable.",
    );
  }
  return configured;
}

async function trustedDirectory(path: string, label: string): Promise<string> {
  try {
    const resolved = await realpath(path);
    const status = await lstat(resolved);
    if (!status.isDirectory()) {
      throw new LiveEvidenceUnavailableError(`${label} is not a directory.`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof LiveEvidenceUnavailableError) throw error;
    throw new LiveEvidenceUnavailableError(`${label} is unavailable.`, { cause: error });
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const candidateRelative = relative(parent, candidate);
  return (
    candidateRelative === "" ||
    (candidateRelative !== ".." &&
      !candidateRelative.startsWith(`..${sep}`) &&
      !isAbsolute(candidateRelative))
  );
}

async function trustedRegularFile(path: string, label: string): Promise<string> {
  try {
    const resolved = await realpath(path);
    const resolvedStatus = await lstat(resolved);
    if (!resolvedStatus.isFile()) throw new Error("not a regular file");
    return resolved;
  } catch (error) {
    throw new LiveEvidenceUnavailableError(`${label} is unavailable.`, {
      cause: error,
    });
  }
}

function assertSandboxVisibleSystemFile(path: string, label: string): void {
  if (
    !SANDBOX_VISIBLE_SYSTEM_ROOTS.some((root) => containsPath(root, path))
  ) {
    throw new LiveEvidenceUnavailableError(
      `${label} resolves outside the trusted system roots mounted by the sandbox.`,
    );
  }
}

async function spawnBounded(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly extraFileDescriptors?: readonly number[];
}): Promise<CapturedProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    let settled = false;
    let timedOut = false;
    let outputLimited = false;
    let stdoutLength = 0;
    let stderrLength = 0;
    let capturedOutputLength = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, [...input.args], {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: input.environment,
        shell: false,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          ...(input.extraFileDescriptors ?? []),
        ],
      });
    } catch (error) {
      rejectProcess(error);
      return;
    }
    if (!child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      rejectProcess(new Error("The bounded process did not expose output pipes."));
      return;
    }

    const capture = (
      chunk: Buffer,
      chunks: Buffer[],
      length: number,
      setLength: (next: number) => void,
    ) => {
      const remaining = input.outputLimit - capturedOutputLength;
      const captured = Math.min(chunk.byteLength, Math.max(remaining, 0));
      if (captured > 0) chunks.push(chunk.subarray(0, captured));
      capturedOutputLength += captured;
      setLength(length + captured);
      if (chunk.byteLength > remaining) {
        outputLimited = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(chunk, stdout, stdoutLength, (next) => {
        stdoutLength = next;
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(chunk, stderr, stderrLength, (next) => {
        stderrLength = next;
      });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProcess(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProcess({
        exitCode,
        signal,
        timedOut,
        outputLimited,
        stdout: Buffer.concat(stdout, stdoutLength),
        stderr: Buffer.concat(stderr, stderrLength),
      });
    });
  });
}

async function git(
  repositoryPath: string,
  args: readonly string[],
  operation: string,
  outputLimit = MAX_GIT_OUTPUT_BYTES,
): Promise<Buffer> {
  let result: CapturedProcessResult;
  try {
    result = await spawnBounded({
      command: "/usr/bin/git",
      args: [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.allow=never",
        "-C",
        repositoryPath,
        ...args,
      ],
      environment: SECRET_FREE_TOOL_ENVIRONMENT,
      timeoutMs: GIT_TIMEOUT_MS,
      outputLimit,
    });
  } catch (error) {
    throw new LiveEvidenceUnavailableError(
      `Git was unavailable while ${operation}.`,
      { cause: error },
    );
  }
  if (result.timedOut || result.outputLimited) {
    throw new LiveEvidenceVerificationFailedError(
      `The candidate exceeded verifier bounds while ${operation}.`,
    );
  }
  if (result.exitCode !== 0) {
    throw new LiveEvidenceVerificationFailedError(
      `The signed candidate could not be verified while ${operation}.`,
    );
  }
  return result.stdout;
}

const REPOSITORY_INCLUDE_CONFIG = /^(?:include\.path|includeif\..+\.path)$/i;
const PARTIAL_CLONE_HELPER_CONFIG =
  /^(?:extensions\.partialclone|remote\..+\.(?:promisor|partialclonefilter|uploadpack))$/i;

async function assertSafeRepositoryGitConfiguration(
  repositoryPath: string,
): Promise<void> {
  // Inspect the raw local/worktree files without following include paths. Only
  // names are needed, and these probes do not resolve candidate objects or run
  // an upload-pack helper. They must precede every object/ref observation.
  const configuredNames = (
    await Promise.all(
      (["local", "worktree"] as const).map((scope) =>
        git(
          repositoryPath,
          [
            "config",
            "--no-includes",
            `--${scope}`,
            "--null",
            "--name-only",
            "--list",
          ],
          `checking ${scope} repository Git configuration`,
          256 * 1_024,
        ),
      ),
    )
  ).flatMap((raw) =>
    raw
      .toString("utf8")
      .split("\0")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (
    configuredNames.some(
      (name) =>
        REPOSITORY_INCLUDE_CONFIG.test(name) ||
        PARTIAL_CLONE_HELPER_CONFIG.test(name),
    )
  ) {
    throw new LiveEvidenceVerificationFailedError(
      "The live-evidence repository contains unsafe includes or partial-clone helpers.",
    );
  }
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
}

async function observeDirectCommitRef(
  repositoryPath: string,
  ref: string,
): Promise<string> {
  const raw = await git(
    repositoryPath,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00",
      ref,
    ],
    "observing the exact signed candidate ref",
    16 * 1_024,
  );
  const exactRecords = raw
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\0"))
    .filter(([refName]) => refName === ref);
  if (exactRecords.length !== 1) {
    throw new LiveEvidenceVerificationFailedError(
      "The signed candidate ref is absent or is not one exact Git ref.",
    );
  }
  const [refName, objectId, objectType, symbolicTarget, terminator] =
    exactRecords[0] ?? [];
  if (
    refName !== ref ||
    terminator !== "" ||
    !objectId ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)
  ) {
    throw new LiveEvidenceVerificationFailedError(
      "The signed candidate ref returned malformed raw ref data.",
    );
  }
  if (symbolicTarget) {
    throw new LiveEvidenceVerificationFailedError(
      "The signed candidate ref must be a direct Git ref, not a symbolic ref.",
    );
  }
  if (objectType !== "commit") {
    throw new LiveEvidenceVerificationFailedError(
      "The signed candidate ref must point directly to a commit object without tag peeling.",
    );
  }
  return objectId;
}

function zeroObjectId(value: string): boolean {
  return /^0+$/.test(value);
}

function changedMode(value: string): "100644" | "100755" | null {
  if (value === "000000") return null;
  if (value === "100644" || value === "100755") return value;
  throw new LiveEvidenceVerificationFailedError(
    "The candidate contains an unsupported changed-path mode.",
  );
}

function parseChangedPaths(raw: Buffer): ArtifactCandidateChangedPath[] {
  if (raw.byteLength === 0) return [];
  const fields = raw.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: ArtifactCandidateChangedPath[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index];
    const path = fields[index + 1];
    if (!header || !path) {
      throw new LiveEvidenceVerificationFailedError(
        "Git returned an incomplete candidate manifest.",
      );
    }
    const match = header.match(
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(?:\d+)?$/,
    );
    if (!match) {
      throw new LiveEvidenceVerificationFailedError(
        "Git returned an unsupported candidate manifest record.",
      );
    }
    const [, oldModeRaw, newModeRaw, oldBlobRaw, newBlobRaw, statusRaw] = match;
    const status =
      statusRaw === "A"
        ? "added"
        : statusRaw === "D"
          ? "deleted"
          : statusRaw === "M" || statusRaw === "T"
            ? "modified"
            : null;
    if (!status) {
      throw new LiveEvidenceVerificationFailedError(
        "The candidate contains an unsupported changed-path status.",
      );
    }
    entries.push({
      path,
      status,
      oldMode: changedMode(oldModeRaw),
      newMode: changedMode(newModeRaw),
      oldBlob: zeroObjectId(oldBlobRaw) ? null : oldBlobRaw,
      newBlob: zeroObjectId(newBlobRaw) ? null : newBlobRaw,
    });
  }
  return entries;
}

function assertNormalizedSignedManifest(metadata: ArtifactCandidateMetadata): void {
  for (const entry of metadata.manifest.entries) {
    if (
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new LiveEvidenceVerificationFailedError(
        "The signed candidate manifest contains an unsafe artifact path.",
      );
    }
  }
}

async function verifySealedCandidate(
  repositoryPath: string,
  metadata: ArtifactCandidateMetadata,
): Promise<void> {
  const {
    baseCommit,
    baseTree,
    candidateCommit,
    candidateTree,
    objectFormat,
  } = metadata.git;
  const [observedFormat, observedRefCommit, parentLine, observedBaseTree, observedTree] =
    await Promise.all([
      git(repositoryPath, ["rev-parse", "--show-object-format"], "reading the object format"),
      observeDirectCommitRef(repositoryPath, metadata.candidateRef),
      git(
        repositoryPath,
        ["rev-list", "--parents", "-n", "1", candidateCommit],
        "checking the candidate parent",
      ),
      git(
        repositoryPath,
        ["rev-parse", "--verify", `${baseCommit}^{tree}`],
        "checking the base tree",
      ),
      git(
        repositoryPath,
        ["rev-parse", "--verify", `${candidateCommit}^{tree}`],
        "checking the candidate tree",
      ),
    ]);

  const parents = text(parentLine).split(/\s+/);
  const issues: string[] = [];
  if (text(observedFormat) !== objectFormat) issues.push("Git object format mismatch.");
  if (observedRefCommit !== candidateCommit) issues.push("Candidate ref mismatch.");
  if (parents.length !== 2 || parents[0] !== candidateCommit || parents[1] !== baseCommit) {
    issues.push("Candidate commit must have exactly the signed base commit as its parent.");
  }
  if (text(observedBaseTree) !== baseTree) issues.push("Base tree mismatch.");
  if (text(observedTree) !== candidateTree) issues.push("Candidate tree mismatch.");
  if (issues.length > 0) {
    throw new LiveEvidenceVerificationFailedError(
      "The sealed candidate commit does not match its signed receipt.",
      issues,
    );
  }

  assertNormalizedSignedManifest(metadata);
  const rawManifest = await git(
    repositoryPath,
    [
      "diff-tree",
      "-r",
      "--raw",
      "-z",
      "--no-renames",
      "--full-index",
      baseCommit,
      candidateTree,
      "--",
    ],
    "recomputing the candidate manifest",
  );
  const observedEntries = parseChangedPaths(rawManifest).sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  const canonicalObservedEntries = canonicalJson(observedEntries);
  const canonicalSignedEntries = canonicalJson(metadata.manifest.entries);
  if (canonicalObservedEntries !== canonicalSignedEntries) {
    throw new LiveEvidenceVerificationFailedError(
      "The observed candidate changes do not match the signed manifest.",
    );
  }
  if (sha256(canonicalSignedEntries) !== metadata.manifest.digest) {
    throw new LiveEvidenceVerificationFailedError(
      "The signed candidate manifest digest is invalid.",
    );
  }

  if (metadata.patch.byteLength > MAX_PATCH_BYTES) {
    throw new LiveEvidenceVerificationFailedError(
      "The signed candidate patch exceeds the verifier byte limit.",
    );
  }
  const patch = await git(
    repositoryPath,
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      baseCommit,
      candidateTree,
      "--",
    ],
    "recomputing the candidate patch",
    MAX_PATCH_BYTES,
  );
  if (
    patch.byteLength !== metadata.patch.byteLength ||
    sha256(patch) !== metadata.patch.digest
  ) {
    throw new LiveEvidenceVerificationFailedError(
      "The observed candidate patch does not match the signed receipt.",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function observeDeclaredArtifact(
  repositoryPath: string,
  receipt: ArtifactCandidateReceipt,
): Promise<{ readonly blob: string; readonly byteLength: number }> {
  const metadata = receipt.metadata;
  const signedEntry = metadata.manifest.entries.find(
    (entry) =>
      entry.path === LIVE_EVIDENCE_ARTIFACT_PATH &&
      entry.status !== "deleted" &&
      entry.newBlob !== null,
  );
  if (!signedEntry) {
    throw new LiveEvidenceVerificationFailedError(
      "The signed manifest contains no declared moving-cost artifact candidate.",
    );
  }
  const raw = await git(
    repositoryPath,
    ["ls-tree", "-z", metadata.git.candidateCommit, "--", LIVE_EVIDENCE_ARTIFACT_PATH],
    "observing the declared candidate artifact",
  );
  const line = raw.toString("utf8").replace(/\0$/, "");
  const match = line.match(/^([0-9]{6}) blob ([0-9a-f]+)\t(.+)$/);
  if (
    !match ||
    match[3] !== LIVE_EVIDENCE_ARTIFACT_PATH ||
    match[2] !== signedEntry.newBlob ||
    match[1] !== signedEntry.newMode
  ) {
    throw new LiveEvidenceVerificationFailedError(
      "The declared artifact is absent or does not match the signed candidate manifest.",
    );
  }
  const byteLength = Number(
    text(
      await git(
        repositoryPath,
        ["cat-file", "-s", match[2]],
        "measuring the declared candidate artifact",
      ),
    ),
  );
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > 4 * 1_024 * 1_024) {
    throw new LiveEvidenceVerificationFailedError(
      "The declared candidate artifact exceeds the verifier byte limit.",
    );
  }
  return { blob: match[2], byteLength };
}

function utf8Excerpt(bytes: Buffer): { readonly excerpt: string; readonly byteLength: number } {
  let length = Math.min(bytes.byteLength, LIVE_EVIDENCE_OUTPUT_EXCERPT_MAX_BYTES);
  while (length >= 0) {
    const excerpt = bytes.subarray(0, length).toString("utf8");
    const byteLength = Buffer.byteLength(excerpt, "utf8");
    if (byteLength <= LIVE_EVIDENCE_OUTPUT_EXCERPT_MAX_BYTES) {
      return { excerpt, byteLength };
    }
    length -= 1;
  }
  return { excerpt: "", byteLength: 0 };
}

function commandOutput(
  bytes: Buffer,
  forceTruncated = false,
): LiveEvidenceCommandOutput {
  const excerpt = utf8Excerpt(bytes);
  return {
    observedDigest: sha256(bytes),
    observedByteLength: bytes.byteLength,
    excerpt: excerpt.excerpt,
    excerptByteLength: excerpt.byteLength,
    truncated: forceTruncated || excerpt.byteLength !== bytes.byteLength,
  };
}

export function liveEvidenceBubblewrapArguments(input: {
  readonly checkoutPath: string;
  readonly harnessFileDescriptor?: number;
  readonly nodeCommandPath?: string;
  readonly processLimitCommandPath?: string;
  readonly reportNonce?: string;
  readonly toolchainPath?: string;
}): readonly string[] {
  const nodePath =
    input.nodeCommandPath ??
    (input.toolchainPath ? "/toolchain/bin/node" : "/usr/bin/node");
  const processLimitPath = input.processLimitCommandPath ?? "/usr/bin/prlimit";
  const path = input.toolchainPath
    ? "/toolchain/bin:/usr/bin:/bin"
    : "/usr/bin:/bin";
  const harnessFileDescriptor = input.harnessFileDescriptor ?? 3;
  const reportNonce = input.reportNonce ?? "0".repeat(64);
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-user",
    "--unshare-net",
    "--disable-userns",
    "--assert-userns-disabled",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    String(SANDBOX_TMPFS_BYTES),
    "--tmpfs",
    "/tmp",
    ...(input.toolchainPath
      ? ["--ro-bind", input.toolchainPath, "/toolchain"]
      : []),
    "--ro-bind",
    input.checkoutPath,
    "/candidate",
    "--dir",
    "/runner",
    "--perms",
    "0444",
    "--ro-bind-data",
    String(harnessFileDescriptor),
    `/runner/${LIVE_EVIDENCE_HARNESS_FILE_NAME}`,
    "--chdir",
    "/runner",
    "--clearenv",
    "--setenv",
    "PATH",
    path,
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "CI",
    "1",
    "--setenv",
    "NO_COLOR",
    "1",
    processLimitPath,
    "--core=0:0",
    "--memlock=0:0",
    "--msgqueue=0:0",
    `--cpu=${SANDBOX_CPU_SOFT_SECONDS}:${SANDBOX_CPU_HARD_SECONDS}`,
    `--fsize=${SANDBOX_FILE_BYTES}:${SANDBOX_FILE_BYTES}`,
    `--nofile=${SANDBOX_MAX_OPEN_FILES}:${SANDBOX_MAX_OPEN_FILES}`,
    `--nproc=${SANDBOX_MAX_PROCESSES}:${SANDBOX_MAX_PROCESSES}`,
    `--as=${SANDBOX_ADDRESS_SPACE_BYTES}:${SANDBOX_ADDRESS_SPACE_BYTES}`,
    `--stack=${SANDBOX_STACK_BYTES}:${SANDBOX_STACK_BYTES}`,
    "--",
    nodePath,
    "--experimental-vm-modules",
    "--no-addons",
    "--no-warnings",
    "--disable-proto=throw",
    `--max-old-space-size=${SANDBOX_NODE_OLD_SPACE_MIB}`,
    `/runner/${LIVE_EVIDENCE_HARNESS_FILE_NAME}`,
    `/candidate/${LIVE_EVIDENCE_ARTIFACT_PATH}`,
    `/candidate/${LIVE_EVIDENCE_SUPPORT_PATH}`,
    reportNonce,
    LIVE_EVIDENCE_HARNESS_DIGEST,
  ];
}

export async function runRegisteredLiveEvidenceCommand(
  input: LiveEvidenceSandboxInput,
): Promise<LiveEvidenceSandboxResult> {
  if (sha256(LIVE_EVIDENCE_HARNESS_SOURCE) !== LIVE_EVIDENCE_HARNESS_DIGEST) {
    throw new LiveEvidenceUnavailableError(
      "The immutable live-evidence harness does not match its server pin.",
    );
  }
  const configuredNodePath = input.toolchainPath
    ? join(input.toolchainPath, "bin", "node")
    : "/usr/bin/node";
  const [bubblewrapPath, processLimitPath, resolvedNodePath] =
    await Promise.all([
      trustedRegularFile("/usr/bin/bwrap", "The bubblewrap runner"),
      trustedRegularFile("/usr/bin/prlimit", "The process-limit runner"),
      trustedRegularFile(configuredNodePath, "The trusted Node runner"),
    ]);
  assertSandboxVisibleSystemFile(bubblewrapPath, "The bubblewrap runner");
  assertSandboxVisibleSystemFile(processLimitPath, "The process-limit runner");
  if (!input.toolchainPath) {
    assertSandboxVisibleSystemFile(resolvedNodePath, "The trusted Node runner");
  }
  if (
    input.toolchainPath &&
    !containsPath(input.toolchainPath, resolvedNodePath)
  ) {
    throw new LiveEvidenceUnavailableError(
      "The trusted Node runner escapes its registered toolchain root.",
    );
  }
  const nodeCommandPath = input.toolchainPath
    ? join("/toolchain", relative(input.toolchainPath, resolvedNodePath))
    : resolvedNodePath;
  const reportNonce = randomBytes(32).toString("hex");
  const harnessRoot = await mkdtemp(
    join(tmpdir(), "odeu-live-evidence-harness-"),
  );
  const harnessPath = join(harnessRoot, LIVE_EVIDENCE_HARNESS_FILE_NAME);
  let harness: Awaited<ReturnType<typeof open>> | null = null;
  let result: CapturedProcessResult;
  try {
    const writer = await open(harnessPath, "wx", 0o400);
    try {
      await writer.writeFile(LIVE_EVIDENCE_HARNESS_SOURCE, {
        encoding: "utf8",
      });
      await writer.sync();
    } finally {
      await writer.close();
    }
    harness = await open(harnessPath, "r");
    await rm(harnessPath, { force: true });
    result = await spawnBounded({
      command: bubblewrapPath,
      args: liveEvidenceBubblewrapArguments({
        ...input,
        harnessFileDescriptor: 3,
        nodeCommandPath,
        processLimitCommandPath: processLimitPath,
        reportNonce,
      }),
      environment: SECRET_FREE_TOOL_ENVIRONMENT,
      timeoutMs: Number.isFinite(input.timeoutMs)
        ? Math.min(Math.max(Math.trunc(input.timeoutMs), 1), MAX_COMMAND_TIMEOUT_MS)
        : DEFAULT_COMMAND_TIMEOUT_MS,
      outputLimit: SANDBOX_OUTPUT_BYTES,
      extraFileDescriptors: [harness.fd],
    });
  } catch (error) {
    throw new LiveEvidenceUnavailableError(
      "The immutable, resource-bounded live-evidence runner is unavailable.",
      { cause: error },
    );
  } finally {
    await harness?.close().catch(() => undefined);
    await rm(harnessRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  const termination = result.timedOut
    ? "timed_out"
    : result.outputLimited
      ? "output_limited"
      : "exited";
  const startupMarker = Buffer.from(
    `odeu-host-harness-started:${reportNonce}\n`,
    "utf8",
  );
  if (
    result.stderr.byteLength < startupMarker.byteLength ||
    !result.stderr.subarray(0, startupMarker.byteLength).equals(startupMarker)
  ) {
    throw new LiveEvidenceUnavailableError(
      "The required bubblewrap, prlimit, Node, or pinned harness boundary did not start exactly.",
    );
  }
  let reportVerified = false;
  let verifiedCases: LiveEvidenceExecutionObservation["harness"]["cases"] = [];
  if (
    !result.timedOut &&
    !result.outputLimited &&
    result.exitCode === 0
  ) {
    try {
      const observed = JSON.parse(result.stdout.toString("utf8")) as unknown;
      const expected = {
        kind: "odeu.moving-cost-host-harness-report",
        version: 1,
        nonce: reportNonce,
        harnessDigest: LIVE_EVIDENCE_HARNESS_DIGEST,
        passed: true,
        cases: HOME_MOVE_REPLAY_EVIDENCE_VECTORS.map((testCase) => ({
          caseId: testCase.caseId,
          observedTotalCents: testCase.expectedTotalCents,
          expectedTotalCents: testCase.expectedTotalCents,
          result: "passed" as const,
        })),
        detail: `moving-cost immutable host harness verified ${HOME_MOVE_REPLAY_EVIDENCE_VECTORS.length} fixed vectors`,
      };
      reportVerified = canonicalJson(observed) === canonicalJson(expected);
      if (reportVerified) verifiedCases = expected.cases;
    } catch {
      reportVerified = false;
    }
  }
  const observation: LiveEvidenceExecutionObservation = {
    declaredCommand: LIVE_EVIDENCE_TEST_COMMAND,
    executionKind: "sandboxed_candidate",
    runnerId: LIVE_EVIDENCE_RUNNER_ID,
    exitCode: result.exitCode,
    termination,
    stdout: commandOutput(result.stdout, result.outputLimited),
    stderr: commandOutput(result.stderr, result.outputLimited),
    harness: {
      profileId: LIVE_EVIDENCE_HARNESS_PROFILE_ID,
      digest: LIVE_EVIDENCE_HARNESS_DIGEST,
      reportVerified,
      support: {
        path: LIVE_EVIDENCE_SUPPORT_PATH,
        blob: input.supportBlob,
        byteLength: input.supportByteLength,
      },
      cases: verifiedCases,
      isolation: {
        boundary: "bubblewrap-prlimit",
        candidateInputs: "registered_blobs_read_only",
        network: "unshared",
        nestedUserNamespaces: "disabled",
        aggregateCgroupIsolation: false,
        addressSpaceBytesPerProcess: SANDBOX_ADDRESS_SPACE_BYTES,
        cpuSecondsPerProcess: SANDBOX_CPU_HARD_SECONDS,
        processLimitInUserNamespace: SANDBOX_MAX_PROCESSES,
        fileBytesPerProcess: SANDBOX_FILE_BYTES,
        openFilesPerProcess: SANDBOX_MAX_OPEN_FILES,
        tmpfsBytes: SANDBOX_TMPFS_BYTES,
        capturedOutputBytes: SANDBOX_OUTPUT_BYTES,
      },
    },
  };
  return { observation, passed: reportVerified };
}

async function assertCandidateTreeBounded(
  repositoryPath: string,
  candidateCommit: string,
): Promise<void> {
  const raw = await git(
    repositoryPath,
    ["ls-tree", "-r", "-l", "-z", candidateCommit],
    "measuring the candidate tree",
  );
  const entries = raw.toString("utf8").split("\0").filter(Boolean);
  if (entries.length > MAX_CANDIDATE_TREE_ENTRIES) {
    throw new LiveEvidenceVerificationFailedError(
      "The candidate tree exceeds the verifier entry limit.",
    );
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const match = entry.match(/^[0-9]{6} \S+ [0-9a-f]+\s+(\d+|-)\t/);
    if (!match) {
      throw new LiveEvidenceVerificationFailedError(
        "The candidate tree could not be bounded safely.",
      );
    }
    if (match[1] !== "-") totalBytes += Number(match[1]);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CANDIDATE_TREE_BYTES) {
      throw new LiveEvidenceVerificationFailedError(
        "The candidate tree exceeds the verifier byte limit.",
      );
    }
  }
}

async function materializeRegisteredCandidateBlob(input: {
  readonly repositoryPath: string;
  readonly candidateCommit: string;
  readonly path: string;
  readonly maximumBytes: number;
  readonly destination: string;
}): Promise<{ readonly blob: string; readonly byteLength: number }> {
  const rawEntry = await git(
    input.repositoryPath,
    ["ls-tree", "-z", input.candidateCommit, "--", input.path],
    `resolving the registered candidate blob ${input.path}`,
    4 * 1_024,
  );
  const match = rawEntry
    .toString("utf8")
    .match(/^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/u);
  if (!match || match[3] !== input.path) {
    throw new LiveEvidenceVerificationFailedError(
      `The registered candidate input ${input.path} is absent or is not a regular Git blob.`,
    );
  }
  const bytes = await git(
    input.repositoryPath,
    ["cat-file", "blob", match[2]!],
    `reading the registered candidate blob ${input.path}`,
    input.maximumBytes,
  );
  if (bytes.byteLength === 0 || bytes.byteLength > input.maximumBytes) {
    throw new LiveEvidenceVerificationFailedError(
      `The registered candidate input ${input.path} is empty or exceeds its verifier byte limit.`,
    );
  }
  await writeFile(input.destination, bytes, {
    flag: "wx",
    mode: 0o400,
  });
  return { blob: match[2]!, byteLength: bytes.byteLength };
}

async function withRegisteredCandidateInputs<T>(input: {
  readonly repositoryPath: string;
  readonly candidateCommit: string;
  readonly use: (
    inputRoot: string,
    support: { readonly blob: string; readonly byteLength: number },
  ) => Promise<T>;
}): Promise<T> {
  await assertCandidateTreeBounded(input.repositoryPath, input.candidateCommit);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "odeu-live-evidence-"));
  const inputRoot = join(temporaryRoot, "candidate-inputs");
  const demoDirectory = join(inputRoot, "demo");
  await mkdir(demoDirectory, { recursive: true, mode: 0o700 });
  try {
    const [, support] = await Promise.all([
      materializeRegisteredCandidateBlob({
        ...input,
        path: LIVE_EVIDENCE_ARTIFACT_PATH,
        maximumBytes: 4 * 1_024 * 1_024,
        destination: join(inputRoot, LIVE_EVIDENCE_ARTIFACT_PATH),
      }),
      materializeRegisteredCandidateBlob({
        ...input,
        path: LIVE_EVIDENCE_SUPPORT_PATH,
        maximumBytes: 128 * 1_024,
        destination: join(inputRoot, LIVE_EVIDENCE_SUPPORT_PATH),
      }),
    ]);
    return await input.use(inputRoot, support);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function artifactEvidenceRef(request: LiveEvidenceRequest): string {
  const metadata = request.candidateReceipt.metadata;
  return `git-candidate://${encodeURIComponent(metadata.repositoryId)}/${metadata.git.candidateCommit}/artifacts/${encodeURIComponent(LIVE_EVIDENCE_ARTIFACT_PATH)}`;
}

function commandEvidenceRef(
  request: LiveEvidenceRequest,
  requirementId: string,
): string {
  const metadata = request.candidateReceipt.metadata;
  return `git-candidate://${encodeURIComponent(metadata.repositoryId)}/${metadata.git.candidateCommit}/checks/${encodeURIComponent(requirementId)}/${LIVE_EVIDENCE_RUNNER_ID}`;
}

export async function verifyLiveEvidence(
  input: LiveEvidenceRequest,
  options: LiveEvidenceVerifierOptions,
): Promise<LiveEvidenceSuccess> {
  const request = LiveEvidenceRequestSchema.parse(input);
  if (request.mode !== "live") throw new LiveEvidenceReplayNotApplicableError();
  const requirementIds = registeredRequirements(request);
  assertReceiptBindings(request);

  if (Object.keys(options.signingSecrets).length === 0) {
    throw new LiveEvidenceUnavailableError(
      "No live-evidence receipt verification keys are configured.",
    );
  }

  let receipt: ArtifactCandidateReceipt;
  try {
    receipt = verifyArtifactCandidateReceipt(
      request.candidateReceipt,
      options.signingSecrets,
      {
        maxChangedPaths: 500,
        maxPatchBytes: MAX_PATCH_BYTES,
      },
    );
  } catch (error) {
    if (error instanceof ArtifactPromotionBoundaryError) {
      throw new LiveEvidenceVerificationFailedError(
        "The candidate receipt signature or integrity validation failed.",
      );
    }
    throw error;
  }
  if (receipt.metadata.candidateId !== request.candidateReceipt.metadata.candidateId) {
    throw new LiveEvidenceVerificationFailedError(
      "The candidate receipt could not be retained exactly after validation.",
    );
  }

  const metadata = receipt.metadata;
  const configured = configuredRepository(metadata.repositoryId, options.repositories);
  const repositoryPath = await trustedDirectory(
    configured.repositoryPath,
    "The registered live-evidence repository",
  );
  await assertSafeRepositoryGitConfiguration(repositoryPath);
  const toolchainPath = configured.toolchainPath
    ? await trustedDirectory(
        configured.toolchainPath,
        "The registered live-evidence toolchain",
      )
    : undefined;
  if (
    toolchainPath &&
    (containsPath(repositoryPath, toolchainPath) ||
      containsPath(toolchainPath, repositoryPath))
  ) {
    throw new LiveEvidenceUnavailableError(
      "The registered live-evidence toolchain must be disjoint from the candidate repository.",
    );
  }

  await verifySealedCandidate(repositoryPath, metadata);
  const artifact = await observeDeclaredArtifact(
    repositoryPath,
    receipt,
  );
  const runSandbox = options.runSandbox ?? runRegisteredLiveEvidenceCommand;
  const sandboxResult = await withRegisteredCandidateInputs({
    repositoryPath,
    candidateCommit: metadata.git.candidateCommit,
    use: (checkoutPath, support) =>
      runSandbox({
        checkoutPath,
        supportBlob: support.blob,
        supportByteLength: support.byteLength,
        ...(toolchainPath ? { toolchainPath } : {}),
        timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      }),
  });
  const execution = sandboxResult.observation;
  const commandPassed =
    sandboxResult.passed &&
    execution.termination === "exited" &&
    execution.exitCode === 0;

  const observationsById = new Map<string, LiveEvidenceObservation>();
  observationsById.set(requirementIds.artifact, {
    requirementId: requirementIds.artifact,
    result: "passed",
    evidenceRef: artifactEvidenceRef(request),
    detail:
      "The verifier independently observed the declared artifact blob at the sealed candidate commit.",
    artifact: {
      path: LIVE_EVIDENCE_ARTIFACT_PATH,
      blob: artifact.blob,
      byteLength: artifact.byteLength,
    },
    execution: null,
  });
  observationsById.set(requirementIds.test, {
    requirementId: requirementIds.test,
    result: commandPassed ? "passed" : "failed",
    evidenceRef: commandEvidenceRef(request, requirementIds.test),
    detail: commandPassed
      ? "The immutable host-owned harness passed every registered vector against the exact candidate checkout; the authored npm command was not executed."
      : "The immutable host-owned harness did not pass every registered vector against the exact candidate checkout; the authored npm command was not executed.",
    artifact: null,
    execution,
  });
  const observations = request.evidenceRequirements.map((requirement) => {
    const observation = observationsById.get(requirement.requirementId);
    if (!observation) {
      throw new LiveEvidenceVerificationFailedError(
        "The verifier could not bind an authored live evidence requirement.",
      );
    }
    return observation;
  });

  return LiveEvidenceSuccessSchema.parse({
    ok: true,
    status: observations.every((observation) => observation.result === "passed")
      ? "passed"
      : "failed",
    verifier: {
      identity: LIVE_EVIDENCE_VERIFIER_IDENTITY,
      version: 1,
      kind: "independent_live_candidate",
    },
    bindings: bindingProjection(request),
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
      receiptKeyId: receipt.signature.keyId,
    },
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
    observations,
  });
}

export function parseLiveEvidenceRequest(input: unknown): LiveEvidenceRequest {
  return LiveEvidenceRequestSchema.parse(input);
}

function boundedIssues(issues: readonly string[]): string[] {
  return issues.slice(0, 40).map((issue) => issue.slice(0, 2_000));
}

export function liveEvidenceFailure(error: unknown): LiveEvidenceFailure {
  const replay = error instanceof LiveEvidenceReplayNotApplicableError;
  const failed = error instanceof LiveEvidenceVerificationFailedError;
  const unavailable = error instanceof LiveEvidenceUnavailableError;
  return LiveEvidenceFailureSchema.parse({
    ok: false,
    verifier: {
      identity: LIVE_EVIDENCE_VERIFIER_IDENTITY,
      version: 1,
      kind: "independent_live_candidate",
    },
    error: {
      code: replay
        ? "replay_not_applicable"
        : failed
          ? "verification_failed"
          : "verification_unavailable",
      message: replay
        ? error.message
        : failed
          ? error.message
          : unavailable
            ? "The independent live-candidate verifier is unavailable."
            : "The independent live-candidate verifier is unavailable.",
      issues: failed ? boundedIssues(error.issues) : [],
    },
  });
}
