#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const HARNESS_SOURCE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(HARNESS_SOURCE_PATH), "..");
const DEFAULT_CODEX_BINARY = join(
  REPOSITORY_ROOT,
  "node_modules",
  ".bin",
  "codex",
);
const SECURE_TEMPORARY_PARENT =
  process.platform === "win32" ? tmpdir() : "/tmp";
const COMMAND_TIMEOUT_MS = 120_000;
const PROCESS_GROUP_QUIESCENCE_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 4 * 1_024 * 1_024;
const SMOKE_BRIEF_ID = "brief-local-codex-session-smoke-v1";
const SMOKE_CHECK_ID = "check-smoke-output-exact";
const INPUT_FILE = "smoke-input.txt";
const OUTPUT_FILE = "smoke-output.txt";
const EXPECTED_OUTPUT = "ODEU local Codex session smoke passed.\n";
const BUNDLED_RUNTIME_BY_PLATFORM = {
  "darwin:arm64": {
    packageDirectory: "codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
  },
  "darwin:x64": {
    packageDirectory: "codex-darwin-x64",
    targetTriple: "x86_64-apple-darwin",
  },
  "linux:arm64": {
    packageDirectory: "codex-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
  },
  "linux:x64": {
    packageDirectory: "codex-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
  },
  "win32:arm64": {
    packageDirectory: "codex-win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
  },
  "win32:x64": {
    packageDirectory: "codex-win32-x64",
    targetTriple: "x86_64-pc-windows-msvc",
  },
};
const FLAG_OPTIONS = new Set([
  "allow-ci-live-provider-call",
  "allow-live-provider-call",
]);
const VALUE_OPTIONS = new Set(["codex-bin", "evidence-file", "model"]);
const CODEX_EVENT_TYPES = new Set([
  "error",
  "item.completed",
  "item.started",
  "item.updated",
  "thread.started",
  "turn.completed",
  "turn.failed",
  "turn.started",
]);
const CODEX_ITEM_TYPES = new Set([
  "agent_message",
  "command_execution",
  "file_change",
  "reasoning",
]);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/u;
const SAFE_PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const ACTIVE_PROCESS_TERMINATORS = new Set();
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let interruptedSignal = null;
const WorkerTextSchema = z.string().min(1).max(8_000);
const WorkerResultSchema = z
  .object({
    outcome: z.enum(["returned", "blocked", "failed", "cancelled"]),
    claimedEffects: z.array(WorkerTextSchema).max(40),
    claimedArtifacts: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1_000),
            kind: z.enum(["added", "updated", "deleted", "observed"]),
            summary: WorkerTextSchema,
            reference: z.string().min(1).max(1_000),
          })
          .strict(),
      )
      .max(80),
    claimedChecks: z
      .array(
        z
          .object({
            checkId: z.string().min(1).max(160),
            label: z.string().min(1).max(240),
            status: z.enum(["passed", "failed", "not_run"]),
            detail: WorkerTextSchema,
            reference: z.string().min(1).max(1_000),
          })
          .strict(),
      )
      .max(40),
    failures: z.array(WorkerTextSchema).max(40),
    unresolved: z.array(WorkerTextSchema).max(40),
    completionClaim: z
      .object({
        claimedDone: z.boolean(),
        criteriaClaimedSatisfied: z.array(z.boolean()).max(24),
      })
      .strict(),
    candidateReconciliationSummary: WorkerTextSchema,
  })
  .strict();

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    if (interruptedSignal) {
      process.exit(SIGNAL_EXIT_CODES[signal]);
    }
    interruptedSignal = signal;
    for (const terminate of ACTIVE_PROCESS_TERMINATORS) terminate();
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw boundaryError(
        "unexpected_argument",
        `Unexpected argument: ${argument}`,
      );
    }
    const equals = argument.indexOf("=");
    const key = argument.slice(2, equals >= 0 ? equals : undefined);
    if (!FLAG_OPTIONS.has(key) && !VALUE_OPTIONS.has(key)) {
      throw boundaryError("unknown_option", `Unknown option: --${key}`);
    }
    if (Object.hasOwn(options, key)) {
      throw boundaryError(
        "duplicate_option",
        `Option may be supplied only once: --${key}`,
      );
    }
    if (equals >= 0) {
      const value = argument.slice(equals + 1);
      if (VALUE_OPTIONS.has(key) && !value.trim()) {
        throw boundaryError(
          "option_value_missing",
          `Option requires a value: --${key}`,
        );
      }
      options[key] = value;
      continue;
    }
    if (VALUE_OPTIONS.has(key)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw boundaryError(
          "option_value_missing",
          `Option requires a value: --${key}`,
        );
      }
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function optionString(options, key, fallback = "") {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionFlag(options, key) {
  const value = options[key];
  return value === true || /^(?:1|true|yes)$/iu.test(String(value ?? ""));
}

function boundaryError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
  });
}

function assertNotInterrupted() {
  if (interruptedSignal) {
    throw boundaryError(
      "smoke_interrupted",
      `The local Codex session smoke was interrupted by ${interruptedSignal}.`,
    );
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function containsPath(parent, candidate) {
  const child = relative(parent, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function shellEnvironmentPolicy(workerHome) {
  const values = {
    HOME: workerHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH:
      process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin",
  };
  const fields = Object.entries(values)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ");
  return `{ ${fields} }`;
}

function codexProcessEnvironment() {
  const environment = {
    HOME: process.env.HOME ?? homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    NODE_ENV: "production",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  for (const name of [
    "ALL_PROXY",
    "CODEX_CA_CERTIFICATE",
    "CODEX_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
    "XDG_RUNTIME_DIR",
    "all_proxy",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

async function trustedCodexBinary(configuredPath) {
  const configured = configuredPath
    ? isAbsolute(configuredPath)
      ? configuredPath
      : resolve(REPOSITORY_ROOT, configuredPath)
    : DEFAULT_CODEX_BINARY;
  let resolvedPath;
  try {
    resolvedPath = await realpath(configured);
    const status = await stat(resolvedPath);
    if (!status.isFile()) throw new Error("not a regular file");
  } catch (cause) {
    throw boundaryError(
      "codex_binary_unavailable",
      "The configured Codex executable is unavailable.",
      cause,
    );
  }
  if (
    !configuredPath &&
    !containsPath(join(REPOSITORY_ROOT, "node_modules"), resolvedPath)
  ) {
    throw boundaryError(
      "codex_binary_untrusted",
      "The project-bundled Codex executable resolves outside node_modules.",
    );
  }
  return resolvedPath;
}

async function bundledCodexProvenance(binary) {
  const platform =
    BUNDLED_RUNTIME_BY_PLATFORM[`${process.platform}:${process.arch}`];
  if (!platform) {
    throw boundaryError(
      "codex_platform_unsupported",
      "The project-bundled Codex runtime does not support this platform.",
    );
  }
  try {
    const openAiModulesRoot = join(REPOSITORY_ROOT, "node_modules", "@openai");
    const canonicalOpenAiModulesRoot = await realpath(openAiModulesRoot);
    const packageRoot = await realpath(join(openAiModulesRoot, "codex"));
    const runtimeRoot = await realpath(
      join(openAiModulesRoot, platform.packageDirectory),
    );
    const [packageMetadata, runtimeMetadata, lockMetadata] = await Promise.all([
      readFile(join(packageRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(runtimeRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(join(REPOSITORY_ROOT, "package-lock.json"), "utf8").then(
        JSON.parse,
      ),
    ]);
    const launcherPath = join(
      packageRoot,
      String(packageMetadata?.bin?.codex ?? ""),
    );
    const nativeExecutablePath = join(
      runtimeRoot,
      "vendor",
      platform.targetTriple,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    const [launcher, nativeExecutable, launcherStatus, nativeStatus] =
      await Promise.all([
        realpath(launcherPath),
        realpath(nativeExecutablePath),
        lstat(launcherPath),
        lstat(nativeExecutablePath),
      ]);
    const packageLock = lockMetadata?.packages?.["node_modules/@openai/codex"];
    const runtimeLock =
      lockMetadata?.packages?.[
        `node_modules/@openai/${platform.packageDirectory}`
      ];
    const expectedRuntimeDependency =
      packageMetadata?.optionalDependencies?.[
        `@openai/${platform.packageDirectory}`
      ];
    if (
      binary !== launcher ||
      !launcherStatus.isFile() ||
      !nativeStatus.isFile() ||
      !containsPath(canonicalOpenAiModulesRoot, packageRoot) ||
      !containsPath(canonicalOpenAiModulesRoot, runtimeRoot) ||
      !containsPath(packageRoot, launcher) ||
      !containsPath(runtimeRoot, nativeExecutable) ||
      typeof packageMetadata?.version !== "string" ||
      !SAFE_PACKAGE_VERSION_PATTERN.test(packageMetadata.version) ||
      packageMetadata.version !== packageLock?.version ||
      typeof packageLock?.integrity !== "string" ||
      !SHA512_INTEGRITY_PATTERN.test(packageLock.integrity) ||
      typeof runtimeMetadata?.version !== "string" ||
      !SAFE_PACKAGE_VERSION_PATTERN.test(runtimeMetadata.version) ||
      runtimeMetadata.version !== runtimeLock?.version ||
      expectedRuntimeDependency !==
        `npm:@openai/codex@${runtimeMetadata.version}` ||
      typeof runtimeLock?.integrity !== "string" ||
      !SHA512_INTEGRITY_PATTERN.test(runtimeLock.integrity)
    ) {
      throw new Error("bundled Codex package metadata mismatch");
    }
    const [launcherDigest, nativeExecutableDigest] = await Promise.all([
      sha256File(launcher),
      sha256File(nativeExecutable),
    ]);
    return {
      launcherDigest,
      nativeExecutableDigest,
      packageMetadataMatchedLock: true,
      installedBytesVerifiedAgainstPackageIntegrity: false,
      packageVersion: packageMetadata.version,
      packageLockIntegrity: packageLock.integrity,
      platformPackageVersion: runtimeMetadata.version,
      platformPackageLockIntegrity: runtimeLock.integrity,
    };
  } catch (cause) {
    if (cause?.code === "codex_platform_unsupported") throw cause;
    throw boundaryError(
      "codex_binary_untrusted",
      "The bundled Codex launcher/native runtime is outside the expected project package metadata boundary.",
      cause,
    );
  }
}

async function waitForProcessGroupQuiescence(processGroupId) {
  if (process.platform === "win32" || !processGroupId) return;
  const deadline = Date.now() + PROCESS_GROUP_QUIESCENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch (cause) {
      if (cause?.code === "ESRCH") return;
      throw boundaryError(
        "codex_process_group_check_failed",
        "The bounded Codex process group could not be checked safely.",
        cause,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw boundaryError(
    "codex_process_group_not_quiescent",
    "The bounded Codex process group did not become quiescent after termination.",
  );
}

async function runBoundedProcess(input) {
  assertNotInterrupted();
  return new Promise((resolveProcess, rejectProcess) => {
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let outputLimited = false;
    let timedOut = false;
    let settled = false;
    let settling = false;
    let timeout;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: input.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to the direct child if process-group termination raced exit.
        }
      }
      child.kill("SIGKILL");
    };
    ACTIVE_PROCESS_TERMINATORS.add(terminate);
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      ACTIVE_PROCESS_TERMINATORS.delete(terminate);
      clearTimeout(timeout);
      if (error) rejectProcess(error);
      else resolveProcess(result);
    };
    const settleAfterTermination = async (result, error) => {
      if (settled || settling) return;
      settling = true;
      terminate();
      try {
        await waitForProcessGroupQuiescence(child.pid);
      } catch (cause) {
        finish(null, cause);
        return;
      }
      finish(result, error);
    };
    const capture = (chunk, chunks, stream) => {
      const currentLength = stream === "stdout" ? stdoutLength : stderrLength;
      const totalLength = stdoutLength + stderrLength;
      const remaining = Math.max(OUTPUT_LIMIT_BYTES - totalLength, 0);
      const captured = Math.min(chunk.byteLength, remaining);
      if (captured > 0) chunks.push(chunk.subarray(0, captured));
      if (stream === "stdout") stdoutLength = currentLength + captured;
      else stderrLength = currentLength + captured;
      if (captured !== chunk.byteLength) {
        outputLimited = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk) => capture(chunk, stdout, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, stderr, "stderr"));
    child.once("error", (error) => void settleAfterTermination(null, error));
    child.once("close", (exitCode, signal) => {
      // A launcher can exit while a detached descendant remains in its process
      // group. Require the inherited group to be absent before returning control.
      void settleAfterTermination({
        exitCode,
        signal,
        timedOut,
        outputLimited,
        processGroupQuiescent: true,
        stdout: Buffer.concat(stdout, stdoutLength),
        stderr: Buffer.concat(stderr, stderrLength),
      });
    });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    timeout.unref();
  });
}

function requireSuccessfulProcess(result, operation) {
  assertNotInterrupted();
  if (result.timedOut) {
    throw boundaryError("codex_timeout", `Codex timed out while ${operation}.`);
  }
  if (result.outputLimited) {
    throw boundaryError(
      "codex_output_limit",
      `Codex exceeded its output limit while ${operation}.`,
    );
  }
  if (result.exitCode !== 0 || result.signal) {
    throw boundaryError(
      "codex_process_failed",
      `Codex failed while ${operation} (exit ${result.exitCode ?? "signal"}).`,
    );
  }
}

function workerResultSchema() {
  return z.toJSONSchema(WorkerResultSchema);
}

function smokeBrief() {
  return {
    briefId: SMOKE_BRIEF_ID,
    goal: `Read ${INPUT_FILE} and create ${OUTPUT_FILE} with exactly the same single line.`,
    doneMeans: [`${OUTPUT_FILE} exists and exactly matches ${INPUT_FILE}.`],
    environment:
      "Disposable local smoke workspace with no project or promotion authority.",
    actions: {
      allowed: [`Read ${INPUT_FILE}.`, `Create ${OUTPUT_FILE}.`],
      denied: [
        "Read outside the workspace.",
        "Use network access.",
        "Commit, publish, or promote anything.",
      ],
      confirmationRequired: [],
    },
    evidenceContract: {
      requiredChecks: [
        {
          checkId: SMOKE_CHECK_ID,
          label: "Smoke output exactly matches the supplied input",
          kind: "artifact",
          command: null,
          blocking: true,
        },
      ],
      expectedArtifacts: [OUTPUT_FILE],
      blockIntegration: true,
    },
  };
}

function compileSmokePrompt(brief) {
  return [
    "You are the bounded execution worker for a non-authoritative ODEU connectivity smoke.",
    "The JSON brief below is the complete authority boundary.",
    `Use a local tool to read ${INPUT_FILE}. Create only ${OUTPUT_FILE}, containing exactly the input file's single line including its final newline.`,
    "Do not read outside this disposable workspace. Do not use the network, commit, publish, or promote anything.",
    "After the file exists, return only the structured worker result required by the output schema.",
    "Your check and completion statements are claims; the host verifies the file independently.",
    "This smoke never creates an ODEU closure, candidate, reconciliation, or promotion receipt.",
    "",
    "IMMUTABLE SMOKE BRIEF",
    JSON.stringify(brief, null, 2),
  ].join("\n");
}

function parseJsonEvents(bytes) {
  const events = [];
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (cause) {
      throw boundaryError(
        "codex_event_invalid",
        "Codex emitted a non-JSON event on its JSONL output.",
        cause,
      );
    }
  }
  return events;
}

function assertCodexEventGrammar(events) {
  for (const event of events) {
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      typeof event.type !== "string" ||
      !CODEX_EVENT_TYPES.has(event.type)
    ) {
      throw boundaryError(
        "codex_event_invalid",
        "Codex emitted an event outside the closed smoke event grammar.",
      );
    }
    if (
      event.type.startsWith("item.") &&
      (!event.item ||
        typeof event.item !== "object" ||
        Array.isArray(event.item) ||
        typeof event.item.type !== "string" ||
        !CODEX_ITEM_TYPES.has(event.item.type))
    ) {
      throw boundaryError(
        "codex_item_invalid",
        "Codex emitted an item type outside the closed smoke action grammar.",
      );
    }
  }
}

function assertWorkerResult(value) {
  const parsed = WorkerResultSchema.safeParse(value);
  if (!parsed.success) {
    throw boundaryError(
      "worker_result_invalid",
      "Codex returned a worker result outside the exact output contract.",
    );
  }
  const result = parsed.data;
  const artifact = result.claimedArtifacts[0];
  const check = result.claimedChecks[0];
  if (
    result.outcome !== "returned" ||
    result.completionClaim.claimedDone !== true ||
    result.completionClaim.criteriaClaimedSatisfied.length !== 1 ||
    result.completionClaim.criteriaClaimedSatisfied[0] !== true ||
    result.claimedArtifacts.length !== 1 ||
    artifact?.path !== OUTPUT_FILE ||
    artifact.kind !== "added" ||
    artifact.reference !== OUTPUT_FILE ||
    result.claimedChecks.length !== 1 ||
    check?.checkId !== SMOKE_CHECK_ID ||
    check.status !== "passed" ||
    check.reference !== OUTPUT_FILE ||
    result.failures.length !== 0 ||
    result.unresolved.length !== 0
  ) {
    throw boundaryError(
      "worker_result_mismatch",
      "Codex's structured worker result does not match the smoke brief.",
    );
  }
  return result;
}

function assertCodexLifecycle(events) {
  const threadIndexes = [];
  const turnStartedIndexes = [];
  const turnCompletedIndexes = [];
  for (const [index, event] of events.entries()) {
    if (event?.type === "thread.started") threadIndexes.push(index);
    if (event?.type === "turn.started") turnStartedIndexes.push(index);
    if (event?.type === "turn.completed") turnCompletedIndexes.push(index);
    if (
      event?.type === "turn.failed" ||
      event?.type === "error" ||
      event?.item?.type === "error"
    ) {
      throw boundaryError(
        "codex_turn_failed",
        "Codex emitted a failed or error event during the smoke turn.",
      );
    }
  }
  const threadEvent = events[threadIndexes[0]];
  const completionEvent = events[turnCompletedIndexes[0]];
  const usage = completionEvent?.usage;
  const turnStartedIndex = turnStartedIndexes[0];
  const turnCompletedIndex = turnCompletedIndexes[0];
  const itemIndexes = events
    .map((event, index) => [event, index])
    .filter(([event]) => String(event?.type ?? "").startsWith("item."))
    .map(([, index]) => index);
  if (
    threadIndexes.length !== 1 ||
    turnStartedIndexes.length !== 1 ||
    turnCompletedIndexes.length !== 1 ||
    threadIndexes[0] !== 0 ||
    !(threadIndexes[0] < turnStartedIndexes[0]) ||
    !(turnStartedIndexes[0] < turnCompletedIndexes[0]) ||
    turnCompletedIndexes[0] !== events.length - 1 ||
    itemIndexes.length === 0 ||
    itemIndexes.some(
      (index) => !(turnStartedIndex < index && index < turnCompletedIndex),
    ) ||
    typeof threadEvent?.thread_id !== "string" ||
    !threadEvent.thread_id.trim() ||
    !usage ||
    typeof usage !== "object" ||
    !Number.isSafeInteger(usage.input_tokens) ||
    usage.input_tokens <= 0 ||
    !Number.isSafeInteger(usage.cached_input_tokens) ||
    usage.cached_input_tokens < 0 ||
    usage.cached_input_tokens > usage.input_tokens ||
    !Number.isSafeInteger(usage.output_tokens) ||
    usage.output_tokens <= 0 ||
    !Number.isSafeInteger(usage.reasoning_output_tokens) ||
    usage.reasoning_output_tokens < 0 ||
    usage.reasoning_output_tokens > usage.output_tokens
  ) {
    throw boundaryError(
      "codex_lifecycle_invalid",
      "Codex did not emit one ordered, usage-bearing completed turn.",
    );
  }
  return {
    turnStartedIndex,
    turnCompletedIndex,
    usage: {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      outputTokens: usage.output_tokens,
      reasoningOutputTokens: usage.reasoning_output_tokens,
    },
  };
}

function assertFinalAgentMessage(events, lifecycle) {
  const messages = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event?.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string" &&
        event.item.text.trim(),
    );
  const lastItemIndex = events.reduce(
    (last, event, index) =>
      String(event?.type ?? "").startsWith("item.") ? index : last,
    -1,
  );
  if (
    messages.length === 0 ||
    !(lifecycle.turnStartedIndex < messages.at(-1).index) ||
    !(messages.at(-1).index < lifecycle.turnCompletedIndex) ||
    messages.at(-1).index !== lastItemIndex
  ) {
    throw boundaryError(
      "codex_agent_message_invalid",
      "Codex did not emit a final in-turn agent message after all other items.",
    );
  }
  const finalMessage = messages.at(-1);
  return {
    completedAgentMessageCount: messages.length,
    index: finalMessage.index,
    text: finalMessage.event.item.text,
  };
}

function assertToolObservations(events, workspace, lifecycle) {
  let completedCommandCount = 0;
  let completedFileChangeCount = 0;
  let lastSuccessfulToolIndex = -1;
  const actionItemStates = new Map();
  const expectedOutput = join(workspace, OUTPUT_FILE);
  for (const [index, event] of events.entries()) {
    const actionType =
      event.item?.type === "command_execution" ||
      event.item?.type === "file_change"
        ? event.item.type
        : null;
    if (!actionType) continue;
    const actionId = event.item?.id;
    if (
      typeof actionId !== "string" ||
      !actionId.trim() ||
      actionId.length > 512
    ) {
      throw boundaryError(
        "codex_action_lifecycle_invalid",
        "Codex emitted a workspace action without a bounded item identity.",
      );
    }
    const priorState = actionItemStates.get(actionId);
    if (priorState?.type !== undefined && priorState.type !== actionType) {
      throw boundaryError(
        "codex_action_lifecycle_invalid",
        "Codex changed an action item's type during the smoke turn.",
      );
    }
    if (event.type !== "item.completed") {
      if (priorState?.completed) {
        throw boundaryError(
          "codex_action_lifecycle_invalid",
          "Codex updated a workspace action after reporting it complete.",
        );
      }
      actionItemStates.set(actionId, { completed: false, type: actionType });
      continue;
    }
    if (priorState?.completed) {
      throw boundaryError(
        "codex_action_lifecycle_invalid",
        "Codex completed the same workspace action more than once.",
      );
    }
    actionItemStates.set(actionId, { completed: true, type: actionType });
    if (event.item?.type === "command_execution") {
      if (event.item.status !== "completed" || event.item.exit_code !== 0) {
        throw boundaryError(
          "codex_tool_failed",
          "Codex emitted a non-successful command execution.",
        );
      }
      completedCommandCount += 1;
      lastSuccessfulToolIndex = index;
    }
    if (event.item?.type === "file_change") {
      const changes = event.item.changes;
      if (
        event.item.status !== "completed" ||
        !Array.isArray(changes) ||
        changes.length === 0 ||
        changes.some((change) => {
          if (change?.kind !== "add" || typeof change.path !== "string")
            return true;
          const path = isAbsolute(change.path)
            ? resolve(change.path)
            : resolve(workspace, change.path);
          return path !== expectedOutput;
        })
      ) {
        throw boundaryError(
          "codex_file_change_outside_contract",
          "Codex emitted a file-change event outside the exact smoke artifact.",
        );
      }
      completedFileChangeCount += 1;
      lastSuccessfulToolIndex = index;
    }
  }
  if ([...actionItemStates.values()].some((state) => !state.completed)) {
    throw boundaryError(
      "codex_action_lifecycle_invalid",
      "Codex left a workspace action incomplete at turn completion.",
    );
  }
  if (completedCommandCount + completedFileChangeCount === 0) {
    throw boundaryError(
      "codex_tool_execution_unobserved",
      "Codex completed the turn without an observed successful workspace tool execution.",
    );
  }
  if (
    !(lifecycle.turnStartedIndex < lastSuccessfulToolIndex) ||
    !(lastSuccessfulToolIndex < lifecycle.turnCompletedIndex)
  ) {
    throw boundaryError(
      "codex_event_order_invalid",
      "Codex's successful workspace tool event was outside the completed turn.",
    );
  }
  return {
    completedCommandCount,
    completedFileChangeCount,
    lastSuccessfulToolIndex,
  };
}

async function readStableRegularFileNoFollow(
  path,
  unavailableCode,
  unavailableMessage,
) {
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (cause) {
    throw boundaryError(unavailableCode, unavailableMessage, cause);
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) {
      throw boundaryError(unavailableCode, unavailableMessage);
    }
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.byteLength) !== after.size
    ) {
      throw boundaryError(
        "smoke_artifact_unstable",
        "A smoke artifact changed while the host read it through a no-follow descriptor.",
      );
    }
    return { bytes, status: after };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function publishEvidence(path, evidence) {
  if (!path) return false;
  assertNotInterrupted();
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  let file;
  let created = false;
  try {
    file = await open(destination, "wx", 0o600);
    created = true;
    await file.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await file.sync();
    assertNotInterrupted();
  } catch (cause) {
    await file?.close().catch(() => undefined);
    file = undefined;
    if (created) await rm(destination, { force: true }).catch(() => undefined);
    if (cause?.code === "smoke_interrupted") throw cause;
    throw boundaryError(
      "evidence_publish_failed",
      "The redacted smoke evidence file could not be created exactly once.",
      cause,
    );
  } finally {
    await file?.close().catch(() => undefined);
  }
  return true;
}

async function assertEvidenceDestinationAvailable(path) {
  if (!path) return;
  try {
    await lstat(resolve(path));
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    throw boundaryError(
      "evidence_destination_unavailable",
      "The smoke evidence destination could not be inspected safely.",
      cause,
    );
  }
  throw boundaryError(
    "evidence_destination_exists",
    "Refusing to replace an existing smoke evidence destination.",
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!optionFlag(options, "allow-live-provider-call")) {
    throw boundaryError(
      "live_provider_opt_in_missing",
      "Refusing a real Codex call without --allow-live-provider-call.",
    );
  }
  if (
    /^(?:1|true|yes)$/iu.test(String(process.env.CI ?? "")) &&
    !optionFlag(options, "allow-ci-live-provider-call")
  ) {
    throw boundaryError(
      "ci_live_provider_opt_in_missing",
      "CI requires the separate --allow-ci-live-provider-call gate.",
    );
  }
  if (process.platform === "win32") {
    throw boundaryError(
      "secure_process_tree_unsupported",
      "The local-session smoke requires POSIX process-group cleanup (Linux, WSL, or macOS).",
    );
  }
  assertNotInterrupted();
  const evidenceFile = optionString(options, "evidence-file");
  const model = optionString(options, "model");
  if (model && !SAFE_IDENTIFIER_PATTERN.test(model)) {
    throw boundaryError(
      "model_identifier_invalid",
      "The configured model must be a bounded provider identifier.",
    );
  }
  await assertEvidenceDestinationAvailable(evidenceFile);

  const configuredBinary = optionString(options, "codex-bin");
  const binary = await trustedCodexBinary(configuredBinary);
  const executableTrust = configuredBinary
    ? "explicit_override"
    : "project_bundled_recorded_digests";
  const bundledProvenance = configuredBinary
    ? null
    : await bundledCodexProvenance(binary);
  const [executableDigest, harnessSourceDigest] = await Promise.all([
    bundledProvenance ? bundledProvenance.launcherDigest : sha256File(binary),
    sha256File(HARNESS_SOURCE_PATH),
  ]);
  assertNotInterrupted();
  const environment = codexProcessEnvironment();
  const versionResult = await runBoundedProcess({
    command: binary,
    args: ["--version"],
    cwd: REPOSITORY_ROOT,
    environment,
    timeoutMs: 10_000,
  });
  requireSuccessfulProcess(versionResult, "reading its version");
  const version = versionResult.stdout.toString("utf8").trim();
  const versionToken = version.startsWith("codex-cli ")
    ? version.slice("codex-cli ".length)
    : "";
  if (
    !SAFE_IDENTIFIER_PATTERN.test(versionToken) ||
    (bundledProvenance &&
      version !== `codex-cli ${bundledProvenance.packageVersion}`)
  ) {
    throw boundaryError(
      "codex_version_invalid",
      "The configured executable is not Codex CLI.",
    );
  }

  const loginResult = await runBoundedProcess({
    command: binary,
    args: ["login", "status"],
    cwd: REPOSITORY_ROOT,
    environment,
    timeoutMs: 10_000,
  });
  requireSuccessfulProcess(loginResult, "checking cached authentication");
  const loginStatus = Buffer.concat([
    loginResult.stdout,
    loginResult.stderr,
  ]).toString("utf8");
  if (!/Logged in using ChatGPT/iu.test(loginStatus)) {
    throw boundaryError(
      "chatgpt_login_required",
      "The local-session smoke requires an existing Codex ChatGPT login.",
    );
  }

  const temporaryRoot = await mkdtemp(
    join(SECURE_TEMPORARY_PARENT, "odeu-local-codex-session-smoke-"),
  );
  const workspace = join(temporaryRoot, "workspace");
  const workerHome = join(temporaryRoot, "worker-home");
  const schemaPath = join(temporaryRoot, "worker-result.schema.json");
  const brief = smokeBrief();
  const schema = workerResultSchema();
  const schemaContent = `${JSON.stringify(schema)}\n`;
  const prompt = compileSmokePrompt(brief);
  const startedAt = new Date().toISOString();
  let evidence;
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(workerHome, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(join(workspace, INPUT_FILE), EXPECTED_OUTPUT, {
        flag: "wx",
        mode: 0o400,
      }),
      writeFile(schemaPath, schemaContent, {
        flag: "wx",
        mode: 0o400,
      }),
    ]);

    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--color",
      "never",
      "--json",
      "--output-schema",
      schemaPath,
      "-c",
      'approval_policy="never"',
      "-c",
      "allow_login_shell=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c",
      'shell_environment_policy.inherit="none"',
      "-c",
      `shell_environment_policy.set=${shellEnvironmentPolicy(workerHome)}`,
      "-C",
      workspace,
    ];
    if (model) args.push("--model", model);
    args.push(prompt);

    const result = await runBoundedProcess({
      command: binary,
      args,
      cwd: REPOSITORY_ROOT,
      environment,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    requireSuccessfulProcess(result, "running the local-session smoke");
    const events = parseJsonEvents(result.stdout);
    assertCodexEventGrammar(events);
    const lifecycle = assertCodexLifecycle(events);
    const {
      completedCommandCount,
      completedFileChangeCount,
      lastSuccessfulToolIndex,
    } = assertToolObservations(events, workspace, lifecycle);
    const finalMessage = assertFinalAgentMessage(events, lifecycle);
    if (lastSuccessfulToolIndex >= finalMessage.index) {
      throw boundaryError(
        "codex_event_order_invalid",
        "Codex's final worker report did not follow its successful workspace tool event.",
      );
    }
    let workerResult;
    try {
      workerResult = JSON.parse(finalMessage.text);
    } catch (cause) {
      throw boundaryError(
        "worker_result_invalid",
        "Codex's final message was not structured JSON.",
        cause,
      );
    }
    workerResult = assertWorkerResult(workerResult);

    const [inputObservation, outputObservation] = await Promise.all([
      readStableRegularFileNoFollow(
        join(workspace, INPUT_FILE),
        "smoke_input_unavailable",
        "The host-owned smoke input is unavailable as a regular file.",
      ),
      readStableRegularFileNoFollow(
        join(workspace, OUTPUT_FILE),
        "smoke_output_missing",
        "Codex created no regular smoke output.",
      ),
    ]);
    const observedInput = inputObservation.bytes.toString("utf8");
    const observedOutput = outputObservation.bytes.toString("utf8");
    const inputStatus = inputObservation.status;
    const outputStatus = outputObservation.status;
    if (
      observedInput !== EXPECTED_OUTPUT ||
      observedOutput !== EXPECTED_OUTPUT ||
      !inputStatus.isFile() ||
      !outputStatus.isFile() ||
      (inputStatus.ino !== 0n &&
        inputStatus.dev === outputStatus.dev &&
        inputStatus.ino === outputStatus.ino)
    ) {
      throw boundaryError(
        "smoke_output_mismatch",
        "The smoke input/output do not independently match the host-owned artifact contract.",
      );
    }
    const [entries, temporaryEntries, workerHomeEntries, observedSchema] =
      await Promise.all([
        readdir(workspace).then((items) => items.sort()),
        readdir(temporaryRoot).then((items) => items.sort()),
        readdir(workerHome),
        readFile(schemaPath, "utf8"),
      ]);
    if (
      stableJson(entries) !== stableJson([INPUT_FILE, OUTPUT_FILE].sort()) ||
      stableJson(temporaryEntries) !==
        stableJson(
          ["worker-home", "worker-result.schema.json", "workspace"].sort(),
        ) ||
      workerHomeEntries.length !== 0 ||
      observedSchema !== schemaContent
    ) {
      throw boundaryError(
        "unexpected_workspace_effect",
        "Codex changed something outside the exact final smoke artifact boundary.",
      );
    }

    const eventTypes = [
      ...new Set(events.map((event) => String(event?.type ?? "unknown"))),
    ].sort();
    if ((await sha256File(HARNESS_SOURCE_PATH)) !== harnessSourceDigest) {
      throw boundaryError(
        "harness_source_changed",
        "The smoke harness source changed while the observation was in progress.",
      );
    }
    evidence = {
      schema: "odeu.local-codex-session-smoke-evidence",
      version: 2,
      status: "passed",
      observedAt: new Date().toISOString(),
      startedAt,
      harness: {
        implementationVersion: 2,
        sourceDigest: harnessSourceDigest,
      },
      authority: {
        class: "diagnostic_only",
        odeuRunAuthorized: false,
        closureEligible: false,
        candidateEligible: false,
        reconciliationEligible: false,
        promotionEligible: false,
      },
      provider: {
        authentication: bundledProvenance
          ? "cached_chatgpt_login"
          : "executable_reported_chatgpt_login",
        codexVersion: bundledProvenance
          ? version
          : "explicit_override_redacted",
        codexVersionDigest: sha256(version),
        configuredModel: model ? "explicit_model_redacted" : "codex_default",
        configuredModelDigest: model ? sha256(model) : null,
        executableTrust,
        executableDigest,
        nativeExecutableDigest:
          bundledProvenance?.nativeExecutableDigest ?? null,
        packageMetadataMatchedLock:
          bundledProvenance?.packageMetadataMatchedLock ?? false,
        installedBytesVerifiedAgainstPackageIntegrity:
          bundledProvenance?.installedBytesVerifiedAgainstPackageIntegrity ??
          false,
        packageVersion: bundledProvenance?.packageVersion ?? null,
        packageLockIntegrity: bundledProvenance?.packageLockIntegrity ?? null,
        platformPackageVersion:
          bundledProvenance?.platformPackageVersion ?? null,
        platformPackageLockIntegrity:
          bundledProvenance?.platformPackageLockIntegrity ?? null,
        localTurnObserved: true,
        externalTurnObserved: bundledProvenance !== null,
        externalTurnObservationBasis: bundledProvenance
          ? "project_bundled_cli_ordered_usage_bearing_turn"
          : "untrusted_executable_override",
        toolExecutionObserved: true,
      },
      brief: {
        briefId: SMOKE_BRIEF_ID,
        promptDigest: sha256(prompt),
        outputSchemaDigest: sha256(stableJson(schema)),
        expectedArtifact: OUTPUT_FILE,
        expectedArtifactDigest: sha256(EXPECTED_OUTPUT),
      },
      observation: {
        eventTypes,
        eventCount: events.length,
        completedCommandCount,
        completedFileChangeCount,
        completedAgentMessageCount: finalMessage.completedAgentMessageCount,
        workerResultDigest: sha256(stableJson(workerResult)),
        artifactDigest: sha256(observedOutput),
        artifactByteLength: Buffer.byteLength(observedOutput),
        stderrDigest: sha256(result.stderr),
        stderrByteLength: result.stderr.byteLength,
        usage: lifecycle.usage,
        effectVerificationScope:
          "final_workspace_entries_and_descriptor_read_artifact_bytes_after_inherited_process_group_quiescence",
        toolArtifactCausalityEstablished: false,
      },
      safety: {
        disposableWorkspace: true,
        workspaceRetained: false,
        ephemeralSession: true,
        userConfigIgnored: true,
        userRulesIgnored: true,
        workerNetworkEnabled: false,
        workerWriteScope: "workspace_only_configured",
        workerReadIsolationEnforced: false,
        inheritedProcessGroupQuiescentBeforeVerification:
          result.processGroupQuiescent,
        escapedDescendantContainmentEnforced: false,
        processTreeContainmentEnforced: false,
        workspaceSnapshotRaceFreedomEstablished: false,
        workerEnvironmentInherited: false,
        rawPromptStored: false,
        rawResponseStored: false,
        rawAuthStored: false,
        threadIdentifierStored: false,
      },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  assertNotInterrupted();
  const evidencePublished = await publishEvidence(evidenceFile, evidence);
  try {
    assertNotInterrupted();
  } catch (cause) {
    if (evidencePublished) {
      await rm(resolve(evidenceFile), { force: true }).catch(() => undefined);
    }
    throw cause;
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error) => {
  const safeFailure = {
    schema: "odeu.local-codex-session-smoke-failure",
    version: 2,
    status: "failed",
    code: typeof error?.code === "string" ? error.code : "unexpected_failure",
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : "The local Codex session smoke failed.",
    rawProviderPayloadIncluded: false,
    rawAuthIncluded: false,
  };
  process.stderr.write(`${JSON.stringify(safeFailure)}\n`);
  process.exitCode =
    safeFailure.code === "live_provider_opt_in_missing"
      ? 2
      : safeFailure.code === "smoke_interrupted" && interruptedSignal
        ? SIGNAL_EXIT_CODES[interruptedSignal]
        : 1;
});
