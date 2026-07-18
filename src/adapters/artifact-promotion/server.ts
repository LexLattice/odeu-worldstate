import "server-only";

import { execFile } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";

import {
  ArtifactCandidateMetadataSchema,
  ArtifactCandidateReceiptSchema,
  ArtifactReceiptSignatureSchema,
  ArtifactPromotionAttemptReceiptSchema,
  ArtifactPromotionReceiptSchema,
  type ArtifactCandidateChangedPath,
  type ArtifactCandidateMetadata,
  type ArtifactCandidateReceipt,
  type ArtifactPromotionAttemptReceipt,
  type ArtifactPromotionReceipt,
} from "./schema";
import { artifactPromotionId } from "./identity";

export {
  artifactPromotionId,
  type ArtifactPromotionIdentityMaterial,
} from "./identity";

export interface ArtifactCandidateLimits {
  readonly maxChangedPaths: number;
  readonly maxPathBytes: number;
  readonly maxPatchBytes: number;
  readonly maxManifestBytes: number;
  readonly maxReceiptBytes: number;
}

export const DEFAULT_ARTIFACT_CANDIDATE_LIMITS: ArtifactCandidateLimits = {
  maxChangedPaths: 256,
  maxPathBytes: 1_024,
  maxPatchBytes: 4 * 1_024 * 1_024,
  maxManifestBytes: 256 * 1_024,
  maxReceiptBytes: 512 * 1_024,
};

export const ARTIFACT_PROMOTION_REPOSITORY_LOCK =
  "odeu-artifact-promotion.lock";

const ARTIFACT_PROMOTION_LOCK_WAIT_MS = 30_000;
const ARTIFACT_PROMOTION_LOCK_POLL_MS = 20;

export type ArtifactCandidateSealErrorCode =
  | "no_changes"
  | "base_mismatch"
  | "unsafe_path"
  | "unsupported_mode"
  | "ignored_content"
  | "evidence_oversized"
  | "candidate_conflict"
  | "invalid_configuration"
  | "git_failed";

export class ArtifactCandidateSealError extends Error {
  constructor(
    readonly code: ArtifactCandidateSealErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ArtifactCandidateSealError";
  }
}

export class ArtifactPromotionBoundaryError extends Error {
  constructor(
    readonly code:
      | "candidate_invalid"
      | "binding_mismatch"
      | "invalid_configuration"
      | "status_conflict",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ArtifactPromotionBoundaryError";
  }
}

export class ArtifactPromotionOutcomeUnknownError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ArtifactPromotionOutcomeUnknownError";
  }
}

export type ArtifactSigningSecret = string | Uint8Array;

export interface ArtifactCandidateSigningInput {
  readonly keyId: string;
  readonly secret: ArtifactSigningSecret;
}

export interface SealLiveWorkspaceCandidateInput {
  readonly workspace: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly expectedBaseCommit: string;
  readonly runId: string;
  readonly briefId: string;
  readonly baseRevisionId: string;
  readonly sealedAt: string;
  readonly candidateStoreDirectory: string;
  readonly signing: ArtifactCandidateSigningInput;
  readonly limits?: Partial<ArtifactCandidateLimits>;
}

export interface SealedLiveWorkspaceCandidate {
  readonly receipt: ArtifactCandidateReceipt;
  readonly receiptPath: string;
}

export interface PromoteArtifactCandidateInput {
  readonly repository: string;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly expectedBaseCommit: string;
  readonly candidate: ArtifactCandidateReceipt;
  readonly signingSecrets: Readonly<Record<string, ArtifactSigningSecret>>;
  readonly statusStoreDirectory: string;
  readonly attemptedAt: string;
  readonly authority: ArtifactPromotionAuthorityBinding;
  readonly limits?: Partial<ArtifactCandidateLimits>;
}

export interface PromotedArtifactCandidate {
  readonly receipt: ArtifactPromotionReceipt;
  readonly receiptPath: string;
}

export interface GetArtifactPromotionStatusInput {
  readonly candidate: ArtifactCandidateReceipt;
  readonly signingSecrets: Readonly<Record<string, ArtifactSigningSecret>>;
  readonly statusStoreDirectory: string;
  readonly authority: ArtifactPromotionAuthorityBinding;
  readonly limits?: Partial<ArtifactCandidateLimits>;
}

export interface ArtifactPromotionAuthorityBinding {
  readonly projectId: string;
  readonly semanticHeadRevisionId: string;
  readonly authorizedEventId: string;
  readonly authorizedAt: string;
  readonly ledgerVersion: {
    readonly headRevisionId: string;
    readonly eventCount: number;
    readonly eventLogFingerprint: string;
  };
  readonly ledgerPrefixDigest: string;
}

export type ArtifactPromotionStatusObservation =
  | {
      readonly state: "absent";
      readonly promotionId: string;
    }
  | {
      readonly state: "authorized_only";
      readonly promotionId: string;
    }
  | {
      readonly state: "attempt_only";
      readonly promotionId: string;
      readonly attempt: ArtifactPromotionAttemptReceipt;
    }
  | {
      readonly state: "completed";
      readonly promotionId: string;
      readonly attempt: ArtifactPromotionAttemptReceipt;
      readonly receipt: ArtifactPromotionReceipt;
    };

export type ArtifactCandidateIdentityMaterial = Omit<
  ArtifactCandidateMetadata,
  "candidateId" | "candidateRef"
>;

interface GitCommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | string | null,
    readonly stderr: Buffer,
    options: ErrorOptions = {},
  ) {
    const detail = stderr.toString("utf8").trim();
    super(
      detail
        ? `Git command failed: ${detail}`
        : "Git command failed without diagnostic output.",
      options,
    );
    this.name = "GitCommandError";
  }
}

const SealInputSchema = z
  .object({
    workspace: z.string().trim().min(1),
    repositoryId: z.string().trim().min(1).max(240),
    targetRef: z.string().trim().min(1).max(1_024),
    expectedBaseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    runId: z.string().trim().min(1).max(240),
    briefId: z.string().trim().min(1).max(240),
    baseRevisionId: z.string().trim().min(1).max(240),
    sealedAt: z.iso.datetime({ offset: true }),
    candidateStoreDirectory: z.string().trim().min(1),
    signing: z
      .object({ keyId: z.string().trim().min(1).max(240) })
      .passthrough(),
  })
  .passthrough();

const PromoteInputSchema = z
  .object({
    repository: z.string().trim().min(1),
    repositoryId: z.string().trim().min(1).max(240),
    targetRef: z.string().trim().min(1).max(1_024),
    expectedBaseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    statusStoreDirectory: z.string().trim().min(1),
    attemptedAt: z.iso.datetime({ offset: true }),
    authority: z
      .object({
        projectId: z.string().trim().min(1).max(160),
        semanticHeadRevisionId: z.string().trim().min(1).max(240),
        authorizedEventId: z.string().trim().min(1).max(240),
        authorizedAt: z.iso.datetime({ offset: true }),
        ledgerVersion: z
          .object({
            headRevisionId: z.string().trim().min(1).max(240),
            eventCount: z.number().int().positive().max(5_000),
            eventLogFingerprint: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
          })
          .strict(),
        ledgerPrefixDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .passthrough();

const ArtifactPromotionAuthorityIntentSchema = z
  .object({
    kind: z.literal("odeu.git-artifact-promotion-authority-intent"),
    version: z.literal(1),
    promotionId: z.string().regex(/^artifact-promotion:sha256:[0-9a-f]{64}$/),
    candidateId: z.string().regex(/^artifact-candidate:sha256:[0-9a-f]{64}$/),
    repositoryId: z.string().trim().min(1).max(240),
    targetRef: z.string().trim().min(1).max(1_024),
    expectedBaseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    candidateCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    projectId: z.string().trim().min(1).max(160),
    semanticHeadRevisionId: z.string().trim().min(1).max(240),
    authorizedEventId: z.string().trim().min(1).max(240),
    authorizedAt: z.iso.datetime({ offset: true }),
    ledgerVersion: z
      .object({
        headRevisionId: z.string().trim().min(1).max(240),
        eventCount: z.number().int().positive().max(5_000),
        eventLogFingerprint: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
      })
      .strict(),
    ledgerPrefixDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    signature: ArtifactReceiptSignatureSchema,
  })
  .strict();

type ArtifactPromotionAuthorityIntent = z.infer<
  typeof ArtifactPromotionAuthorityIntentSchema
>;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function signingKey(secret: ArtifactSigningSecret): Buffer {
  const value =
    typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : Buffer.from(secret);
  if (value.byteLength < 32) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      "Artifact receipt HMAC keys must contain at least 32 bytes.",
    );
  }
  return value;
}

function signatureDigest(
  value: unknown,
  secret: ArtifactSigningSecret,
): string {
  return `hmac-sha256:${createHmac("sha256", signingKey(secret))
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function limitsFrom(
  overrides: Partial<ArtifactCandidateLimits> | undefined,
): ArtifactCandidateLimits {
  const limits = { ...DEFAULT_ARTIFACT_CANDIDATE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ArtifactPromotionBoundaryError(
        "invalid_configuration",
        `Artifact candidate limit ${name} must be a positive safe integer.`,
      );
    }
  }
  return limits;
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function prepareExternalStore(
  configuredPath: string,
  excludedPaths: readonly string[],
): Promise<string> {
  const absolute = resolve(configuredPath);
  const created = await mkdir(absolute, { recursive: true, mode: 0o700 });
  if (created !== undefined) await syncDirectory(dirname(absolute));
  const resolved = await realpath(absolute);
  if (absolute !== resolved) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      `Artifact receipt store ${absolute} must not be reached through a symlink.`,
    );
  }
  const storeHandle = await openPrivateDirectory(resolved, false);
  await storeHandle.close();
  for (const excluded of excludedPaths) {
    const normalized = resolve(excluded);
    if (
      containsPath(normalized, resolved) ||
      containsPath(resolved, normalized)
    ) {
      throw new ArtifactPromotionBoundaryError(
        "invalid_configuration",
        "Artifact receipt storage must be disjoint from the worker and Git repository.",
      );
    }
  }
  return resolved;
}

type GitEnvironmentOverrides = Readonly<Record<string, string | undefined>>;

function gitEnvironment(
  extra: GitEnvironmentOverrides = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function runGit(
  prefix: readonly string[],
  args: readonly string[],
  options: {
    readonly env?: GitEnvironmentOverrides;
    readonly maxBuffer?: number;
    readonly allowExitCodes?: readonly number[];
  } = {},
): Promise<GitCommandResult> {
  const commandArgs = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "color.ui=false",
    ...prefix,
    ...args,
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      commandArgs,
      {
        encoding: null,
        env: gitEnvironment(options.env),
        maxBuffer: options.maxBuffer ?? 4 * 1_024 * 1_024,
      },
      (error, stdout, stderr) => {
        const stdoutBytes = Buffer.isBuffer(stdout)
          ? stdout
          : Buffer.from(stdout);
        const stderrBytes = Buffer.isBuffer(stderr)
          ? stderr
          : Buffer.from(stderr);
        if (!error) {
          resolvePromise({
            stdout: stdoutBytes,
            stderr: stderrBytes,
            exitCode: 0,
          });
          return;
        }
        const exitCode =
          typeof error.code === "number" ? error.code : (error.code ?? null);
        if (
          typeof exitCode === "number" &&
          options.allowExitCodes?.includes(exitCode)
        ) {
          resolvePromise({
            stdout: stdoutBytes,
            stderr: stderrBytes,
            exitCode,
          });
          return;
        }
        rejectPromise(
          new GitCommandError(commandArgs, exitCode, stderrBytes, {
            cause: error,
          }),
        );
      },
    );
  });
}

function gitInWorktree(
  workspace: string,
  args: readonly string[],
  options?: Parameters<typeof runGit>[2],
): Promise<GitCommandResult> {
  return runGit(["-C", workspace], args, options);
}

function gitInDirectory(
  gitDirectory: string,
  args: readonly string[],
  options?: Parameters<typeof runGit>[2],
): Promise<GitCommandResult> {
  return runGit([`--git-dir=${gitDirectory}`], args, options);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "unsafe_path",
      `${label} is not valid UTF-8 and cannot enter a bounded artifact receipt.`,
      { cause },
    );
  }
}

function trimmedAscii(bytes: Buffer): string {
  return bytes.toString("ascii").trim();
}

function validateArtifactPath(path: string, maxPathBytes: number): void {
  const byteLength = Buffer.byteLength(path, "utf8");
  const segments = path.split("/");
  if (
    byteLength > maxPathBytes ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git",
    )
  ) {
    throw new ArtifactCandidateSealError(
      "unsafe_path",
      `Artifact path ${JSON.stringify(path)} is unsafe or exceeds the ${maxPathBytes}-byte path limit.`,
    );
  }
}

function manifestEntries(
  raw: Buffer,
  objectFormat: "sha1" | "sha256",
  limits: ArtifactCandidateLimits,
): ArtifactCandidateChangedPath[] {
  const tokens: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.byteLength; index += 1) {
    if (raw[index] === 0) {
      tokens.push(raw.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== raw.byteLength) {
    throw new ArtifactCandidateSealError(
      "git_failed",
      "Git returned a non-NUL-terminated changed-path manifest.",
    );
  }
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  const zeroOid = "0".repeat(oidLength);
  const metadataPattern = new RegExp(
    `^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{${oidLength}}) ([0-9a-f]{${oidLength}}) ([AMDT])$`,
  );
  const entries: ArtifactCandidateChangedPath[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const metadata = tokens[index];
    const pathBytes = tokens[index + 1];
    if (!metadata || !pathBytes) {
      throw new ArtifactCandidateSealError(
        "git_failed",
        "Git returned an incomplete changed-path manifest.",
      );
    }
    const match = metadataPattern.exec(metadata.toString("ascii"));
    if (!match) {
      throw new ArtifactCandidateSealError(
        "unsupported_mode",
        "Git returned a rename, copy, merge, or unsupported path transition.",
      );
    }
    const [, oldModeRaw, newModeRaw, oldBlobRaw, newBlobRaw, statusRaw] = match;
    const path = decodeUtf8(pathBytes, "An artifact path");
    validateArtifactPath(path, limits.maxPathBytes);
    for (const mode of [oldModeRaw, newModeRaw]) {
      if (mode === "120000" || mode === "160000") {
        throw new ArtifactCandidateSealError(
          "unsupported_mode",
          `Artifact path ${path} is a symlink or submodule; v0 candidates permit regular files only.`,
        );
      }
      if (mode !== "000000" && mode !== "100644" && mode !== "100755") {
        throw new ArtifactCandidateSealError(
          "unsupported_mode",
          `Artifact path ${path} has unsupported Git mode ${mode}.`,
        );
      }
    }
    const oldMode = oldModeRaw === "000000" ? null : oldModeRaw;
    const newMode = newModeRaw === "000000" ? null : newModeRaw;
    const oldBlob = oldBlobRaw === zeroOid ? null : oldBlobRaw;
    const newBlob = newBlobRaw === zeroOid ? null : newBlobRaw;
    entries.push({
      path,
      status:
        statusRaw === "A"
          ? "added"
          : statusRaw === "D"
            ? "deleted"
            : "modified",
      oldMode: oldMode as "100644" | "100755" | null,
      newMode: newMode as "100644" | "100755" | null,
      oldBlob,
      newBlob,
    });
  }
  if (entries.length > limits.maxChangedPaths) {
    throw new ArtifactCandidateSealError(
      "evidence_oversized",
      `Artifact candidate changes ${entries.length} paths; the limit is ${limits.maxChangedPaths}.`,
    );
  }
  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  );
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new ArtifactCandidateSealError(
        "candidate_conflict",
        `Artifact path ${entry.path} appears more than once in the candidate manifest.`,
      );
    }
    paths.add(entry.path);
  }
  const manifestBytes = Buffer.byteLength(canonicalJson(entries), "utf8");
  if (manifestBytes > limits.maxManifestBytes) {
    throw new ArtifactCandidateSealError(
      "evidence_oversized",
      `Artifact manifest is ${manifestBytes} bytes; the limit is ${limits.maxManifestBytes}.`,
    );
  }
  return entries;
}

function candidateIdentityMaterial(
  metadata: ArtifactCandidateMetadata,
): ArtifactCandidateIdentityMaterial {
  const material = { ...metadata } as Partial<ArtifactCandidateMetadata>;
  delete material.candidateId;
  delete material.candidateRef;
  return material as ArtifactCandidateIdentityMaterial;
}

export function artifactCandidateId(
  material: ArtifactCandidateIdentityMaterial,
): string {
  return `artifact-candidate:${sha256(canonicalJson(material))}`;
}

function candidateRef(candidateId: string): string {
  return `refs/odeu/candidates/${candidateId.slice("artifact-candidate:sha256:".length)}`;
}

function verifySignedValue(
  value: unknown,
  signature: ArtifactCandidateReceipt["signature"],
  secrets: Readonly<Record<string, ArtifactSigningSecret>>,
): void {
  const secret = secrets[signature.keyId];
  if (!secret) {
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      `No artifact receipt verification key is configured for ${signature.keyId}.`,
    );
  }
  const expected = signatureDigest(value, secret);
  if (!signaturesEqual(expected, signature.digest)) {
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      "The artifact receipt signature does not match its exact canonical metadata.",
    );
  }
}

export function verifyArtifactCandidateReceipt(
  input: unknown,
  signingSecrets: Readonly<Record<string, ArtifactSigningSecret>>,
  limitOverrides?: Partial<ArtifactCandidateLimits>,
): ArtifactCandidateReceipt {
  let receipt: ArtifactCandidateReceipt;
  let limits: ArtifactCandidateLimits;
  try {
    receipt = ArtifactCandidateReceiptSchema.parse(input);
    limits = limitsFrom(limitOverrides);
  } catch (cause) {
    if (cause instanceof ArtifactPromotionBoundaryError) throw cause;
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      "The artifact candidate receipt does not satisfy its public schema.",
      { cause },
    );
  }
  const material = candidateIdentityMaterial(receipt.metadata);
  const expectedId = artifactCandidateId(material);
  if (
    receipt.metadata.candidateId !== expectedId ||
    receipt.metadata.candidateRef !== candidateRef(expectedId)
  ) {
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      "The candidate ID or retained ref does not match its exact metadata.",
    );
  }
  if (
    receipt.metadata.manifest.digest !==
    sha256(canonicalJson(receipt.metadata.manifest.entries))
  ) {
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      "The candidate manifest digest does not match its exact entries.",
    );
  }
  if (receipt.metadata.manifest.entries.length > limits.maxChangedPaths) {
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      "The signed candidate exceeds the configured changed-path limit.",
    );
  }
  let previous: string | null = null;
  for (const entry of receipt.metadata.manifest.entries) {
    try {
      validateArtifactPath(entry.path, limits.maxPathBytes);
    } catch (cause) {
      throw new ArtifactPromotionBoundaryError(
        "candidate_invalid",
        "The signed candidate contains an unsafe artifact path.",
        { cause },
      );
    }
    if (
      previous !== null &&
      Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0
    ) {
      throw new ArtifactPromotionBoundaryError(
        "candidate_invalid",
        "The signed candidate manifest is not uniquely sorted by path bytes.",
      );
    }
    previous = entry.path;
  }
  if (
    receipt.metadata.patch.byteLength > limits.maxPatchBytes ||
    Buffer.byteLength(canonicalJson(receipt), "utf8") > limits.maxReceiptBytes
  ) {
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      "The signed candidate exceeds the configured evidence limits.",
    );
  }
  verifySignedValue(receipt.metadata, receipt.signature, signingSecrets);
  return receipt;
}

async function durableJsonWrite(
  directory: string,
  fileName: string,
  value: unknown,
  maxBytes: number,
): Promise<{
  readonly path: string;
  readonly disposition: "created" | "adopted";
}> {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new ArtifactCandidateSealError(
      "evidence_oversized",
      `Durable artifact receipt is ${bytes.byteLength} bytes; the limit is ${maxBytes}.`,
    );
  }
  if (
    basename(fileName) !== fileName ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      "Durable artifact receipt names must be single safe path components.",
    );
  }
  const path = join(directory, fileName);
  const directoryHandle = await openPrivateDirectory(directory, true);
  const temporaryFileName = `.${fileName}.${process.pid}.${randomUUID()}.tmp`;
  const anchoredDirectory = `/proc/self/fd/${directoryHandle.fd}`;
  const anchoredPath = `${anchoredDirectory}/${fileName}`;
  const anchoredTemporaryPath = `${anchoredDirectory}/${temporaryFileName}`;
  let temporaryHandle;
  let disposition: "created" | "adopted" | null = null;
  try {
    try {
      temporaryHandle = await open(
        anchoredTemporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await temporaryHandle.writeFile(bytes);
      await temporaryHandle.sync();
      const stat = await temporaryHandle.stat();
      assertPrivateRegularFile(stat, path, maxBytes);
      if (stat.size !== bytes.byteLength) {
        throw new ArtifactPromotionBoundaryError(
          "status_conflict",
          `Durable receipt ${path} could not be written completely.`,
        );
      }
      await temporaryHandle.close();
      temporaryHandle = undefined;

      try {
        await fsPromises.link(anchoredTemporaryPath, anchoredPath);
        disposition = "created";
        // The complete inode is durable before its final name becomes durable.
        await directoryHandle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: Buffer;
        try {
          existing = await readAnchoredFile(
            directoryHandle.fd,
            fileName,
            path,
            maxBytes,
          );
        } catch (cause) {
          if (cause instanceof ArtifactPromotionBoundaryError) throw cause;
          throw new ArtifactPromotionBoundaryError(
            "status_conflict",
            `Durable receipt ${path} cannot be adopted safely.`,
            { cause },
          );
        }
        if (!existing.equals(bytes)) {
          throw new ArtifactPromotionBoundaryError(
            "status_conflict",
            `Durable receipt ${path} already contains different content.`,
          );
        }
        disposition = "adopted";
      }
    } finally {
      await temporaryHandle?.close();
      try {
        await unlink(anchoredTemporaryPath);
        await directoryHandle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    await directoryHandle.close();
  }
  if (!disposition) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      `Durable receipt ${path} was not installed or adopted.`,
    );
  }
  return { path, disposition };
}

function assertPrivateOwnership(stat: Stats, path: string): void {
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      `Private artifact journal path ${path} has the wrong owner.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      `Private artifact journal path ${path} permits group or other access.`,
    );
  }
}

function assertPrivateRegularFile(
  stat: Stats,
  path: string,
  maxBytes: number,
): void {
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      `Durable receipt ${path} is unsafe or oversized.`,
    );
  }
  assertPrivateOwnership(stat, path);
}

async function openPrivateDirectory(directory: string, create: boolean) {
  const absolute = resolve(directory);
  if (create) {
    const created = await mkdir(absolute, { recursive: true, mode: 0o700 });
    if (created !== undefined) await syncDirectory(dirname(absolute));
  }
  const resolved = await realpath(absolute);
  if (resolved !== absolute) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      `Private artifact journal directory ${absolute} must not use symlinks.`,
    );
  }
  const handle = await open(
    absolute,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new ArtifactPromotionBoundaryError(
        "invalid_configuration",
        `Private artifact journal path ${absolute} is not a directory.`,
      );
    }
    assertPrivateOwnership(stat, absolute);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readAnchoredFile(
  directoryFd: number,
  fileName: string,
  displayPath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await open(
    `/proc/self/fd/${directoryFd}/${fileName}`,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    assertPrivateRegularFile(await handle.stat(), displayPath, maxBytes);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readDurableJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T | null> {
  const directory = dirname(path);
  const fileName = basename(path);
  let directoryHandle;
  try {
    directoryHandle = await openPrivateDirectory(directory, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const bytes = await readAnchoredFile(
      directoryHandle.fd,
      fileName,
      path,
      maxBytes,
    );
    return schema.parse(JSON.parse(utf8Decoder.decode(bytes)));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (cause instanceof ArtifactPromotionBoundaryError) throw cause;
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      `Durable receipt ${path} is malformed.`,
      { cause },
    );
  } finally {
    await directoryHandle.close();
  }
}

async function assertGitRef(repository: string, ref: string): Promise<void> {
  if (ref.startsWith("refs/odeu/")) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      "The authoritative target cannot use an ODEU-owned internal ref namespace.",
    );
  }
  const result = await gitInWorktree(repository, ["check-ref-format", ref], {
    allowExitCodes: [1],
  });
  if (result.exitCode !== 0) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      `Configured artifact target ${ref} is not a valid full Git ref.`,
    );
  }
}

async function assertDirectGitRef(
  gitDirectory: string,
  ref: string,
  label: string,
): Promise<void> {
  await optionalDirectCommit(gitDirectory, ref, label);
}

async function optionalDirectCommit(
  gitDirectory: string,
  ref: string,
  label: string,
): Promise<string | null> {
  const result = await gitInDirectory(gitDirectory, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00",
    ref,
  ]);
  const exactRecords = result.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\0"))
    .filter(([refName]) => refName === ref);
  if (exactRecords.length === 0) return null;
  if (exactRecords.length !== 1) {
    throw new ArtifactPromotionBoundaryError(
      "binding_mismatch",
      `${label} could not be observed as one exact Git ref.`,
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
    throw new ArtifactPromotionBoundaryError(
      "binding_mismatch",
      `${label} returned malformed raw ref data.`,
    );
  }
  if (symbolicTarget) {
    throw new ArtifactPromotionBoundaryError(
      "binding_mismatch",
      `${label} must be a direct Git ref, not a symbolic ref.`,
    );
  }
  if (objectType !== "commit") {
    throw new ArtifactPromotionBoundaryError(
      "binding_mismatch",
      `${label} must point directly to a commit object, not ${objectType || "an unknown object type"}.`,
    );
  }
  return objectId;
}

async function assertAuthoritativeBareRepository(
  repository: string,
): Promise<string> {
  try {
    const [bare, gitDirectory] = await Promise.all([
      gitInWorktree(repository, ["rev-parse", "--is-bare-repository"]).then(
        (result) => trimmedAscii(result.stdout),
      ),
      gitInWorktree(repository, ["rev-parse", "--absolute-git-dir"]).then(
        (result) => trimmedAscii(result.stdout),
      ),
    ]);
    const resolvedGitDirectory = await realpath(resolve(gitDirectory));
    if (bare !== "true" || resolvedGitDirectory !== repository) {
      throw new ArtifactPromotionBoundaryError(
        "invalid_configuration",
        "The configured authoritative Git repository must be its exact bare repository root.",
      );
    }
    return resolvedGitDirectory;
  } catch (cause) {
    if (cause instanceof ArtifactPromotionBoundaryError) throw cause;
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      "The configured authoritative Git repository is not a usable bare repository.",
      { cause },
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireRepositoryPromotionLock(
  gitDirectory: string,
): Promise<() => Promise<void>> {
  const lockPath = join(gitDirectory, ARTIFACT_PROMOTION_REPOSITORY_LOCK);
  const deadline = Date.now() + ARTIFACT_PROMOTION_LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ArtifactPromotionBoundaryError(
          "invalid_configuration",
          "The authoritative repository promotion lock could not be established.",
          { cause },
        );
      }
      if (Date.now() >= deadline) {
        throw new ArtifactPromotionBoundaryError(
          "status_conflict",
          "Another authoritative repository promotion still holds the repository lock.",
          { cause },
        );
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, ARTIFACT_PROMOTION_LOCK_POLL_MS);
      });
      continue;
    }
    try {
      await syncDirectory(gitDirectory);
    } catch (cause) {
      await rmdir(lockPath).catch(() => undefined);
      throw new ArtifactPromotionBoundaryError(
        "invalid_configuration",
        "The authoritative repository promotion lock could not be made durable.",
        { cause },
      );
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await rmdir(lockPath);
      await syncDirectory(gitDirectory);
    };
  }
}

async function createOrAdoptCandidateRef(input: {
  readonly gitDirectory: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly ref: string;
  readonly commit: string;
}): Promise<void> {
  let existing: string | null;
  try {
    existing = await optionalDirectCommit(
      input.gitDirectory,
      input.ref,
      "The retained candidate ref",
    );
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "candidate_conflict",
      `Candidate ref ${input.ref} is not a direct commit ref.`,
      { cause },
    );
  }
  if (existing === input.commit) return;
  if (existing !== null) {
    throw new ArtifactCandidateSealError(
      "candidate_conflict",
      `Candidate ref ${input.ref} already points to a different commit.`,
    );
  }
  try {
    await gitInDirectory(input.gitDirectory, [
      "update-ref",
      "--no-deref",
      "--create-reflog",
      input.ref,
      input.commit,
      "0".repeat(input.objectFormat === "sha1" ? 40 : 64),
    ]);
  } catch (cause) {
    try {
      if (
        (await optionalDirectCommit(
          input.gitDirectory,
          input.ref,
          "The retained candidate ref",
        )) === input.commit
      ) {
        return;
      }
    } catch {
      // Report the same stable candidate-conflict boundary below.
    }
    throw new ArtifactCandidateSealError(
      "candidate_conflict",
      `Candidate ref ${input.ref} could not be retained exactly.`,
      { cause },
    );
  }
}

async function assertNoIgnoredContent(
  workspace: string,
  limits: ArtifactCandidateLimits,
): Promise<void> {
  let status: GitCommandResult;
  try {
    status = await gitInWorktree(
      workspace,
      [
        "status",
        "--ignored",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      { maxBuffer: limits.maxManifestBytes + 1 },
    );
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "evidence_oversized",
      "The ignored/untracked workspace observation exceeded its evidence bound.",
      { cause },
    );
  }
  const entries = status.stdout.subarray(0, -1).toString("utf8").split("\0");
  if (entries.some((entry) => entry.startsWith("!! "))) {
    throw new ArtifactCandidateSealError(
      "ignored_content",
      "The live workspace contains ignored content after execution; it cannot be sealed as an exact candidate.",
    );
  }
}

async function treeDiffEvidence(input: {
  readonly gitDirectory: string;
  readonly baseCommit: string;
  readonly candidateTree: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly limits: ArtifactCandidateLimits;
}): Promise<{
  readonly entries: ArtifactCandidateChangedPath[];
  readonly patch: Buffer;
}> {
  let raw: GitCommandResult;
  try {
    raw = await gitInDirectory(
      input.gitDirectory,
      [
        "diff-tree",
        "-r",
        "--raw",
        "-z",
        "--no-renames",
        "--full-index",
        input.baseCommit,
        input.candidateTree,
        "--",
      ],
      { maxBuffer: input.limits.maxManifestBytes + 1 },
    );
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "evidence_oversized",
      "The changed-path manifest exceeded its bounded capture size.",
      { cause },
    );
  }
  const entries = manifestEntries(raw.stdout, input.objectFormat, input.limits);
  let patch: GitCommandResult;
  try {
    patch = await gitInDirectory(
      input.gitDirectory,
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        input.baseCommit,
        input.candidateTree,
        "--",
      ],
      { maxBuffer: input.limits.maxPatchBytes + 1 },
    );
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "evidence_oversized",
      `The binary diff exceeded its ${input.limits.maxPatchBytes}-byte evidence limit.`,
      { cause },
    );
  }
  if (patch.stdout.byteLength > input.limits.maxPatchBytes) {
    throw new ArtifactCandidateSealError(
      "evidence_oversized",
      `The binary diff exceeded its ${input.limits.maxPatchBytes}-byte evidence limit.`,
    );
  }
  return { entries, patch: patch.stdout };
}

/**
 * Seals the current working-tree bytes while the caller still owns the live
 * workspace lease. The real Git index and authoritative refs are never changed.
 */
export async function sealLiveWorkspaceCandidate(
  rawInput: SealLiveWorkspaceCandidateInput,
): Promise<SealedLiveWorkspaceCandidate> {
  let input: SealLiveWorkspaceCandidateInput;
  try {
    SealInputSchema.parse(rawInput);
    input = rawInput;
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "The live artifact candidate request is invalid.",
      { cause },
    );
  }
  let limits: ArtifactCandidateLimits;
  try {
    limits = limitsFrom(input.limits);
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "Artifact evidence limits are invalid.",
      { cause },
    );
  }
  let workspace: string;
  try {
    workspace = await realpath(resolve(input.workspace));
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "The live artifact workspace cannot be resolved.",
      { cause },
    );
  }
  let gitDirectory: string;
  let topLevel: string;
  let objectFormat: "sha1" | "sha256";
  try {
    [gitDirectory, topLevel, objectFormat] = await Promise.all([
      gitInWorktree(workspace, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).then((result) => trimmedAscii(result.stdout)),
      gitInWorktree(workspace, ["rev-parse", "--show-toplevel"]).then(
        (result) => trimmedAscii(result.stdout),
      ),
      gitInWorktree(workspace, ["rev-parse", "--show-object-format"]).then(
        (result) => trimmedAscii(result.stdout) as "sha1" | "sha256",
      ),
    ]);
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "The live artifact workspace is not a usable Git worktree.",
      { cause },
    );
  }
  if (
    resolve(topLevel) !== workspace ||
    !["sha1", "sha256"].includes(objectFormat)
  ) {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "The live artifact workspace must be an exact Git worktree root with a supported object format.",
    );
  }
  try {
    await assertGitRef(workspace, input.targetRef);
  } catch (cause) {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "The target Git ref is invalid.",
      { cause },
    );
  }
  const store = await prepareExternalStore(input.candidateStoreDirectory, [
    workspace,
    gitDirectory,
  ]).catch((cause: unknown) => {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "The candidate store is invalid.",
      { cause },
    );
  });
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  if (input.expectedBaseCommit.length !== oidLength) {
    throw new ArtifactCandidateSealError(
      "base_mismatch",
      `The authorized base is not a ${objectFormat} commit ID.`,
    );
  }
  const observedHead = trimmedAscii(
    (await gitInWorktree(workspace, ["rev-parse", "HEAD"])).stdout,
  );
  if (observedHead !== input.expectedBaseCommit) {
    throw new ArtifactCandidateSealError(
      "base_mismatch",
      `The live workspace HEAD is ${observedHead}; the authorized base is ${input.expectedBaseCommit}.`,
    );
  }
  const baseTree = trimmedAscii(
    (
      await gitInDirectory(gitDirectory, [
        "rev-parse",
        `${input.expectedBaseCommit}^{tree}`,
      ])
    ).stdout,
  );
  const localFilters = await gitInWorktree(
    workspace,
    [
      "config",
      "--local",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process|required)$",
    ],
    { allowExitCodes: [1] },
  );
  if (localFilters.exitCode === 0 && localFilters.stdout.byteLength > 0) {
    throw new ArtifactCandidateSealError(
      "invalid_configuration",
      "Repository-local clean/process filters are unsupported at the artifact sealing boundary.",
    );
  }
  await assertNoIgnoredContent(workspace, limits);

  const temporaryDirectory = await mkdtemp(join(store, ".candidate-index-"));
  const alternateIndex = join(temporaryDirectory, "index");
  try {
    const indexEnvironment = { GIT_INDEX_FILE: alternateIndex };
    await gitInWorktree(workspace, ["read-tree", input.expectedBaseCommit], {
      env: indexEnvironment,
    });
    await gitInWorktree(workspace, ["add", "-A", "--", "."], {
      env: indexEnvironment,
      maxBuffer: limits.maxManifestBytes + 1,
    });
    const candidateTree = trimmedAscii(
      (
        await gitInWorktree(workspace, ["write-tree"], {
          env: indexEnvironment,
        })
      ).stdout,
    );
    const headAfterIndex = trimmedAscii(
      (await gitInWorktree(workspace, ["rev-parse", "HEAD"])).stdout,
    );
    if (headAfterIndex !== input.expectedBaseCommit) {
      throw new ArtifactCandidateSealError(
        "base_mismatch",
        "The live workspace HEAD changed while its candidate tree was being sealed.",
      );
    }
    if (candidateTree === baseTree) {
      throw new ArtifactCandidateSealError(
        "no_changes",
        "The live workspace has no artifact changes relative to its authorized base.",
      );
    }
    const evidence = await treeDiffEvidence({
      gitDirectory,
      baseCommit: input.expectedBaseCommit,
      candidateTree,
      objectFormat,
      limits,
    });
    if (evidence.entries.length === 0 || evidence.patch.byteLength === 0) {
      throw new ArtifactCandidateSealError(
        "no_changes",
        "The staged Git tree does not produce a reviewable artifact patch.",
      );
    }
    const commitBindingDigest = sha256(
      canonicalJson({
        repositoryId: input.repositoryId,
        targetRef: input.targetRef,
        runId: input.runId,
        briefId: input.briefId,
        baseRevisionId: input.baseRevisionId,
        baseCommit: input.expectedBaseCommit,
        candidateTree,
        sealedAt: input.sealedAt,
      }),
    );
    const commitMessage = `ODEU staged artifact candidate\n\nBinding-Digest: ${commitBindingDigest}`;
    const commitEnvironment = {
      GIT_AUTHOR_NAME: "ODEU Artifact Sealer",
      GIT_AUTHOR_EMAIL: "artifact-sealer@odeu.invalid",
      GIT_AUTHOR_DATE: input.sealedAt,
      GIT_COMMITTER_NAME: "ODEU Artifact Sealer",
      GIT_COMMITTER_EMAIL: "artifact-sealer@odeu.invalid",
      GIT_COMMITTER_DATE: input.sealedAt,
    };
    const candidateCommit = trimmedAscii(
      (
        await gitInDirectory(
          gitDirectory,
          [
            "commit-tree",
            candidateTree,
            "-p",
            input.expectedBaseCommit,
            "-m",
            commitMessage,
          ],
          { env: commitEnvironment },
        )
      ).stdout,
    );
    const identityMaterial: ArtifactCandidateIdentityMaterial = {
      kind: "odeu.git-artifact-candidate",
      version: 1,
      repositoryId: input.repositoryId,
      targetRef: input.targetRef,
      runId: input.runId,
      briefId: input.briefId,
      baseRevisionId: input.baseRevisionId,
      sealedAt: input.sealedAt,
      git: {
        objectFormat,
        baseCommit: input.expectedBaseCommit,
        baseTree,
        candidateCommit,
        candidateTree,
      },
      patch: {
        format: "git-binary-diff-v1",
        digest: sha256(evidence.patch),
        byteLength: evidence.patch.byteLength,
      },
      manifest: {
        digest: sha256(canonicalJson(evidence.entries)),
        entries: evidence.entries,
      },
    };
    const id = artifactCandidateId(identityMaterial);
    const metadata = ArtifactCandidateMetadataSchema.parse({
      ...identityMaterial,
      candidateId: id,
      candidateRef: candidateRef(id),
    });
    let receipt: ArtifactCandidateReceipt;
    try {
      receipt = ArtifactCandidateReceiptSchema.parse({
        metadata,
        signature: {
          algorithm: "hmac-sha256",
          keyId: input.signing.keyId,
          digest: signatureDigest(metadata, input.signing.secret),
        },
      });
    } catch (cause) {
      throw new ArtifactCandidateSealError(
        "invalid_configuration",
        "The sealed candidate could not satisfy its receipt schema.",
        { cause },
      );
    }
    if (
      Buffer.byteLength(canonicalJson(receipt), "utf8") > limits.maxReceiptBytes
    ) {
      throw new ArtifactCandidateSealError(
        "evidence_oversized",
        "The sealed candidate receipt exceeds its configured size limit.",
      );
    }
    await createOrAdoptCandidateRef({
      gitDirectory,
      objectFormat,
      ref: metadata.candidateRef,
      commit: candidateCommit,
    });
    const { path: receiptPath } = await durableJsonWrite(
      join(store, "candidates"),
      `${id.slice("artifact-candidate:sha256:".length)}.json`,
      receipt,
      limits.maxReceiptBytes,
    );
    return { receipt, receiptPath };
  } catch (error) {
    if (error instanceof ArtifactCandidateSealError) throw error;
    if (error instanceof ArtifactPromotionBoundaryError) {
      throw new ArtifactCandidateSealError(
        error.code === "status_conflict"
          ? "candidate_conflict"
          : "invalid_configuration",
        error.code === "status_conflict"
          ? "The artifact candidate conflicts with existing durable state."
          : "The artifact candidate boundary configuration is invalid.",
        { cause: error },
      );
    }
    throw new ArtifactCandidateSealError(
      "git_failed",
      "Git failed while sealing the live artifact candidate.",
      { cause: error },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function unsignedAttempt(
  attempt: ArtifactPromotionAttemptReceipt,
): Omit<ArtifactPromotionAttemptReceipt, "signature"> {
  const unsigned = { ...attempt } as Partial<ArtifactPromotionAttemptReceipt>;
  delete unsigned.signature;
  return unsigned as Omit<ArtifactPromotionAttemptReceipt, "signature">;
}

function unsignedAuthorityIntent(
  intent: ArtifactPromotionAuthorityIntent,
): Omit<ArtifactPromotionAuthorityIntent, "signature"> {
  const unsigned = {
    ...intent,
  } as Partial<ArtifactPromotionAuthorityIntent>;
  delete unsigned.signature;
  return unsigned as Omit<ArtifactPromotionAuthorityIntent, "signature">;
}

function expectedAuthorityIntent(input: {
  readonly promotionId: string;
  readonly candidate: ArtifactCandidateReceipt;
  readonly authority: ArtifactPromotionAuthorityBinding;
}): Omit<ArtifactPromotionAuthorityIntent, "signature"> {
  const metadata = input.candidate.metadata;
  return {
    kind: "odeu.git-artifact-promotion-authority-intent",
    version: 1,
    promotionId: input.promotionId,
    candidateId: metadata.candidateId,
    repositoryId: metadata.repositoryId,
    targetRef: metadata.targetRef,
    expectedBaseCommit: metadata.git.baseCommit,
    candidateCommit: metadata.git.candidateCommit,
    projectId: input.authority.projectId,
    semanticHeadRevisionId: input.authority.semanticHeadRevisionId,
    authorizedEventId: input.authority.authorizedEventId,
    authorizedAt: input.authority.authorizedAt,
    ledgerVersion: { ...input.authority.ledgerVersion },
    ledgerPrefixDigest: input.authority.ledgerPrefixDigest,
  };
}

function signedAuthorityIntent(input: {
  readonly expected: Omit<ArtifactPromotionAuthorityIntent, "signature">;
  readonly keyId: string;
  readonly secret: ArtifactSigningSecret;
}): ArtifactPromotionAuthorityIntent {
  return ArtifactPromotionAuthorityIntentSchema.parse({
    ...input.expected,
    signature: {
      algorithm: "hmac-sha256",
      keyId: input.keyId,
      digest: signatureDigest(input.expected, input.secret),
    },
  });
}

function assertAuthorityIntentMatches(
  intent: ArtifactPromotionAuthorityIntent,
  expected: Omit<ArtifactPromotionAuthorityIntent, "signature">,
  secret: ArtifactSigningSecret,
  expectedKeyId: string,
): void {
  if (intent.signature.keyId !== expectedKeyId) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion authority intent changed signing-key identity.",
    );
  }
  const unsigned = unsignedAuthorityIntent(intent);
  if (canonicalJson(unsigned) !== canonicalJson(expected)) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion authority intent is bound to a different ledger prefix, semantic head, or candidate.",
    );
  }
  if (
    !signaturesEqual(signatureDigest(unsigned, secret), intent.signature.digest)
  ) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion authority intent signature is invalid.",
    );
  }
}

async function persistOrAdoptPromotionAuthority(input: {
  readonly directory: string;
  readonly fileName: string;
  readonly intent: ArtifactPromotionAuthorityIntent;
  readonly expected: Omit<ArtifactPromotionAuthorityIntent, "signature">;
  readonly secret: ArtifactSigningSecret;
  readonly keyId: string;
  readonly limits: ArtifactCandidateLimits;
}): Promise<ArtifactPromotionAuthorityIntent> {
  try {
    await durableJsonWrite(
      input.directory,
      input.fileName,
      input.intent,
      input.limits.maxReceiptBytes,
    );
    return input.intent;
  } catch (error) {
    if (
      error instanceof ArtifactPromotionBoundaryError &&
      error.code === "status_conflict"
    ) {
      const durable = await readDurableJson(
        join(input.directory, input.fileName),
        ArtifactPromotionAuthorityIntentSchema,
        input.limits.maxReceiptBytes,
      );
      if (durable) {
        assertAuthorityIntentMatches(
          durable,
          input.expected,
          input.secret,
          input.keyId,
        );
        return durable;
      }
    }
    throw error;
  }
}

function unsignedStatus(
  status: ArtifactPromotionReceipt,
): Omit<ArtifactPromotionReceipt, "signature"> {
  const unsigned = { ...status } as Partial<ArtifactPromotionReceipt>;
  delete unsigned.signature;
  return unsigned as Omit<ArtifactPromotionReceipt, "signature">;
}

function signedAttempt(input: {
  readonly promotionId: string;
  readonly candidate: ArtifactCandidateReceipt;
  readonly attemptedAt: string;
  readonly authorityIntentDigest: string;
  readonly secret: ArtifactSigningSecret;
}): ArtifactPromotionAttemptReceipt {
  const metadata = input.candidate.metadata;
  const unsigned = {
    kind: "odeu.git-artifact-promotion-attempt" as const,
    version: 1 as const,
    promotionId: input.promotionId,
    candidateId: metadata.candidateId,
    repositoryId: metadata.repositoryId,
    targetRef: metadata.targetRef,
    expectedBaseCommit: metadata.git.baseCommit,
    candidateCommit: metadata.git.candidateCommit,
    authorityIntentDigest: input.authorityIntentDigest,
    attemptedAt: input.attemptedAt,
  };
  return ArtifactPromotionAttemptReceiptSchema.parse({
    ...unsigned,
    signature: {
      algorithm: "hmac-sha256",
      keyId: input.candidate.signature.keyId,
      digest: signatureDigest(unsigned, input.secret),
    },
  });
}

function signedStatus(input: {
  readonly attempt: ArtifactPromotionAttemptReceipt;
  readonly observedAt: string;
  readonly outcome: ArtifactPromotionReceipt["outcome"];
  readonly observedRefBefore: string | null;
  readonly observedRefAfter: string | null;
  readonly detailCode: ArtifactPromotionReceipt["detailCode"];
  readonly detail: string;
  readonly secret: ArtifactSigningSecret;
}): ArtifactPromotionReceipt {
  const unsigned = {
    kind: "odeu.git-artifact-promotion-status" as const,
    version: 1 as const,
    promotionId: input.attempt.promotionId,
    candidateId: input.attempt.candidateId,
    repositoryId: input.attempt.repositoryId,
    targetRef: input.attempt.targetRef,
    expectedBaseCommit: input.attempt.expectedBaseCommit,
    candidateCommit: input.attempt.candidateCommit,
    authorityIntentDigest: input.attempt.authorityIntentDigest,
    attemptedAt: input.attempt.attemptedAt,
    observedAt: input.observedAt,
    outcome: input.outcome,
    observedRefBefore: input.observedRefBefore,
    observedRefAfter: input.observedRefAfter,
    detailCode: input.detailCode,
    detail: input.detail.slice(0, 2_000),
  };
  return ArtifactPromotionReceiptSchema.parse({
    ...unsigned,
    signature: {
      algorithm: "hmac-sha256",
      keyId: input.attempt.signature.keyId,
      digest: signatureDigest(unsigned, input.secret),
    },
  });
}

function assertAttemptMatches(
  attempt: ArtifactPromotionAttemptReceipt,
  expected: Omit<ArtifactPromotionAttemptReceipt, "attemptedAt" | "signature">,
  secret: ArtifactSigningSecret,
  expectedKeyId: string,
): void {
  if (attempt.signature.keyId !== expectedKeyId) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion attempt changed signing-key identity.",
    );
  }
  const comparable = unsignedAttempt(attempt);
  const binding = {
    kind: comparable.kind,
    version: comparable.version,
    promotionId: comparable.promotionId,
    candidateId: comparable.candidateId,
    repositoryId: comparable.repositoryId,
    targetRef: comparable.targetRef,
    expectedBaseCommit: comparable.expectedBaseCommit,
    candidateCommit: comparable.candidateCommit,
    authorityIntentDigest: comparable.authorityIntentDigest,
  };
  if (canonicalJson(binding) !== canonicalJson(expected)) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion attempt is bound to different candidate or target data.",
    );
  }
  const expectedSignature = signatureDigest(comparable, secret);
  if (!signaturesEqual(expectedSignature, attempt.signature.digest)) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion attempt signature is invalid.",
    );
  }
}

function assertStatusMatches(
  status: ArtifactPromotionReceipt,
  attempt: ArtifactPromotionAttemptReceipt,
  secret: ArtifactSigningSecret,
): void {
  if (status.signature.keyId !== attempt.signature.keyId) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion status changed signing-key identity.",
    );
  }
  const expectedBinding = {
    promotionId: attempt.promotionId,
    candidateId: attempt.candidateId,
    repositoryId: attempt.repositoryId,
    targetRef: attempt.targetRef,
    expectedBaseCommit: attempt.expectedBaseCommit,
    candidateCommit: attempt.candidateCommit,
    authorityIntentDigest: attempt.authorityIntentDigest,
    attemptedAt: attempt.attemptedAt,
  };
  const actualBinding = {
    promotionId: status.promotionId,
    candidateId: status.candidateId,
    repositoryId: status.repositoryId,
    targetRef: status.targetRef,
    expectedBaseCommit: status.expectedBaseCommit,
    candidateCommit: status.candidateCommit,
    authorityIntentDigest: status.authorityIntentDigest,
    attemptedAt: status.attemptedAt,
  };
  if (canonicalJson(actualBinding) !== canonicalJson(expectedBinding)) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion status is bound to a different attempt.",
    );
  }
  const expectedSignature = signatureDigest(unsignedStatus(status), secret);
  if (!signaturesEqual(expectedSignature, status.signature.digest)) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion status signature is invalid.",
    );
  }
}

/**
 * Reads a deterministic promotion journal without inspecting or changing Git.
 * An attempt-only result lets reload recovery decide whether to observe the ref
 * or resume through the explicit promotion command; this function never does so.
 */
export async function getArtifactPromotionStatus(
  input: GetArtifactPromotionStatusInput,
): Promise<ArtifactPromotionStatusObservation> {
  const authority = PromoteInputSchema.shape.authority.parse(input.authority);
  const limits = limitsFrom(input.limits);
  const candidate = verifyArtifactCandidateReceipt(
    input.candidate,
    input.signingSecrets,
    limits,
  );
  const metadata = candidate.metadata;
  const promotionId = artifactPromotionId({
    candidateId: metadata.candidateId,
    repositoryId: metadata.repositoryId,
    targetRef: metadata.targetRef,
    expectedBaseCommit: metadata.git.baseCommit,
    candidateCommit: metadata.git.candidateCommit,
  });
  const configuredStore = resolve(input.statusStoreDirectory);
  let statusStore: string;
  try {
    statusStore = await realpath(configuredStore);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", promotionId };
    }
    throw error;
  }
  if (configuredStore !== statusStore) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      `Artifact status store ${configuredStore} must not be reached through a symlink.`,
    );
  }
  const promotionDigest = promotionId.slice(
    "artifact-promotion:sha256:".length,
  );
  const promotionDirectory = join(statusStore, "promotions");
  const authorityIntent = await readDurableJson(
    join(promotionDirectory, `${promotionDigest}.authority.json`),
    ArtifactPromotionAuthorityIntentSchema,
    limits.maxReceiptBytes,
  );
  const attempt = await readDurableJson(
    join(promotionDirectory, `${promotionDigest}.attempt.json`),
    ArtifactPromotionAttemptReceiptSchema,
    limits.maxReceiptBytes,
  );
  const status = await readDurableJson(
    join(promotionDirectory, `${promotionDigest}.status.json`),
    ArtifactPromotionReceiptSchema,
    limits.maxReceiptBytes,
  );
  if (!authorityIntent) {
    if (attempt || status) {
      throw new ArtifactPromotionBoundaryError(
        "status_conflict",
        "Durable promotion execution state exists without its server-owned authority intent.",
      );
    }
    return { state: "absent", promotionId };
  }
  const secret = input.signingSecrets[authorityIntent.signature.keyId];
  if (
    !secret ||
    authorityIntent.signature.keyId !== candidate.signature.keyId
  ) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion authority intent does not use the candidate's configured signing key.",
    );
  }
  const expectedIntent = expectedAuthorityIntent({
    promotionId,
    candidate,
    authority,
  });
  const authorityIntentDigest = sha256(canonicalJson(expectedIntent));
  assertAuthorityIntentMatches(
    authorityIntent,
    expectedIntent,
    secret,
    candidate.signature.keyId,
  );
  if (!attempt) {
    if (status) {
      throw new ArtifactPromotionBoundaryError(
        "status_conflict",
        "A durable promotion status exists without its authority attempt receipt.",
      );
    }
    return { state: "authorized_only", promotionId };
  }
  if (attempt.signature.keyId !== authorityIntent.signature.keyId) {
    throw new ArtifactPromotionBoundaryError(
      "status_conflict",
      "The durable promotion attempt does not use its authority intent signing key.",
    );
  }
  assertAttemptMatches(
    attempt,
    {
      kind: "odeu.git-artifact-promotion-attempt",
      version: 1,
      promotionId,
      candidateId: metadata.candidateId,
      repositoryId: metadata.repositoryId,
      targetRef: metadata.targetRef,
      expectedBaseCommit: metadata.git.baseCommit,
      candidateCommit: metadata.git.candidateCommit,
      authorityIntentDigest,
    },
    secret,
    authorityIntent.signature.keyId,
  );
  if (!status) return { state: "attempt_only", promotionId, attempt };
  assertStatusMatches(status, attempt, secret);
  return { state: "completed", promotionId, attempt, receipt: status };
}

async function persistOrAdoptPromotionAttempt(input: {
  readonly directory: string;
  readonly fileName: string;
  readonly attempt: ArtifactPromotionAttemptReceipt;
  readonly expectedBinding: Omit<
    ArtifactPromotionAttemptReceipt,
    "attemptedAt" | "signature"
  >;
  readonly secret: ArtifactSigningSecret;
  readonly keyId: string;
  readonly limits: ArtifactCandidateLimits;
}): Promise<{
  readonly attempt: ArtifactPromotionAttemptReceipt;
  readonly disposition: "created" | "adopted";
}> {
  const path = join(input.directory, input.fileName);
  try {
    const write = await durableJsonWrite(
      input.directory,
      input.fileName,
      input.attempt,
      input.limits.maxReceiptBytes,
    );
    return {
      attempt: input.attempt,
      disposition: write.disposition,
    };
  } catch (error) {
    if (
      !(error instanceof ArtifactPromotionBoundaryError) ||
      error.code !== "status_conflict"
    ) {
      throw error;
    }
    const durable = await readDurableJson(
      path,
      ArtifactPromotionAttemptReceiptSchema,
      input.limits.maxReceiptBytes,
    );
    if (!durable) throw error;
    assertAttemptMatches(
      durable,
      input.expectedBinding,
      input.secret,
      input.keyId,
    );
    return { attempt: durable, disposition: "adopted" };
  }
}

async function targetRefIsCheckedOut(
  gitDirectory: string,
  targetRef: string,
): Promise<boolean> {
  const worktrees = await gitInDirectory(gitDirectory, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return worktrees.stdout
    .toString("utf8")
    .split("\0")
    .some((field) => field === `branch ${targetRef}`);
}

async function verifyCandidateGitObjects(input: {
  readonly gitDirectory: string;
  readonly candidate: ArtifactCandidateReceipt;
  readonly limits: ArtifactCandidateLimits;
}): Promise<string | null> {
  const metadata = input.candidate.metadata;
  try {
    const objectFormat = trimmedAscii(
      (
        await gitInDirectory(input.gitDirectory, [
          "rev-parse",
          "--show-object-format",
        ])
      ).stdout,
    );
    if (objectFormat !== metadata.git.objectFormat) {
      return "The target repository object format differs from the signed candidate.";
    }
    const [candidateAtRef, baseTree, candidateTree, commitBody] =
      await Promise.all([
        optionalDirectCommit(
          input.gitDirectory,
          metadata.candidateRef,
          "The retained candidate ref",
        ),
        gitInDirectory(input.gitDirectory, [
          "rev-parse",
          `${metadata.git.baseCommit}^{tree}`,
        ]).then((result) => trimmedAscii(result.stdout)),
        gitInDirectory(input.gitDirectory, [
          "rev-parse",
          `${metadata.git.candidateCommit}^{tree}`,
        ]).then((result) => trimmedAscii(result.stdout)),
        gitInDirectory(input.gitDirectory, [
          "cat-file",
          "-p",
          metadata.git.candidateCommit,
        ]).then((result) => result.stdout.toString("utf8")),
      ]);
    if (candidateAtRef !== metadata.git.candidateCommit) {
      return "The retained non-authoritative candidate ref no longer names the signed commit.";
    }
    if (
      baseTree !== metadata.git.baseTree ||
      candidateTree !== metadata.git.candidateTree
    ) {
      return "The signed candidate commit/tree identity does not match the repository objects.";
    }
    const header = commitBody.split("\n\n", 1)[0] ?? "";
    const parents = header
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length));
    if (parents.length !== 1 || parents[0] !== metadata.git.baseCommit) {
      return "The candidate commit does not have exactly the authorized base as its parent.";
    }
    const evidence = await treeDiffEvidence({
      gitDirectory: input.gitDirectory,
      baseCommit: metadata.git.baseCommit,
      candidateTree: metadata.git.candidateTree,
      objectFormat: metadata.git.objectFormat,
      limits: input.limits,
    });
    if (
      canonicalJson(evidence.entries) !==
        canonicalJson(metadata.manifest.entries) ||
      sha256(evidence.patch) !== metadata.patch.digest ||
      evidence.patch.byteLength !== metadata.patch.byteLength
    ) {
      return "The candidate's recomputed manifest or binary patch differs from its signed receipt.";
    }
    return null;
  } catch {
    return "The candidate Git objects could not be verified.";
  }
}

async function persistPromotionStatus(input: {
  readonly directory: string;
  readonly fileName: string;
  readonly status: ArtifactPromotionReceipt;
  readonly attempt: ArtifactPromotionAttemptReceipt;
  readonly secret: ArtifactSigningSecret;
  readonly limits: ArtifactCandidateLimits;
}): Promise<PromotedArtifactCandidate> {
  try {
    const { path: receiptPath } = await durableJsonWrite(
      input.directory,
      input.fileName,
      input.status,
      input.limits.maxReceiptBytes,
    );
    return { receipt: input.status, receiptPath };
  } catch (cause) {
    if (
      cause instanceof ArtifactPromotionBoundaryError &&
      cause.code === "status_conflict"
    ) {
      const receiptPath = join(input.directory, input.fileName);
      const durable = await readDurableJson(
        receiptPath,
        ArtifactPromotionReceiptSchema,
        input.limits.maxReceiptBytes,
      );
      if (durable) {
        assertStatusMatches(durable, input.attempt, input.secret);
        return { receipt: durable, receiptPath };
      }
    }
    throw new ArtifactPromotionOutcomeUnknownError(
      "The Git outcome was observed but its durable promotion status could not be established.",
      { cause },
    );
  }
}

/**
 * Promotes only the signed candidate commit by atomically comparing and swapping
 * one configured target ref in a dedicated bare repository. A repository-wide
 * lock covers the final bare/checked-out checks, CAS, and durable status receipt.
 * A durable attempt precedes the ref operation so response loss can be recovered
 * by exact ref observation.
 */
export async function promoteArtifactCandidate(
  rawInput: PromoteArtifactCandidateInput,
): Promise<PromotedArtifactCandidate> {
  PromoteInputSchema.parse(rawInput);
  const input = rawInput;
  if (
    input.authority.semanticHeadRevisionId !==
    input.authority.ledgerVersion.headRevisionId
  ) {
    throw new ArtifactPromotionBoundaryError(
      "binding_mismatch",
      "Promotion authority does not bind one exact semantic head and ledger prefix.",
    );
  }
  const limits = limitsFrom(input.limits);
  const candidate = verifyArtifactCandidateReceipt(
    input.candidate,
    input.signingSecrets,
    limits,
  );
  const metadata = candidate.metadata;
  if (
    metadata.repositoryId !== input.repositoryId ||
    metadata.targetRef !== input.targetRef ||
    metadata.git.baseCommit !== input.expectedBaseCommit
  ) {
    throw new ArtifactPromotionBoundaryError(
      "binding_mismatch",
      "Promotion inputs do not exactly match the signed candidate repository, target ref, and base commit.",
    );
  }
  const configuredRepository = resolve(input.repository);
  const repository = await realpath(configuredRepository).catch(
    (cause: unknown) => {
      throw new ArtifactPromotionBoundaryError(
        "invalid_configuration",
        "The configured authoritative Git repository cannot be resolved.",
        { cause },
      );
    },
  );
  if (configuredRepository !== repository) {
    throw new ArtifactPromotionBoundaryError(
      "invalid_configuration",
      "The configured authoritative Git repository must not be reached through a symlink.",
    );
  }
  const gitDirectory = await assertAuthoritativeBareRepository(repository);
  await assertGitRef(repository, input.targetRef);
  const statusStore = await prepareExternalStore(input.statusStoreDirectory, [
    repository,
    gitDirectory,
  ]);
  const promotionId = artifactPromotionId({
    candidateId: metadata.candidateId,
    repositoryId: input.repositoryId,
    targetRef: input.targetRef,
    expectedBaseCommit: input.expectedBaseCommit,
    candidateCommit: metadata.git.candidateCommit,
  });
  const promotionDigest = promotionId.slice(
    "artifact-promotion:sha256:".length,
  );
  const promotionDirectory = join(statusStore, "promotions");
  const authorityPath = join(
    promotionDirectory,
    `${promotionDigest}.authority.json`,
  );
  const attemptPath = join(
    promotionDirectory,
    `${promotionDigest}.attempt.json`,
  );
  const statusPath = join(promotionDirectory, `${promotionDigest}.status.json`);
  const secret = input.signingSecrets[candidate.signature.keyId];
  if (!secret) {
    throw new ArtifactPromotionBoundaryError(
      "candidate_invalid",
      "The candidate signing key is unavailable for promotion receipts.",
    );
  }
  const expectedIntent = expectedAuthorityIntent({
    promotionId,
    candidate,
    authority: input.authority,
  });
  const authorityIntentDigest = sha256(canonicalJson(expectedIntent));
  const expectedAttemptBinding = {
    kind: "odeu.git-artifact-promotion-attempt" as const,
    version: 1 as const,
    promotionId,
    candidateId: metadata.candidateId,
    repositoryId: metadata.repositoryId,
    targetRef: metadata.targetRef,
    expectedBaseCommit: metadata.git.baseCommit,
    candidateCommit: metadata.git.candidateCommit,
    authorityIntentDigest,
  };
  const releaseRepositoryLock =
    await acquireRepositoryPromotionLock(gitDirectory);
  try {
    await assertAuthoritativeBareRepository(repository);
    await assertGitRef(repository, input.targetRef);
    await assertDirectGitRef(
      gitDirectory,
      input.targetRef,
      "The configured authoritative target",
    );
    await assertDirectGitRef(
      gitDirectory,
      metadata.candidateRef,
      "The retained candidate ref",
    );
    return await (async (): Promise<PromotedArtifactCandidate> => {
      let authorityIntent = await readDurableJson(
        authorityPath,
        ArtifactPromotionAuthorityIntentSchema,
        limits.maxReceiptBytes,
      );
      if (authorityIntent) {
        assertAuthorityIntentMatches(
          authorityIntent,
          expectedIntent,
          secret,
          candidate.signature.keyId,
        );
      } else {
        authorityIntent = signedAuthorityIntent({
          expected: expectedIntent,
          keyId: candidate.signature.keyId,
          secret,
        });
        authorityIntent = await persistOrAdoptPromotionAuthority({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.authority.json`,
          intent: authorityIntent,
          expected: expectedIntent,
          secret,
          keyId: candidate.signature.keyId,
          limits,
        });
      }
      let attempt = await readDurableJson(
        attemptPath,
        ArtifactPromotionAttemptReceiptSchema,
        limits.maxReceiptBytes,
      );
      let adoptedPriorAttempt = attempt !== null;
      if (attempt) {
        assertAttemptMatches(
          attempt,
          expectedAttemptBinding,
          secret,
          authorityIntent.signature.keyId,
        );
        const existingStatus = await readDurableJson(
          statusPath,
          ArtifactPromotionReceiptSchema,
          limits.maxReceiptBytes,
        );
        if (existingStatus) {
          assertStatusMatches(existingStatus, attempt, secret);
          return { receipt: existingStatus, receiptPath: statusPath };
        }
      }

      const candidateFailure = await verifyCandidateGitObjects({
        gitDirectory,
        candidate,
        limits,
      });
      const checkedOut = await targetRefIsCheckedOut(
        gitDirectory,
        input.targetRef,
      );
      if (!attempt && (candidateFailure || checkedOut)) {
        attempt = signedAttempt({
          promotionId,
          candidate,
          attemptedAt: input.attemptedAt,
          authorityIntentDigest,
          secret,
        });
        const persistedAttempt = await persistOrAdoptPromotionAttempt({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.attempt.json`,
          attempt,
          expectedBinding: expectedAttemptBinding,
          secret,
          keyId: authorityIntent.signature.keyId,
          limits,
        });
        attempt = persistedAttempt.attempt;
        adoptedPriorAttempt = persistedAttempt.disposition === "adopted";
        if (!adoptedPriorAttempt) {
          const failed = signedStatus({
            attempt,
            observedAt: input.attemptedAt,
            outcome: "failed",
            observedRefBefore: null,
            observedRefAfter: null,
            detailCode: checkedOut
              ? "target_ref_checked_out"
              : "candidate_verification_failed",
            detail: checkedOut
              ? `Configured target ref ${input.targetRef} is checked out in a Git worktree and was not updated.`
              : (candidateFailure ??
                "The signed candidate Git objects could not be verified."),
            secret,
          });
          return persistPromotionStatus({
            directory: promotionDirectory,
            fileName: `${promotionDigest}.status.json`,
            status: failed,
            attempt,
            secret,
            limits,
          });
        }
      }
      if (candidateFailure || checkedOut) {
        const failed = signedStatus({
          attempt: attempt!,
          observedAt: input.attemptedAt,
          outcome: "outcome_unknown",
          observedRefBefore: null,
          observedRefAfter: null,
          detailCode: "status_recovery_conflict",
          detail:
            candidateFailure ??
            `Configured target ref ${input.targetRef} became checked out during promotion recovery.`,
          secret,
        });
        return persistPromotionStatus({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.status.json`,
          status: failed,
          attempt: attempt!,
          secret,
          limits,
        });
      }
      if (!attempt) {
        attempt = signedAttempt({
          promotionId,
          candidate,
          attemptedAt: input.attemptedAt,
          authorityIntentDigest,
          secret,
        });
        const persistedAttempt = await persistOrAdoptPromotionAttempt({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.attempt.json`,
          attempt,
          expectedBinding: expectedAttemptBinding,
          secret,
          keyId: authorityIntent.signature.keyId,
          limits,
        });
        attempt = persistedAttempt.attempt;
        adoptedPriorAttempt = persistedAttempt.disposition === "adopted";
      }
      if (adoptedPriorAttempt) {
        let recoveredRef: string | null;
        try {
          recoveredRef = await optionalDirectCommit(
            gitDirectory,
            input.targetRef,
            "The configured authoritative target",
          );
        } catch {
          recoveredRef = null;
        }
        const recoveredStatus =
          recoveredRef === metadata.git.candidateCommit
            ? signedStatus({
                attempt,
                observedAt: input.attemptedAt,
                outcome: "promoted",
                observedRefBefore: metadata.git.candidateCommit,
                observedRefAfter: metadata.git.candidateCommit,
                detailCode: "already_promoted",
                detail:
                  "The one-shot promotion claim was adopted after response loss and the target still names the exact signed candidate; no second CAS was attempted.",
                secret,
              })
            : recoveredRef !== null && recoveredRef !== input.expectedBaseCommit
              ? signedStatus({
                  attempt,
                  observedAt: input.attemptedAt,
                  outcome: "stale",
                  observedRefBefore: recoveredRef,
                  observedRefAfter: recoveredRef,
                  detailCode: "target_ref_mismatch",
                  detail:
                    "The one-shot promotion claim was adopted after response loss, but the target now names another commit; no second CAS was attempted.",
                  secret,
                })
              : signedStatus({
                  attempt,
                  observedAt: input.attemptedAt,
                  outcome: "outcome_unknown",
                  observedRefBefore: recoveredRef,
                  observedRefAfter: recoveredRef,
                  detailCode: "status_recovery_conflict",
                  detail:
                    "A prior one-shot promotion claim exists, but durable evidence cannot establish that its CAS committed. The target was not updated again.",
                  secret,
                });
        return persistPromotionStatus({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.status.json`,
          status: recoveredStatus,
          attempt,
          secret,
          limits,
        });
      }

      let observedBefore: string | null;
      try {
        observedBefore = await optionalDirectCommit(
          gitDirectory,
          input.targetRef,
          "The configured authoritative target",
        );
      } catch {
        const unknown = signedStatus({
          attempt,
          observedAt: input.attemptedAt,
          outcome: "outcome_unknown",
          observedRefBefore: null,
          observedRefAfter: null,
          detailCode: "target_ref_unobservable",
          detail:
            "The authoritative target ref could not be observed before its CAS operation.",
          secret,
        });
        return persistPromotionStatus({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.status.json`,
          status: unknown,
          attempt,
          secret,
          limits,
        });
      }
      if (observedBefore === metadata.git.candidateCommit) {
        const promoted = signedStatus({
          attempt,
          observedAt: input.attemptedAt,
          outcome: "promoted",
          observedRefBefore: observedBefore,
          observedRefAfter: observedBefore,
          detailCode: "already_promoted",
          detail:
            "The target ref already names the exact signed candidate; the durable result was recovered without another ref update.",
          secret,
        });
        return persistPromotionStatus({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.status.json`,
          status: promoted,
          attempt,
          secret,
          limits,
        });
      }
      if (observedBefore !== input.expectedBaseCommit) {
        const stale = signedStatus({
          attempt,
          observedAt: input.attemptedAt,
          outcome: "stale",
          observedRefBefore: observedBefore,
          observedRefAfter: observedBefore,
          detailCode: "target_ref_mismatch",
          detail: `The target ref no longer names the authorized base ${input.expectedBaseCommit}; no rebase or ref update was attempted.`,
          secret,
        });
        return persistPromotionStatus({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.status.json`,
          status: stale,
          attempt,
          secret,
          limits,
        });
      }

      if (await targetRefIsCheckedOut(gitDirectory, input.targetRef)) {
        const failed = signedStatus({
          attempt,
          observedAt: input.attemptedAt,
          outcome: "failed",
          observedRefBefore: observedBefore,
          observedRefAfter: observedBefore,
          detailCode: "target_ref_checked_out",
          detail: `Configured target ref ${input.targetRef} became checked out before its CAS operation and was not updated.`,
          secret,
        });
        return persistPromotionStatus({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.status.json`,
          status: failed,
          attempt,
          secret,
          limits,
        });
      }

      let updateFailed = false;
      try {
        await assertDirectGitRef(
          gitDirectory,
          input.targetRef,
          "The configured authoritative target",
        );
        await gitInDirectory(gitDirectory, [
          "update-ref",
          "--no-deref",
          input.targetRef,
          metadata.git.candidateCommit,
          input.expectedBaseCommit,
        ]);
      } catch {
        updateFailed = true;
      }
      let observedAfter: string | null;
      try {
        await assertDirectGitRef(
          gitDirectory,
          input.targetRef,
          "The configured authoritative target",
        );
        observedAfter = await optionalDirectCommit(
          gitDirectory,
          input.targetRef,
          "The configured authoritative target",
        );
      } catch {
        const unknown = signedStatus({
          attempt,
          observedAt: input.attemptedAt,
          outcome: "outcome_unknown",
          observedRefBefore: observedBefore,
          observedRefAfter: null,
          detailCode: "target_ref_unobservable",
          detail:
            "The target ref outcome could not be observed after its atomic CAS operation.",
          secret,
        });
        return persistPromotionStatus({
          directory: promotionDirectory,
          fileName: `${promotionDigest}.status.json`,
          status: unknown,
          attempt,
          secret,
          limits,
        });
      }
      const status =
        observedAfter === metadata.git.candidateCommit
          ? signedStatus({
              attempt,
              observedAt: input.attemptedAt,
              outcome: "promoted",
              observedRefBefore: observedBefore,
              observedRefAfter: observedAfter,
              detailCode: "cas_updated",
              detail:
                "The authoritative target ref atomically advanced from the exact base to the signed candidate commit.",
              secret,
            })
          : observedAfter !== input.expectedBaseCommit
            ? signedStatus({
                attempt,
                observedAt: input.attemptedAt,
                outcome: "stale",
                observedRefBefore: observedBefore,
                observedRefAfter: observedAfter,
                detailCode: "target_ref_mismatch",
                detail:
                  "A competing ref update won the Git CAS; the signed candidate was not applied or rebased.",
                secret,
              })
            : signedStatus({
                attempt,
                observedAt: input.attemptedAt,
                outcome: "failed",
                observedRefBefore: observedBefore,
                observedRefAfter: observedAfter,
                detailCode: "update_ref_rejected",
                detail: updateFailed
                  ? "Git rejected the atomic target-ref update and the ref still names the authorized base."
                  : "Git reported success but the target ref still names the authorized base.",
                secret,
              });
      return persistPromotionStatus({
        directory: promotionDirectory,
        fileName: `${promotionDigest}.status.json`,
        status,
        attempt,
        secret,
        limits,
      });
    })();
  } finally {
    await releaseRepositoryLock();
  }
}
