import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const smokeScript = join(
  repositoryRoot,
  "scripts",
  "codex-local-session-smoke.mjs",
);
const testTemporaryParent = process.platform === "win32" ? tmpdir() : "/tmp";
const temporaryRoots: string[] = [];
const lingeringProcessIds: number[] = [];

type ProcessResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

type RunOptions = {
  readonly interruptAfter?: Promise<unknown>;
  readonly signal?: NodeJS.Signals;
};

async function runSmoke(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const childEnvironment = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ...environment,
      NODE_ENV: "test" as const,
    } satisfies NodeJS.ProcessEnv;
    const child = spawn(process.execPath, [smokeScript, ...args], {
      cwd: repositoryRoot,
      env: childEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let closed = false;
    void options.interruptAfter
      ?.then(() => {
        if (!closed) child.kill(options.signal ?? "SIGTERM");
      })
      .catch((error: unknown) => {
        if (!closed) {
          child.kill("SIGKILL");
          rejectProcess(error);
        }
      });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectProcess);
    child.once("close", (exitCode, signal) => {
      closed = true;
      resolveProcess({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Process ${processId} survived bounded process cleanup`);
}

async function createFakeCodex(
  root: string,
  scenario:
    | "success"
    | "extra-effect"
    | "extra-claim"
    | "schema-extra-property"
    | "failed-tool"
    | "message-before-tool"
    | "multiple-message"
    | "unknown-action"
    | "unknown-event"
    | "wait-for-signal"
    | "orphan-child",
): Promise<{
  readonly binary: string;
  readonly descendantCanary: string;
  readonly observation: string;
}> {
  const binary = join(root, "fake-codex.mjs");
  const descendantCanary = join(root, "descendant-canary.txt");
  const observation = join(root, "fake-observation.json");
  const source = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
if (args[0] === "--version") {
  process.stdout.write("codex-cli fake-1\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
if (args[0] !== "exec") process.exit(9);
for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_THREAD_ID", "CODEX_SQLITE_HOME"]) {
  if (process.env[name]) {
    process.stderr.write("forbidden inherited environment: " + name + "\\n");
    process.exit(8);
  }
}
const workspace = args[args.indexOf("-C") + 1];
let orphanPid = null;
if (scenario === "orphan-child") {
  const orphan = spawn(process.execPath, ["-e", ${JSON.stringify(
    `const { writeFileSync } = require("node:fs"); setTimeout(() => writeFileSync(${JSON.stringify(
      descendantCanary,
    )}, "late descendant effect\n"), 250); setInterval(() => {}, 1000);`,
  )}], { stdio: "ignore" });
  orphanPid = orphan.pid;
  orphan.unref();
}
await writeFile(${JSON.stringify(observation)}, JSON.stringify({ workspace, env: Object.keys(process.env).sort(), orphanPid }));
if (scenario === "wait-for-signal") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await writeFile(join(workspace, "smoke-output.txt"), "ODEU local Codex session smoke passed.\\n");
if (scenario === "extra-effect") {
  await writeFile(join(workspace, "unexpected.txt"), "not authorized\\n");
}
const workerResult = {
  outcome: "returned",
  claimedEffects: ["Created the bounded smoke artifact."],
  claimedArtifacts: [{
    path: "smoke-output.txt",
    kind: "added",
    summary: "Exact smoke output.",
    reference: "smoke-output.txt",
  }],
  claimedChecks: [{
    checkId: "check-smoke-output-exact",
    label: "Smoke output exactly matches the supplied input",
    status: "passed",
    detail: "The output matches.",
    reference: "smoke-output.txt",
  }],
  failures: [],
  unresolved: [],
  completionClaim: { claimedDone: true, criteriaClaimedSatisfied: [true] },
  candidateReconciliationSummary: "Diagnostic-only smoke artifact created.",
};
if (scenario === "extra-claim") {
  workerResult.claimedArtifacts.push({
    path: "smoke-input.txt",
    kind: "observed",
    summary: "Undeclared additional claim.",
    reference: "smoke-input.txt",
  });
}
if (scenario === "schema-extra-property") workerResult.extra = "not allowed";
const thread = { type: "thread.started", thread_id: "provider-thread-secret" };
const turnStarted = { type: "turn.started" };
const tool = { type: "item.completed", item: { id: "cmd-1", type: "command_execution", status: scenario === "failed-tool" ? "failed" : "completed", exit_code: scenario === "failed-tool" ? 1 : 0, aggregated_output: "" } };
const message = { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: JSON.stringify(workerResult) } };
const turnCompleted = { type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 8, reasoning_output_tokens: 1 } };
const events = scenario === "message-before-tool"
  ? [thread, turnStarted, message, tool, turnCompleted]
  : scenario === "multiple-message"
    ? [thread, turnStarted, tool, message, { ...message, item: { ...message.item, id: "msg-2" } }, turnCompleted]
    : scenario === "unknown-action"
      ? [thread, turnStarted, tool, { type: "item.completed", item: { id: "secret-action", type: "provider-action-secret", status: "completed" } }, message, turnCompleted]
      : scenario === "unknown-event"
        ? [thread, turnStarted, tool, { type: "provider-event-secret" }, message, turnCompleted]
    : [thread, turnStarted, tool, message, turnCompleted];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
process.stderr.write("provider-response-secret\\n");
`;
  await writeFile(binary, source, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { binary, descendantCanary, observation };
}

afterEach(async () => {
  for (const processId of lingeringProcessIds.splice(0)) {
    try {
      process.kill(processId, "SIGKILL");
    } catch {
      // Already terminated by the harness under test.
    }
  }
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local Codex session smoke", () => {
  it("does not invoke Codex without explicit live-provider consent", async () => {
    const root = await mkdtemp(
      join(testTemporaryParent, "odeu-codex-smoke-test-"),
    );
    temporaryRoots.push(root);
    const fake = await createFakeCodex(root, "success");

    const result = await runSmoke(["--codex-bin", fake.binary]);

    expect(result).toMatchObject({ exitCode: 2, signal: null, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "failed",
      code: "live_provider_opt_in_missing",
      rawProviderPayloadIncluded: false,
      rawAuthIncluded: false,
    });
    await expect(readFile(fake.observation, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires a separate CI gate and preflights create-only evidence", async () => {
    const root = await mkdtemp(
      join(testTemporaryParent, "odeu-codex-smoke-test-"),
    );
    temporaryRoots.push(root);
    const fake = await createFakeCodex(root, "success");

    const ciResult = await runSmoke(
      ["--allow-live-provider-call", "--codex-bin", fake.binary],
      { CI: "1" },
    );
    expect(ciResult).toMatchObject({ exitCode: 1, signal: null, stdout: "" });
    expect(JSON.parse(ciResult.stderr)).toMatchObject({
      code: "ci_live_provider_opt_in_missing",
    });

    const evidenceFile = join(root, "existing-evidence.json");
    await writeFile(evidenceFile, "existing evidence must survive\n");
    const existingResult = await runSmoke([
      "--allow-live-provider-call",
      "--codex-bin",
      fake.binary,
      "--evidence-file",
      evidenceFile,
    ]);
    expect(existingResult).toMatchObject({
      exitCode: 1,
      signal: null,
      stdout: "",
    });
    expect(JSON.parse(existingResult.stderr)).toMatchObject({
      code: "evidence_destination_exists",
    });
    await expect(readFile(evidenceFile, "utf8")).resolves.toBe(
      "existing evidence must survive\n",
    );
    await expect(readFile(fake.observation, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("independently verifies effects and emits only redacted diagnostic evidence", async () => {
    const root = await mkdtemp(
      join(testTemporaryParent, "odeu-codex-smoke-test-"),
    );
    temporaryRoots.push(root);
    const fake = await createFakeCodex(root, "success");
    const evidenceFile = join(root, "evidence", "smoke.json");

    const result = await runSmoke(
      [
        "--allow-live-provider-call",
        "--codex-bin",
        fake.binary,
        "--evidence-file",
        evidenceFile,
        "--model",
        "provider-model-secret",
      ],
      {
        OPENAI_API_KEY: "server-openai-secret",
        CODEX_API_KEY: "server-codex-secret",
        CODEX_THREAD_ID: "parent-thread-secret",
        CODEX_SQLITE_HOME: "/private/sqlite-home",
      },
    );

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    const evidence = JSON.parse(result.stdout);
    expect(evidence).toMatchObject({
      schema: "odeu.local-codex-session-smoke-evidence",
      version: 2,
      status: "passed",
      harness: {
        implementationVersion: 2,
        sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
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
        authentication: "executable_reported_chatgpt_login",
        codexVersion: "explicit_override_redacted",
        codexVersionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        configuredModel: "explicit_model_redacted",
        configuredModelDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        executableTrust: "explicit_override",
        executableDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        nativeExecutableDigest: null,
        packageMetadataMatchedLock: false,
        installedBytesVerifiedAgainstPackageIntegrity: false,
        localTurnObserved: true,
        externalTurnObserved: false,
        externalTurnObservationBasis: "untrusted_executable_override",
        toolExecutionObserved: true,
      },
      observation: {
        completedCommandCount: 1,
        completedFileChangeCount: 0,
        completedAgentMessageCount: 1,
        artifactByteLength: 39,
        effectVerificationScope:
          "final_workspace_entries_and_descriptor_read_artifact_bytes_after_inherited_process_group_quiescence",
        toolArtifactCausalityEstablished: false,
      },
      safety: {
        workspaceRetained: false,
        workerWriteScope: "workspace_only_configured",
        workerReadIsolationEnforced: false,
        inheritedProcessGroupQuiescentBeforeVerification: true,
        escapedDescendantContainmentEnforced: false,
        processTreeContainmentEnforced: false,
        workspaceSnapshotRaceFreedomEstablished: false,
        rawPromptStored: false,
        rawResponseStored: false,
        rawAuthStored: false,
        threadIdentifierStored: false,
      },
    });
    expect(JSON.parse(await readFile(evidenceFile, "utf8"))).toEqual(evidence);
    expect((await stat(evidenceFile)).mode & 0o777).toBe(0o600);

    const serializedEvidence = JSON.stringify(evidence);
    for (const secret of [
      "server-openai-secret",
      "server-codex-secret",
      "parent-thread-secret",
      "provider-thread-secret",
      "provider-response-secret",
      "provider-model-secret",
      "fake-1",
      fake.binary,
    ]) {
      expect(serializedEvidence).not.toContain(secret);
    }
    const observation = JSON.parse(await readFile(fake.observation, "utf8"));
    expect(observation.env).not.toContain("OPENAI_API_KEY");
    expect(observation.env).not.toContain("CODEX_API_KEY");
    expect(observation.env).not.toContain("CODEX_THREAD_ID");
    expect(observation.env).not.toContain("CODEX_SQLITE_HOME");
    await expect(stat(observation.workspace)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed on an undeclared workspace effect and publishes no evidence", async () => {
    const root = await mkdtemp(
      join(testTemporaryParent, "odeu-codex-smoke-test-"),
    );
    temporaryRoots.push(root);
    const fake = await createFakeCodex(root, "extra-effect");
    const evidenceFile = join(root, "evidence.json");

    const result = await runSmoke([
      "--allow-live-provider-call",
      "--codex-bin",
      fake.binary,
      "--evidence-file",
      evidenceFile,
    ]);

    expect(result).toMatchObject({ exitCode: 1, signal: null, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "failed",
      code: "unexpected_workspace_effect",
      rawProviderPayloadIncluded: false,
      rawAuthIncluded: false,
    });
    await expect(readFile(evidenceFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const observation = JSON.parse(await readFile(fake.observation, "utf8"));
    await expect(stat(observation.workspace)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["extra-claim", "worker_result_mismatch"],
    ["schema-extra-property", "worker_result_invalid"],
    ["failed-tool", "codex_tool_failed"],
    ["message-before-tool", "codex_agent_message_invalid"],
    ["unknown-action", "codex_item_invalid"],
    ["unknown-event", "codex_event_invalid"],
  ] as const)(
    "fails closed on %s evidence and retains no pass record",
    async (scenario, expectedCode) => {
      const root = await mkdtemp(
        join(testTemporaryParent, "odeu-codex-smoke-test-"),
      );
      temporaryRoots.push(root);
      const fake = await createFakeCodex(root, scenario);
      const evidenceFile = join(root, "evidence.json");

      const result = await runSmoke([
        "--allow-live-provider-call",
        "--codex-bin",
        fake.binary,
        "--evidence-file",
        evidenceFile,
      ]);

      expect(result).toMatchObject({ exitCode: 1, signal: null, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "failed",
        code: expectedCode,
      });
      expect(result.stderr).not.toContain("provider-action-secret");
      expect(result.stderr).not.toContain("provider-event-secret");
      await expect(readFile(evidenceFile, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("uses the final report after a tool-backed turn with intermediate agent messages", async () => {
    const root = await mkdtemp(
      join(testTemporaryParent, "odeu-codex-smoke-test-"),
    );
    temporaryRoots.push(root);
    const fake = await createFakeCodex(root, "multiple-message");

    const result = await runSmoke([
      "--allow-live-provider-call",
      "--codex-bin",
      fake.binary,
    ]);

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      observation: {
        completedAgentMessageCount: 2,
        completedCommandCount: 1,
      },
    });
  });

  it("terminates the provider process group and cleans the workspace on interruption", async () => {
    const root = await mkdtemp(
      join(testTemporaryParent, "odeu-codex-smoke-test-"),
    );
    temporaryRoots.push(root);
    const fake = await createFakeCodex(root, "wait-for-signal");
    const evidenceFile = join(root, "evidence.json");

    const result = await runSmoke(
      [
        "--allow-live-provider-call",
        "--codex-bin",
        fake.binary,
        "--evidence-file",
        evidenceFile,
      ],
      {},
      { interruptAfter: waitForFile(fake.observation), signal: "SIGTERM" },
    );

    expect(result).toMatchObject({ signal: null, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "failed",
      code: "smoke_interrupted",
    });
    expect(result.exitCode).toBe(143);
    await expect(readFile(evidenceFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const observation = JSON.parse(await readFile(fake.observation, "utf8"));
    await expect(stat(observation.workspace)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform === "linux")(
    "kills a provider descendant that survives its launcher",
    async () => {
      const root = await mkdtemp(
        join(testTemporaryParent, "odeu-codex-smoke-test-"),
      );
      temporaryRoots.push(root);
      const fake = await createFakeCodex(root, "orphan-child");

      const result = await runSmoke([
        "--allow-live-provider-call",
        "--codex-bin",
        fake.binary,
      ]);

      expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
      const observation = JSON.parse(await readFile(fake.observation, "utf8"));
      expect(observation.orphanPid).toEqual(expect.any(Number));
      lingeringProcessIds.push(observation.orphanPid);
      await waitForProcessExit(observation.orphanPid);
      lingeringProcessIds.pop();
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
      await expect(
        readFile(fake.descendantCanary, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
