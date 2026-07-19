#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const HARNESS_SOURCE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(HARNESS_SOURCE_PATH), "..");
const PRIVATE_REPOSITORY_OUTPUT_ROOT = join(REPOSITORY_ROOT, ".working");
const REPOSITORY_GIT_PATH = join(REPOSITORY_ROOT, ".git");
const DEFAULT_RUNTIME_ROOT = join(
  REPOSITORY_ROOT,
  ".working",
  "application-live",
  "runtime-v1",
);
const DEFAULT_EVIDENCE_FILE = join(
  REPOSITORY_ROOT,
  ".working",
  "evidence",
  "application-live-readiness-v1.json",
);
const TARGET_REF = "refs/heads/main";
const REPOSITORY_ID = "odeu-application-live-demo-v1";
const SIGNING_KEY_ID = "odeu-application-live-signing-v1";
const FIXED_COMMIT_DATE = "2026-07-19T00:00:00.000Z";
const COMMAND_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT_BYTES = 4 * 1_024 * 1_024;
const VALUE_OPTIONS = new Set(["evidence-file", "mode", "runtime-root"]);
const FLAG_OPTIONS = new Set([
  "allow-ci-provider-capable-readiness",
  "allow-provider-capable-readiness",
]);
const MODES = new Set(["dry-run", "provider-capable"]);
const SAFE_PATH_INPUT = /^[^\0\r\n]+$/u;
const READINESS_BOUNDARY_ERROR = Symbol("odeu.readiness-boundary-error");
const PACKAGE_JSON_MAX_BYTES = 2 * 1_024 * 1_024;
const GENERATED_ENVIRONMENT_KEYS = [
  "OPENAI_MODEL",
  "ODEU_MANAGER_MODE",
  "ODEU_CODEX_MODE",
  "ODEU_OPERATOR_ALLOWED_ORIGIN",
  "ODEU_OPERATOR_BEARER_SECRET",
  "ODEU_CODEX_WORKSPACE",
  "ODEU_CODEX_HOME",
  "ODEU_CODEX_LEDGER_FILE",
  "ODEU_CODEX_AUTH_SECRET",
  "ODEU_CODEX_REPOSITORY_ID",
  "ODEU_CODEX_PROMOTION_TARGET_REF",
  "ODEU_CODEX_CANDIDATE_STORE",
  "ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID",
  "ODEU_CODEX_ARTIFACT_SIGNING_SECRET",
  "ODEU_LIVE_EVIDENCE_SIGNING_SECRETS",
  "ODEU_LIVE_EVIDENCE_REPOSITORIES",
  "ODEU_CODEX_PROMOTION_REPOSITORY",
  "ODEU_CODEX_PROMOTION_STATUS_STORE",
  "ODEU_CODEX_ALLOW_PRIMARY_WORKTREE",
].sort();

const SEED_FILES = Object.freeze({
  "README.md": [
    "# ODEU application-live demo artifact",
    "",
    "This private disposable repository is provisioned for the bounded home-move live journey.",
    "The moving-cost implementation is intentionally incomplete at the base commit.",
    "",
  ].join("\n"),
  "demo/moving-costs.html": [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8">',
    "    <title>Moving cost comparison</title>",
    "  </head>",
    "  <body>",
    "    <main>",
    "      <h1>Moving cost comparison</h1>",
    "      <p>The bounded comparison tool has not been implemented yet.</p>",
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n"),
  "demo/moving-costs.mjs": [
    "export function calculateMovingTotalCents() {",
    '  throw new Error("Moving-cost calculation is not implemented.");',
    "}",
    "",
  ].join("\n"),
  "package.json": `${JSON.stringify(
    {
      name: "odeu-application-live-demo-artifact",
      private: true,
      type: "module",
      scripts: {
        test: "node scripts/moving-cost-focused-test.mjs",
      },
    },
    null,
    2,
  )}\n`,
  "scripts/moving-cost-focused-test.mjs": [
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    "",
    'import { calculateMovingTotalCents } from "../demo/moving-costs.mjs";',
    "",
    "const vectors = [",
    "  { input: { base: 900, distance: 120, fees: 80 }, expected: 110_000 },",
    "  { input: { base: 840.25, distance: 190.4, fees: 40.35 }, expected: 107_100 },",
    "  { input: { base: 1_100, distance: 0, fees: 0 }, expected: 110_000 },",
    "];",
    "for (const vector of vectors) {",
    "  assert.equal(calculateMovingTotalCents(vector.input), vector.expected);",
    "}",
    'const html = await readFile(new URL("../demo/moving-costs.html", import.meta.url), "utf8");',
    'assert.ok((html.match(/class\\s*=\\s*["\'][^"\']*\\bquote\\b/giu) ?? []).length >= 2);',
    'assert.ok((html.match(/name\\s*=\\s*["\']base["\']/giu) ?? []).length >= 2);',
    'assert.ok((html.match(/name\\s*=\\s*["\']distance["\']/giu) ?? []).length >= 2);',
    'assert.ok((html.match(/name\\s*=\\s*["\']fees["\']/giu) ?? []).length >= 2);',
    'assert.match(html, /<form\\b/iu);',
    'assert.match(html, /<output\\b/iu);',
    'assert.equal((html.match(/import\\s*\\{\\s*calculateMovingTotalCents\\s*\\}\\s*from\\s*["\']\\.\\/moving-costs\\.mjs["\']/giu) ?? []).length, 1);',
    'console.log("moving-cost focused contract passed");',
    "",
  ].join("\n"),
});

function boundaryError(code, message, cause) {
  const error = Object.assign(
    new Error(message, cause ? { cause } : undefined),
    { code },
  );
  Object.defineProperty(error, READINESS_BOUNDARY_ERROR, { value: true });
  return error;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw boundaryError("unexpected_argument", "Only named readiness options are accepted.");
    }
    const equals = argument.indexOf("=");
    const key = argument.slice(2, equals >= 0 ? equals : undefined);
    if (!VALUE_OPTIONS.has(key) && !FLAG_OPTIONS.has(key)) {
      throw boundaryError(
        "unknown_option",
        "The readiness command received an unsupported named option.",
      );
    }
    if (Object.hasOwn(options, key)) {
      throw boundaryError(
        "duplicate_option",
        "The readiness command received a duplicate named option.",
      );
    }
    if (equals >= 0) {
      const value = argument.slice(equals + 1);
      if (FLAG_OPTIONS.has(key) || !value.trim()) {
        throw boundaryError(
          "option_value_invalid",
          "A readiness option received an invalid value.",
        );
      }
      options[key] = value;
      continue;
    }
    if (VALUE_OPTIONS.has(key)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--") || !value.trim()) {
        throw boundaryError(
          "option_value_missing",
          "A readiness option is missing its required value.",
        );
      }
      options[key] = value;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function optionString(options, key, fallback) {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionFlag(options, key) {
  return options[key] === true;
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

function safeConfiguredPath(value, label) {
  if (!SAFE_PATH_INPUT.test(value)) {
    throw boundaryError("path_invalid", `${label} must be one bounded local path.`);
  }
  return resolve(REPOSITORY_ROOT, value);
}

async function assertAbsent(path, code, message) {
  try {
    await lstat(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    throw boundaryError(`${code}_unavailable`, message, cause);
  }
  throw boundaryError(code, message);
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeExclusive(path, content, mode = 0o600) {
  let file;
  try {
    file = await open(path, "wx", mode);
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file?.close();
  }
  await syncDirectory(dirname(path));
}

async function createPrivateDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function privatePathMode(status) {
  return status.mode & 0o777;
}

async function assertPrivateDirectory(path) {
  const [canonical, status] = await Promise.all([realpath(path), lstat(path)]);
  if (
    canonical !== path ||
    !status.isDirectory() ||
    privatePathMode(status) !== 0o700 ||
    (typeof process.geteuid === "function" && status.uid !== process.geteuid())
  ) {
    throw boundaryError(
      "private_runtime_invalid",
      "The application-live runtime contains a non-private or indirect directory.",
    );
  }
}

async function assertPrivateFile(path) {
  const [canonical, status] = await Promise.all([realpath(path), lstat(path)]);
  if (
    canonical !== path ||
    !status.isFile() ||
    privatePathMode(status) !== 0o600 ||
    (typeof process.geteuid === "function" && status.uid !== process.geteuid())
  ) {
    throw boundaryError(
      "private_runtime_invalid",
      "The application-live runtime contains a non-private or indirect file.",
    );
  }
}

function processEnvironment(extra = {}) {
  return {
    HOME: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    ...extra,
  };
}

async function boundedCommand(command, args, input = {}) {
  try {
    const result = await execFile(command, args, {
      cwd: input.cwd,
      encoding: "utf8",
      env: input.env ?? processEnvironment(),
      maxBuffer: OUTPUT_LIMIT_BYTES,
      timeout: input.timeoutMs ?? COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    if (typeof cause?.code === "number") {
      return {
        exitCode: cause.code,
        stdout: typeof cause.stdout === "string" ? cause.stdout : "",
        stderr: typeof cause.stderr === "string" ? cause.stderr : "",
      };
    }
    throw boundaryError(
      "local_command_unavailable",
      "A required bounded local readiness command was unavailable.",
      cause,
    );
  }
}

async function requiredCommand(command, args, input = {}) {
  const result = await boundedCommand(command, args, input);
  if (result.exitCode !== 0) {
    throw boundaryError(
      input.failureCode ?? "local_command_failed",
      input.failureMessage ?? "A required bounded local readiness command failed.",
    );
  }
  return result.stdout.trim();
}

async function git(args, input = {}) {
  return requiredCommand(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      ...args,
    ],
    {
      ...input,
      failureCode: "git_readiness_failed",
      failureMessage: "The private demo Git boundary could not be provisioned or verified.",
    },
  );
}

async function assertSafeRepositoryOutputPath(path, kind) {
  if (!containsPath(REPOSITORY_ROOT, path)) return;

  const code =
    kind === "runtime" ? "runtime_location_invalid" : "evidence_location_invalid";
  const message =
    kind === "runtime"
      ? "A repository-local application-live runtime must be a Git-ignored descendant of .working and outside Git metadata."
      : "A repository-local readiness evidence file must be a Git-ignored descendant of .working and outside Git metadata.";
  if (
    path === PRIVATE_REPOSITORY_OUTPUT_ROOT ||
    !containsPath(PRIVATE_REPOSITORY_OUTPUT_ROOT, path) ||
    containsPath(REPOSITORY_GIT_PATH, path)
  ) {
    throw boundaryError(code, message);
  }

  const ignored = await boundedCommand(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-C",
      REPOSITORY_ROOT,
      "check-ignore",
      "--quiet",
      "--",
      relative(REPOSITORY_ROOT, path),
    ],
    { env: processEnvironment() },
  );
  if (ignored.exitCode !== 0) throw boundaryError(code, message);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function environmentFile(values) {
  const keys = Object.keys(values).sort();
  return [
    "# ODEU application-live readiness environment v1",
    "# Private runtime configuration only. No provider credential is stored here.",
    "# Export OPENAI_API_KEY separately before a manual provider-backed journey.",
    ...keys.map((key) => `export ${key}=${shellQuote(values[key])}`),
    "",
  ].join("\n");
}

async function writeSeedFiles(seed) {
  for (const [fileName, content] of Object.entries(SEED_FILES).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const path = join(seed, fileName);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeExclusive(path, content, 0o600);
  }
}

async function provisionGitBoundary(paths) {
  const seed = join(paths.root, ".seed");
  await createPrivateDirectory(seed);
  await writeSeedFiles(seed);
  await git(["init", "--object-format=sha1", "--initial-branch=main", seed], {
    cwd: paths.root,
  });
  await git(["-C", seed, "add", "--all", "--", "."], { cwd: paths.root });
  await git(
    [
      "-C",
      seed,
      "-c",
      "user.name=ODEU Application Live Provisioner",
      "-c",
      "user.email=application-live@odeu.invalid",
      "commit",
      "--no-gpg-sign",
      "--message",
      "Provision deterministic ODEU application-live demo base",
    ],
    {
      cwd: paths.root,
      env: processEnvironment({
        GIT_AUTHOR_DATE: FIXED_COMMIT_DATE,
        GIT_COMMITTER_DATE: FIXED_COMMIT_DATE,
      }),
    },
  );
  const baseCommit = await git(["-C", seed, "rev-parse", "HEAD"], {
    cwd: paths.root,
  });
  const baseTree = await git(["-C", seed, "rev-parse", "HEAD^{tree}"], {
    cwd: paths.root,
  });
  await git(
    [
      "init",
      "--bare",
      "--object-format=sha1",
      "--initial-branch=main",
      paths.repository,
    ],
    { cwd: paths.root },
  );
  await git(
    [
      "-c",
      "protocol.file.allow=always",
      "-C",
      seed,
      "push",
      paths.repository,
      `${TARGET_REF}:${TARGET_REF}`,
    ],
    { cwd: paths.root },
  );
  await git(
    ["--git-dir", paths.repository, "symbolic-ref", "HEAD", TARGET_REF],
    { cwd: paths.root },
  );
  await git(
    [
      "--git-dir",
      paths.repository,
      "worktree",
      "add",
      "--detach",
      paths.workspace,
      TARGET_REF,
    ],
    { cwd: paths.root },
  );
  await Promise.all([
    chmod(paths.repository, 0o700),
    chmod(paths.workspace, 0o700),
  ]);
  await rm(seed, { recursive: true, force: false });
  await syncDirectory(paths.root);
  return { baseCommit, baseTree };
}

async function regularExecutable(path) {
  const canonical = await realpath(path);
  const status = await lstat(canonical);
  if (!status.isFile() || (status.mode & 0o111) === 0) {
    throw boundaryError(
      "toolchain_unavailable",
      "A required exact local toolchain executable is unavailable.",
    );
  }
  return canonical;
}

async function proveSandboxBoundary() {
  for (const directory of ["/usr", "/bin", "/lib", "/lib64", "/proc/self/fd"]) {
    const status = await lstat(await realpath(directory));
    if (!status.isDirectory()) {
      throw boundaryError(
        "sandbox_boundary_unavailable",
        "The Linux live-evidence sandbox mount boundary is unavailable.",
      );
    }
  }
  await Promise.all([
    regularExecutable("/usr/bin/git"),
    regularExecutable("/usr/bin/bwrap"),
    regularExecutable("/usr/bin/prlimit"),
    regularExecutable("/usr/bin/node"),
  ]);
  const marker = "ODEU_APPLICATION_LIVE_SANDBOX_READY";
  const output = await requiredCommand(
    "/usr/bin/bwrap",
    [
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
      String(8 * 1_024 * 1_024),
      "--tmpfs",
      "/tmp",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp",
      "/usr/bin/prlimit",
      "--core=0:0",
      "--memlock=0:0",
      "--nproc=32:32",
      "--nofile=128:128",
      "--",
      "/usr/bin/node",
      "-e",
      `process.stdout.write(${JSON.stringify(`${marker}\n`)})`,
    ],
    {
      env: processEnvironment(),
      failureCode: "sandbox_boundary_unavailable",
      failureMessage:
        "The no-network bubblewrap/prlimit/Node readiness boundary did not execute.",
    },
  );
  if (output !== marker) {
    throw boundaryError(
      "sandbox_boundary_invalid",
      "The no-network readiness boundary returned an unexpected observation.",
    );
  }
}

async function validateGitBoundary(paths, expected) {
  const [bare, repositoryGitDirectory, topLevel, gitDirectory, commonDirectory] =
    await Promise.all([
      git(["-C", paths.repository, "rev-parse", "--is-bare-repository"]),
      git(["-C", paths.repository, "rev-parse", "--absolute-git-dir"]),
      git(["-C", paths.workspace, "rev-parse", "--show-toplevel"]),
      git([
        "-C",
        paths.workspace,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ]),
      git([
        "-C",
        paths.workspace,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    ]);
  if (
    bare !== "true" ||
    (await realpath(repositoryGitDirectory)) !== paths.repository ||
    resolve(topLevel) !== paths.workspace ||
    resolve(gitDirectory) === resolve(commonDirectory) ||
    (await realpath(commonDirectory)) !== paths.repository
  ) {
    throw boundaryError(
      "git_topology_invalid",
      "The private demo repository is not one exact bare repository with a linked worktree.",
    );
  }

  const [head, target, targetRecord, status, ignored, staged, treeEntries, worktrees] =
    await Promise.all([
      git(["-C", paths.workspace, "rev-parse", "HEAD"]),
      git(["-C", paths.repository, "rev-parse", TARGET_REF]),
      git([
        "-C",
        paths.repository,
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
        TARGET_REF,
      ]),
      git([
        "-C",
        paths.workspace,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
      git([
        "-C",
        paths.workspace,
        "status",
        "--ignored",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
      git(["-C", paths.workspace, "ls-files", "--stage"]),
      git(["-C", paths.workspace, "ls-tree", "-r", "--name-only", "HEAD"]),
      git(["--git-dir", paths.repository, "worktree", "list", "--porcelain"]),
    ]);
  const expectedEntries = Object.keys(SEED_FILES).sort();
  const observedEntries = treeEntries.split("\n").filter(Boolean).sort();
  if (
    head !== expected.baseCommit ||
    target !== expected.baseCommit ||
    targetRecord !== `${TARGET_REF}\0${expected.baseCommit}\0commit\0` ||
    status !== "" ||
    ignored !== "" ||
    staged.split("\n").some((line) => line.startsWith("160000 ")) ||
    stableJson(observedEntries) !== stableJson(expectedEntries) ||
    !worktrees.includes("detached") ||
    worktrees.includes(`branch ${TARGET_REF}`)
  ) {
    throw boundaryError(
      "git_boundary_invalid",
      "The private demo Git base, target ref, worktree, or exact seed tree is not ready.",
    );
  }

  const symbolicHead = await boundedCommand(
    "/usr/bin/git",
    ["-C", paths.workspace, "symbolic-ref", "-q", "HEAD"],
    { env: processEnvironment() },
  );
  if (symbolicHead.exitCode !== 1 || symbolicHead.stdout !== "") {
    throw boundaryError(
      "git_topology_invalid",
      "The execution workspace must remain detached from the authoritative target ref.",
    );
  }

  const configNames = await git([
    "config",
    "--file",
    join(paths.repository, "config"),
    "--no-includes",
    "--name-only",
    "--list",
  ]);
  if (
    configNames
      .split("\n")
      .filter(Boolean)
      .some((name) =>
        /^(?:include(?:if)?\.|filter\..+\.(?:clean|smudge|process)|extensions\.partialclone|remote\..+\.(?:promisor|partialclonefilter|uploadpack))/iu.test(
          name,
        ),
      )
  ) {
    throw boundaryError(
      "git_configuration_invalid",
      "The private demo repository contains unsafe repository-controlled Git helpers.",
    );
  }
}

async function validateRuntime(paths, environmentContent) {
  await Promise.all([
    assertPrivateDirectory(paths.root),
    assertPrivateDirectory(paths.repository),
    assertPrivateDirectory(paths.workspace),
    assertPrivateDirectory(paths.codexHome),
    assertPrivateDirectory(paths.authority),
    assertPrivateDirectory(paths.candidateStore),
    assertPrivateDirectory(paths.promotionStatus),
    assertPrivateFile(paths.ledgerFile),
    assertPrivateFile(paths.environmentFile),
  ]);
  const disjointStores = [
    paths.repository,
    paths.workspace,
    paths.codexHome,
    paths.authority,
    paths.candidateStore,
    paths.promotionStatus,
  ];
  const canonicalStores = await Promise.all(disjointStores.map((path) => realpath(path)));
  for (let left = 0; left < canonicalStores.length; left += 1) {
    for (let right = left + 1; right < canonicalStores.length; right += 1) {
      if (
        containsPath(canonicalStores[left], canonicalStores[right]) ||
        containsPath(canonicalStores[right], canonicalStores[left])
      ) {
        throw boundaryError(
          "runtime_stores_overlap",
          "The application-live runtime stores must be physically disjoint.",
        );
      }
    }
  }
  const entries = (await readdir(paths.root)).sort();
  if (
    stableJson(entries) !==
    stableJson(
      [
        "application-live.env",
        "authority",
        "candidate-store",
        "codex-home",
        "promotion-status",
        "repository.git",
        "workspace",
      ].sort(),
    )
  ) {
    throw boundaryError(
      "runtime_layout_invalid",
      "The private application-live runtime contains an unexpected entry.",
    );
  }
  const observedEnvironment = await readFile(paths.environmentFile, "utf8");
  if (
    observedEnvironment !== environmentContent ||
    /^export (?:OPENAI_API_KEY|CODEX_API_KEY)=/mu.test(observedEnvironment)
  ) {
    throw boundaryError(
      "runtime_environment_invalid",
      "The private runtime environment was not retained exactly or contains a provider credential.",
    );
  }
  const statusHandle = await open(paths.promotionStatus, "r");
  try {
    const anchored = await realpath(`/proc/self/fd/${statusHandle.fd}`);
    if (anchored !== paths.promotionStatus) {
      throw boundaryError(
        "descriptor_boundary_invalid",
        "The private promotion journal cannot be addressed through the required descriptor boundary.",
      );
    }
  } finally {
    await statusHandle.close();
  }
}

function applicationDependencyError(cause) {
  return boundaryError(
    "application_dependencies_unavailable",
    "The exact installed application runtime is unavailable or does not match package-lock.json; run npm ci first.",
    cause,
  );
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

async function dependencyJson(path) {
  try {
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > PACKAGE_JSON_MAX_BYTES) {
      throw new Error("dependency metadata exceeds its byte limit");
    }
    const parsed = JSON.parse(content);
    if (!objectValue(parsed)) throw new Error("dependency metadata is not an object");
    return parsed;
  } catch (cause) {
    throw applicationDependencyError(cause);
  }
}

function packageRoot(name) {
  return join(REPOSITORY_ROOT, "node_modules", ...name.split("/"));
}

function runtimeExport(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = runtimeExport(candidate);
      if (selected) return selected;
    }
    return null;
  }
  const record = objectValue(value);
  if (!record) return null;
  for (const condition of [
    "node",
    "import",
    "module",
    "default",
    "require",
    "browser",
  ]) {
    const selected = runtimeExport(record[condition]);
    if (selected) return selected;
  }
  return null;
}

function packageRuntimeEntry(manifest) {
  const exports = objectValue(manifest.exports);
  return (
    runtimeExport(exports?.["."] ?? manifest.exports) ??
    (typeof manifest.module === "string" ? manifest.module : null) ??
    (typeof manifest.main === "string" ? manifest.main : null) ??
    "index.js"
  );
}

async function exactRuntimeFile(path, root, options = {}) {
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
    const status = await lstat(canonicalPath);
    if (
      !status.isFile() ||
      !containsPath(canonicalRoot, canonicalPath) ||
      (options.executable === true && (status.mode & 0o111) === 0)
    ) {
      throw new Error("installed runtime file is invalid");
    }
    return {
      canonicalPath,
      digest: await sha256File(canonicalPath),
    };
  } catch (cause) {
    throw applicationDependencyError(cause);
  }
}

function lockedPackage(lockfile, name) {
  const packages = objectValue(lockfile.packages);
  const locked = objectValue(packages?.[`node_modules/${name}`]);
  if (
    !locked ||
    typeof locked.version !== "string" ||
    typeof locked.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/=]+$/u.test(locked.integrity)
  ) {
    throw applicationDependencyError();
  }
  return locked;
}

async function installedPackage(lockfile, name, expectedVersion, options = {}) {
  const root = packageRoot(name);
  const manifestPath = join(root, "package.json");
  try {
    if ((await realpath(root)) !== root) throw new Error("package root is indirect");
  } catch (cause) {
    throw applicationDependencyError(cause);
  }
  const [manifest, manifestDigest] = await Promise.all([
    dependencyJson(manifestPath),
    sha256File(manifestPath).catch((cause) => {
      throw applicationDependencyError(cause);
    }),
  ]);
  const locked = lockedPackage(lockfile, name);
  if (
    manifest.version !== expectedVersion ||
    locked.version !== expectedVersion ||
    (options.expectedManifestName ?? name) !== manifest.name
  ) {
    throw applicationDependencyError();
  }
  let runtimeEntryDigest = null;
  if (options.runtimeEntry !== false) {
    const entry = packageRuntimeEntry(manifest);
    const entryPath = resolve(root, entry);
    if (!containsPath(root, entryPath)) throw applicationDependencyError();
    const runtime = await exactRuntimeFile(entryPath, root);
    runtimeEntryDigest = runtime.digest;
  }
  return {
    name,
    version: expectedVersion,
    manifest,
    manifestDigest,
    runtimeEntryDigest,
    root,
  };
}

function linuxRuntimePackages() {
  const architectures = {
    arm64: {
      codexPackage: "@openai/codex-linux-arm64",
      codexTriple: "aarch64-unknown-linux-musl",
      nextArchitecture: "arm64",
    },
    x64: {
      codexPackage: "@openai/codex-linux-x64",
      codexTriple: "x86_64-unknown-linux-musl",
      nextArchitecture: "x64",
    },
  };
  const architecture = architectures[process.arch];
  if (!architecture) throw applicationDependencyError();
  const libc = process.report.getReport().header.glibcVersionRuntime
    ? "gnu"
    : "musl";
  return {
    ...architecture,
    nextPackage: `@next/swc-linux-${architecture.nextArchitecture}-${libc}`,
    nextBinary: `next-swc.linux-${architecture.nextArchitecture}-${libc}.node`,
  };
}

function noNetworkApplicationCommand(command, args) {
  const nodeRoot = resolve(dirname(process.execPath), "..");
  return requiredCommand(
    "/usr/bin/bwrap",
    [
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
      String(8 * 1_024 * 1_024),
      "--tmpfs",
      "/tmp",
      "--dir",
      "/app",
      "--ro-bind",
      REPOSITORY_ROOT,
      "/app",
      "--dir",
      "/runtime",
      "--ro-bind",
      nodeRoot,
      "/runtime",
      "--chdir",
      "/app",
      "--clearenv",
      "--setenv",
      "PATH",
      "/runtime/bin:/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "NODE_ENV",
      "production",
      "/usr/bin/prlimit",
      "--core=0:0",
      "--memlock=0:0",
      "--nproc=32:32",
      "--nofile=128:128",
      "--",
      command,
      ...args,
    ],
    {
      env: processEnvironment(),
      timeoutMs: 30_000,
      failureCode: "application_dependencies_unavailable",
      failureMessage:
        "The exact installed application runtime is unavailable or does not match package-lock.json; run npm ci first.",
    },
  );
}

async function observeNoNetworkApplicationRuntime(
  codexNativeExecutable,
  codexVersion,
) {
  const importProbe = [
    'const openai = await import("openai");',
    'const codexSdk = await import("@openai/codex-sdk");',
    'const next = await import("next");',
    "const observation = {",
    '  openai: typeof openai.default === "function",',
    '  codexSdk: typeof codexSdk.Codex === "function",',
    '  next: typeof next.default === "function",',
    "};",
    "if (Object.values(observation).some((loaded) => !loaded)) process.exit(1);",
    "process.stdout.write(JSON.stringify(observation));",
  ].join("\n");
  const nativeRelativePath = relative(
    REPOSITORY_ROOT,
    codexNativeExecutable.canonicalPath,
  );
  if (
    !nativeRelativePath ||
    nativeRelativePath === ".." ||
    nativeRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(nativeRelativePath)
  ) {
    throw applicationDependencyError();
  }
  const [importOutput, codexVersionOutput] = await Promise.all([
    noNetworkApplicationCommand("/runtime/bin/node", [
      "--input-type=module",
      "--eval",
      importProbe,
    ]),
    noNetworkApplicationCommand(`/app/${nativeRelativePath}`, ["--version"]),
  ]);
  let imports;
  try {
    imports = JSON.parse(importOutput);
  } catch (cause) {
    throw applicationDependencyError(cause);
  }
  if (
    stableJson(imports) !==
      stableJson({ codexSdk: true, next: true, openai: true }) ||
    codexVersionOutput !== `codex-cli ${codexVersion}`
  ) {
    throw applicationDependencyError();
  }
  return {
    importSmokeDigest: sha256(stableJson(imports)),
    codexCliVersion: codexVersion,
  };
}

async function installedApplicationDependencies() {
  const applicationPackagePath = join(REPOSITORY_ROOT, "package.json");
  const lockfilePath = join(REPOSITORY_ROOT, "package-lock.json");
  const [applicationPackage, lockfile] = await Promise.all([
    dependencyJson(applicationPackagePath),
    dependencyJson(lockfilePath),
  ]);
  const applicationDependencies = objectValue(applicationPackage.dependencies);
  const lockfileRoot = objectValue(objectValue(lockfile.packages)?.[""]);
  if (
    lockfile.lockfileVersion !== 3 ||
    applicationPackage.packageManager !== "npm@11.9.0" ||
    applicationPackage.engines?.node !== "24.x" ||
    !applicationDependencies ||
    stableJson(lockfileRoot?.dependencies) !== stableJson(applicationDependencies)
  ) {
    throw applicationDependencyError();
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24) {
    throw boundaryError(
      "node_version_unsupported",
      "Application-live readiness requires the repository's Node.js 24 runtime.",
    );
  }

  const productionPackages = [];
  for (const [name, version] of Object.entries(applicationDependencies).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version)) {
      throw applicationDependencyError();
    }
    productionPackages.push(await installedPackage(lockfile, name, version));
  }

  const packageByName = Object.fromEntries(
    productionPackages.map((installed) => [installed.name, installed]),
  );
  const next = packageByName.next;
  const codexSdk = packageByName["@openai/codex-sdk"];
  const openai = packageByName.openai;
  if (!next || !codexSdk || !openai) throw applicationDependencyError();

  const codexVersion = codexSdk.manifest.dependencies?.["@openai/codex"];
  if (typeof codexVersion !== "string") throw applicationDependencyError();
  const codex = await installedPackage(lockfile, "@openai/codex", codexVersion, {
    runtimeEntry: false,
  });
  const platform = linuxRuntimePackages();
  const codexPlatformSpec = codex.manifest.optionalDependencies?.[
    platform.codexPackage
  ];
  const codexPlatformVersion =
    typeof codexPlatformSpec === "string"
      ? codexPlatformSpec.match(/^npm:@openai\/codex@(.+)$/u)?.[1]
      : undefined;
  if (!codexPlatformVersion) throw applicationDependencyError();
  const codexPlatform = await installedPackage(
    lockfile,
    platform.codexPackage,
    codexPlatformVersion,
    { expectedManifestName: "@openai/codex", runtimeEntry: false },
  );

  const nextPlatformVersion = next.manifest.optionalDependencies?.[
    platform.nextPackage
  ];
  if (nextPlatformVersion !== next.version) throw applicationDependencyError();
  const nextPlatform = await installedPackage(
    lockfile,
    platform.nextPackage,
    next.version,
  );

  const nextLauncherRelative = next.manifest.bin?.next;
  const codexLauncherRelative = codex.manifest.bin?.codex;
  if (
    typeof nextLauncherRelative !== "string" ||
    typeof codexLauncherRelative !== "string"
  ) {
    throw applicationDependencyError();
  }
  const nextLauncher = await exactRuntimeFile(
    resolve(next.root, nextLauncherRelative),
    next.root,
    { executable: true },
  );
  const linkedNextLauncher = await exactRuntimeFile(
    join(REPOSITORY_ROOT, "node_modules", ".bin", "next"),
    next.root,
    { executable: true },
  );
  if (linkedNextLauncher.canonicalPath !== nextLauncher.canonicalPath) {
    throw applicationDependencyError();
  }
  const codexLauncher = await exactRuntimeFile(
    resolve(codex.root, codexLauncherRelative),
    codex.root,
    { executable: true },
  );
  const codexNativeExecutable = await exactRuntimeFile(
    join(
      codexPlatform.root,
      "vendor",
      platform.codexTriple,
      "bin",
      "codex",
    ),
    codexPlatform.root,
    { executable: true },
  );
  const nextNativeRuntime = await exactRuntimeFile(
    join(nextPlatform.root, platform.nextBinary),
    nextPlatform.root,
  );

  const npmRoot = resolve(dirname(process.execPath), "..");
  const npmCommand = join(dirname(process.execPath), "npm");
  const npmRuntime = await exactRuntimeFile(npmCommand, npmRoot, {
    executable: true,
  });
  const npmEnvironment = processEnvironment({
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: "/dev/null",
  });
  const npmVersion = await requiredCommand(npmCommand, ["--version"], {
    cwd: REPOSITORY_ROOT,
    env: npmEnvironment,
    failureCode: "application_dependencies_unavailable",
    failureMessage:
      "The exact installed application runtime is unavailable or does not match package-lock.json; run npm ci first.",
  });
  if (npmVersion !== "11.9.0") throw applicationDependencyError();
  const npmTree = await boundedCommand(npmCommand, ["ls", "--all", "--json"], {
    cwd: REPOSITORY_ROOT,
    env: npmEnvironment,
    timeoutMs: 60_000,
  });
  let npmTreeDocument;
  try {
    npmTreeDocument = JSON.parse(npmTree.stdout);
  } catch (cause) {
    throw applicationDependencyError(cause);
  }
  const npmProblems = Array.isArray(npmTreeDocument?.problems)
    ? npmTreeDocument.problems.filter(
        (problem) =>
          typeof problem !== "string" || !problem.startsWith("extraneous:"),
      )
    : [];
  if (npmTree.exitCode !== 0 || npmProblems.length > 0) {
    throw applicationDependencyError();
  }
  const runtimeObservation = await observeNoNetworkApplicationRuntime(
    codexNativeExecutable,
    codexVersion,
  );

  const productionDependencyVersions = Object.fromEntries(
    productionPackages.map(({ name, version }) => [name, version]),
  );
  const productionDependencyManifestDigest = sha256(
    stableJson(
      productionPackages.map(
        ({ name, version, manifestDigest, runtimeEntryDigest }) => ({
          name,
          version,
          manifestDigest,
          runtimeEntryDigest,
        }),
      ),
    ),
  );
  return {
    nodeVersion: process.version,
    npmVersion,
    applicationPackageDigest: await sha256File(applicationPackagePath),
    lockfileDigest: await sha256File(lockfilePath),
    productionDependencyVersions,
    productionDependencyManifestDigest,
    nextPackageDigest: next.manifestDigest,
    nextLauncherDigest: nextLauncher.digest,
    nextNativePackageDigest: nextPlatform.manifestDigest,
    nextNativeRuntimeDigest: nextNativeRuntime.digest,
    openaiPackageDigest: openai.manifestDigest,
    openaiRuntimeEntryDigest: openai.runtimeEntryDigest,
    codexSdkPackageDigest: codexSdk.manifestDigest,
    codexSdkRuntimeEntryDigest: codexSdk.runtimeEntryDigest,
    codexLauncherPackageDigest: codex.manifestDigest,
    codexLauncherDigest: codexLauncher.digest,
    codexPlatformPackageDigest: codexPlatform.manifestDigest,
    codexNativeExecutableDigest: codexNativeExecutable.digest,
    importSmokeDigest: runtimeObservation.importSmokeDigest,
    codexCliVersion: runtimeObservation.codexCliVersion,
    npmRuntimeDigest: npmRuntime.digest,
  };
}

async function createRuntime(root) {
  const parent = dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent) {
    throw boundaryError(
      "runtime_parent_indirect",
      "The application-live runtime parent must not contain symlink indirection.",
    );
  }
  await createPrivateDirectory(root);
  const paths = {
    root,
    repository: join(root, "repository.git"),
    workspace: join(root, "workspace"),
    codexHome: join(root, "codex-home"),
    authority: join(root, "authority"),
    ledgerFile: join(root, "authority", "ledger.json"),
    candidateStore: join(root, "candidate-store"),
    promotionStatus: join(root, "promotion-status"),
    environmentFile: join(root, "application-live.env"),
  };
  await Promise.all([
    createPrivateDirectory(paths.codexHome),
    createPrivateDirectory(paths.authority),
    createPrivateDirectory(paths.candidateStore),
    createPrivateDirectory(paths.promotionStatus),
  ]);
  await writeExclusive(
    paths.ledgerFile,
    `${JSON.stringify({
      kind: "odeu.application-live-ledger-publication-slot",
      version: 1,
      status: "awaiting_exact_browser_ledger",
    })}\n`,
  );
  const gitBoundary = await provisionGitBoundary(paths);
  const secrets = {
    operator: randomBytes(32).toString("base64url"),
    runAuthorization: randomBytes(32).toString("base64url"),
    artifactSigning: randomBytes(32).toString("base64url"),
  };
  if (new Set(Object.values(secrets)).size !== 3) {
    throw boundaryError(
      "secret_generation_failed",
      "Distinct private runtime authorities could not be generated.",
    );
  }
  const values = {
    OPENAI_MODEL: "gpt-5.6",
    ODEU_MANAGER_MODE: "live",
    ODEU_CODEX_MODE: "live",
    ODEU_OPERATOR_ALLOWED_ORIGIN: "http://localhost:3000",
    ODEU_OPERATOR_BEARER_SECRET: secrets.operator,
    ODEU_CODEX_WORKSPACE: paths.workspace,
    ODEU_CODEX_HOME: paths.codexHome,
    ODEU_CODEX_LEDGER_FILE: paths.ledgerFile,
    ODEU_CODEX_AUTH_SECRET: secrets.runAuthorization,
    ODEU_CODEX_REPOSITORY_ID: REPOSITORY_ID,
    ODEU_CODEX_PROMOTION_TARGET_REF: TARGET_REF,
    ODEU_CODEX_CANDIDATE_STORE: paths.candidateStore,
    ODEU_CODEX_ARTIFACT_SIGNING_KEY_ID: SIGNING_KEY_ID,
    ODEU_CODEX_ARTIFACT_SIGNING_SECRET: secrets.artifactSigning,
    ODEU_LIVE_EVIDENCE_SIGNING_SECRETS: JSON.stringify({
      [SIGNING_KEY_ID]: secrets.artifactSigning,
    }),
    ODEU_LIVE_EVIDENCE_REPOSITORIES: JSON.stringify({
      [REPOSITORY_ID]: { repositoryPath: paths.repository },
    }),
    ODEU_CODEX_PROMOTION_REPOSITORY: paths.repository,
    ODEU_CODEX_PROMOTION_STATUS_STORE: paths.promotionStatus,
    ODEU_CODEX_ALLOW_PRIMARY_WORKTREE: "false",
  };
  const content = environmentFile(values);
  await writeExclusive(paths.environmentFile, content);
  return { paths, gitBoundary, environmentContent: content };
}

async function publishEvidence(path, evidence) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let file;
  let created = false;
  try {
    file = await open(path, "wx", 0o600);
    created = true;
    await file.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await syncDirectory(parent);
  } catch (cause) {
    await file?.close().catch(() => undefined);
    if (created) {
      await rm(path, { force: true }).catch(() => undefined);
      await syncDirectory(parent).catch(() => undefined);
    }
    throw boundaryError(
      "evidence_publish_failed",
      "The redacted application-live readiness evidence could not be created exactly once.",
      cause,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const mode = optionString(options, "mode", "dry-run");
  if (!MODES.has(mode)) {
    throw boundaryError(
      "mode_invalid",
      "Readiness mode must be dry-run or provider-capable.",
    );
  }
  const providerCapable = mode === "provider-capable";
  if (
    providerCapable &&
    !optionFlag(options, "allow-provider-capable-readiness")
  ) {
    throw boundaryError(
      "provider_capable_opt_in_missing",
      "Provider-capable readiness requires --allow-provider-capable-readiness.",
    );
  }
  if (
    providerCapable &&
    /^(?:1|true|yes)$/iu.test(String(process.env.CI ?? "")) &&
    !optionFlag(options, "allow-ci-provider-capable-readiness")
  ) {
    throw boundaryError(
      "ci_provider_capable_opt_in_missing",
      "CI requires --allow-ci-provider-capable-readiness as a separate gate.",
    );
  }
  const providerCredentialConfigured = providerCapable
    ? Boolean(process.env.OPENAI_API_KEY?.trim())
    : false;
  if (providerCapable && !providerCredentialConfigured) {
    throw boundaryError(
      "provider_credential_missing",
      "Provider-capable readiness requires OPENAI_API_KEY in process memory.",
    );
  }
  if (process.platform !== "linux") {
    throw boundaryError(
      "platform_unsupported",
      "Application-live readiness requires Linux because the promotion and verifier boundaries use /proc and bubblewrap.",
    );
  }

  process.umask(0o077);
  const runtimeRoot = safeConfiguredPath(
    optionString(options, "runtime-root", DEFAULT_RUNTIME_ROOT),
    "The runtime root",
  );
  const evidenceFile = safeConfiguredPath(
    optionString(options, "evidence-file", DEFAULT_EVIDENCE_FILE),
    "The evidence destination",
  );
  await Promise.all([
    assertSafeRepositoryOutputPath(runtimeRoot, "runtime"),
    assertSafeRepositoryOutputPath(evidenceFile, "evidence"),
  ]);
  if (containsPath(runtimeRoot, evidenceFile)) {
    throw boundaryError(
      "evidence_location_invalid",
      "Readiness evidence must be outside the private runtime it describes.",
    );
  }
  await assertAbsent(
    evidenceFile,
    "evidence_destination_exists",
    "Refusing to replace an existing application-live readiness evidence file.",
  );
  await assertAbsent(
    runtimeRoot,
    "runtime_root_exists",
    "Refusing to replace an existing application-live runtime root.",
  );

  const [dependencies, harnessDigest] = await Promise.all([
    installedApplicationDependencies(),
    sha256File(HARNESS_SOURCE_PATH),
  ]);
  await proveSandboxBoundary();
  const runtime = await createRuntime(runtimeRoot);
  await validateGitBoundary(runtime.paths, runtime.gitBoundary);
  await validateRuntime(runtime.paths, runtime.environmentContent);
  if ((await sha256File(HARNESS_SOURCE_PATH)) !== harnessDigest) {
    throw boundaryError(
      "harness_source_changed",
      "The application-live readiness harness changed during its observation.",
    );
  }

  const runtimeChecks = [
    "node-24-application-runtime",
    "installed-next-and-codex-sdk",
    "no-network-openai-codex-sdk-next-import-and-codex-version",
    "exact-system-git",
    "private-posix-runtime",
    "descriptor-anchored-private-store",
    "deterministic-bare-repository",
    "detached-linked-worktree",
    "direct-target-ref-equals-head",
    "clean-zero-ignored-zero-gitlink-workspace",
    "disjoint-home-ledger-candidate-and-status-stores",
    "exact-loopback-operator-origin",
    "distinct-run-artifact-and-operator-authorities",
    "live-evidence-repository-and-signing-registry",
    "no-network-bubblewrap-prlimit-node-probe",
  ].map((checkId) => ({ checkId, result: "passed" }));
  const evidence = {
    schema: "odeu.application-live-readiness-evidence",
    version: 1,
    status: providerCapable
      ? "ready_for_manual_provider_journey"
      : "ready_except_provider_credential",
    mode,
    observedAt: new Date().toISOString(),
    harness: {
      implementationVersion: 1,
      sourceDigest: harnessDigest,
    },
    authority: {
      class: "readiness_only",
      providerCapableReadinessAuthorized: providerCapable,
      providerCallAuthorized: false,
      applicationRunAuthorized: false,
      closureEligible: false,
      candidateEligible: false,
      reconciliationEligible: false,
      promotionEligible: false,
    },
    provider: {
      credentialObservation: providerCapable
        ? "configured_redacted"
        : "intentionally_not_read",
      missingConfiguration: providerCapable ? [] : ["OPENAI_API_KEY"],
      callExecuted: false,
      browserJourneyExecuted: false,
    },
    runtime: {
      layoutVersion: 1,
      disposition: "created",
      root: "private_path_redacted",
      rootDigest: sha256(runtimeRoot),
      environmentFile: "application-live.env",
      environmentKeys: GENERATED_ENVIRONMENT_KEYS,
      providerCredentialPersisted: false,
      ledgerPublication: {
        initialState: "awaiting_exact_browser_ledger",
        replacementBoundary:
          "existing_live_authorization_request_publishes_exact_browser_ledger",
        additionalOperatorInputRequired: false,
      },
      repositoryId: REPOSITORY_ID,
      targetRef: TARGET_REF,
      baseCommit: runtime.gitBoundary.baseCommit,
      baseTree: runtime.gitBoundary.baseTree,
      seedManifestDigest: sha256(stableJson(SEED_FILES)),
      workspaceKind: "detached_linked_worktree",
      promotionRepositoryKind: "shared_bare_object_store_separate_authority_boundary",
    },
    dependencies,
    checks: runtimeChecks,
    safety: {
      createOnlyRuntime: true,
      createOnlyEvidence: true,
      providerCredentialReadInDryRun: false,
      providerCredentialStored: false,
      rawSecretsIncluded: false,
      rawPathsIncluded: false,
      providerCallExecuted: false,
      applicationJourneyExecuted: false,
    },
  };
  await publishEvidence(evidenceFile, evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error) => {
  const boundedFailure =
    error instanceof Error && error[READINESS_BOUNDARY_ERROR] === true;
  const failure = {
    schema: "odeu.application-live-readiness-failure",
    version: 1,
    status: "failed",
    code:
      boundedFailure && typeof error.code === "string"
        ? error.code
        : "unexpected_failure",
    message:
      boundedFailure
        ? error.message.slice(0, 500)
        : "Application-live readiness failed before redacted evidence could be published.",
    rawSecretsIncluded: false,
    rawPathsIncluded: false,
    providerCallExecuted: false,
    applicationJourneyExecuted: false,
  };
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode =
    failure.code === "provider_capable_opt_in_missing" ||
    failure.code === "ci_provider_capable_opt_in_missing"
      ? 2
      : 1;
});
