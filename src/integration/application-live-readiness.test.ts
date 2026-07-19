import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const readinessScript = join(
  repositoryRoot,
  "scripts",
  "application-live-readiness.mjs",
);
const temporaryRoots: string[] = [];

type ProcessResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

type ReadinessEvidence = {
  readonly schema: string;
  readonly status: string;
  readonly mode: string;
  readonly authority: {
    readonly class: string;
    readonly providerCapableReadinessAuthorized: boolean;
    readonly providerCallAuthorized: boolean;
    readonly applicationRunAuthorized: boolean;
    readonly closureEligible: boolean;
    readonly candidateEligible: boolean;
    readonly reconciliationEligible: boolean;
    readonly promotionEligible: boolean;
  };
  readonly provider: {
    readonly credentialObservation: string;
    readonly missingConfiguration: readonly string[];
    readonly callExecuted: boolean;
    readonly browserJourneyExecuted: boolean;
  };
  readonly runtime: {
    readonly root: string;
    readonly rootDigest: string;
    readonly providerCredentialPersisted: boolean;
    readonly ledgerPublication: {
      readonly initialState: string;
      readonly replacementBoundary: string;
      readonly additionalOperatorInputRequired: boolean;
    };
    readonly baseCommit: string;
    readonly baseTree: string;
    readonly seedManifestDigest: string;
  };
  readonly dependencies: {
    readonly nodeVersion: string;
    readonly npmVersion: string;
    readonly productionDependencyVersions: Readonly<Record<string, string>>;
    readonly openaiRuntimeEntryDigest: string;
    readonly codexNativeExecutableDigest: string;
    readonly nextNativeRuntimeDigest: string;
    readonly importSmokeDigest: string;
    readonly codexCliVersion: string;
  };
  readonly safety: {
    readonly createOnlyRuntime: boolean;
    readonly createOnlyEvidence: boolean;
    readonly providerCredentialReadInDryRun: boolean;
    readonly providerCredentialStored: boolean;
    readonly rawSecretsIncluded: boolean;
    readonly rawPathsIncluded: boolean;
    readonly providerCallExecuted: boolean;
    readonly applicationJourneyExecuted: boolean;
  };
};

function runReadiness(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
  script = readinessScript,
): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repositoryRoot,
      env: {
        HOME: "/tmp",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...environment,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectProcess);
    child.once("close", (exitCode, signal) => {
      resolveProcess({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function runtimeExport(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = runtimeExport(candidate);
      if (selected) return selected;
    }
    return undefined;
  }
  const record = jsonObject(value);
  if (!record) return undefined;
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
  return undefined;
}

function packageRuntimeEntry(manifest: JsonObject): string {
  const exports = jsonObject(manifest.exports);
  return (
    runtimeExport(exports?.["."] ?? manifest.exports) ??
    (typeof manifest.module === "string" ? manifest.module : undefined) ??
    (typeof manifest.main === "string" ? manifest.main : undefined) ??
    "index.js"
  );
}

async function writeFixtureFile(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode });
}

async function installedManifest(name: string): Promise<JsonObject> {
  return JSON.parse(
    await readFile(join(repositoryRoot, "node_modules", name, "package.json"), "utf8"),
  ) as JsonObject;
}

async function writeFixturePackage(
  root: string,
  name: string,
  manifest: JsonObject,
  options: { readonly runtimeEntry?: boolean } = {},
): Promise<void> {
  const packageRoot = join(root, "node_modules", name);
  await writeFixtureFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (options.runtimeEntry !== false) {
    await writeFixtureFile(
      resolve(packageRoot, packageRuntimeEntry(manifest)),
      "export {};\n",
    );
  }
}

async function dependencyFixture(
  failure: "missing-codex-native" | "stale-openai-runtime",
): Promise<string> {
  const root = await mkdtemp("/tmp/odeu-application-live-dependency-test-");
  temporaryRoots.push(root);
  const script = join(root, "scripts", "application-live-readiness.mjs");
  await writeFixtureFile(script, await readFile(readinessScript, "utf8"), 0o700);
  await Promise.all([
    writeFixtureFile(
      join(root, "package.json"),
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ),
    writeFixtureFile(
      join(root, "package-lock.json"),
      await readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
    ),
  ]);

  const applicationPackage = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { readonly dependencies: Readonly<Record<string, string>> };
  for (const name of Object.keys(applicationPackage.dependencies)) {
    const manifest = await installedManifest(name);
    const fixtureManifest =
      failure === "stale-openai-runtime" && name === "openai"
        ? { ...manifest, version: "0.0.0" }
        : manifest;
    await writeFixturePackage(root, name, fixtureManifest);
  }

  if (failure === "missing-codex-native") {
    const codex = await installedManifest("@openai/codex");
    await writeFixturePackage(root, "@openai/codex", codex, {
      runtimeEntry: false,
    });
    const codexArchitecture = process.arch === "arm64" ? "arm64" : "x64";
    const codexPlatformName = `@openai/codex-linux-${codexArchitecture}`;
    await writeFixturePackage(
      root,
      codexPlatformName,
      await installedManifest(codexPlatformName),
      { runtimeEntry: false },
    );

    const next = await installedManifest("next");
    const nextArchitecture = process.arch === "arm64" ? "arm64" : "x64";
    const report = jsonObject(process.report.getReport());
    const reportHeader = jsonObject(report?.header);
    const nextLibc = reportHeader?.glibcVersionRuntime ? "gnu" : "musl";
    const nextPlatformName = `@next/swc-linux-${nextArchitecture}-${nextLibc}`;
    await writeFixturePackage(
      root,
      nextPlatformName,
      await installedManifest(nextPlatformName),
    );

    const nextBin = jsonObject(next.bin)?.next;
    const codexBin = jsonObject(codex.bin)?.codex;
    if (typeof nextBin !== "string" || typeof codexBin !== "string") {
      throw new Error("Installed launcher metadata is unavailable for the fixture.");
    }
    await Promise.all([
      writeFixtureFile(
        resolve(root, "node_modules", "next", nextBin),
        "#!/usr/bin/env node\n",
        0o700,
      ),
      writeFixtureFile(
        resolve(root, "node_modules", "@openai/codex", codexBin),
        "#!/usr/bin/env node\n",
        0o700,
      ),
    ]);
    const linkedNext = join(root, "node_modules", ".bin", "next");
    await mkdir(dirname(linkedNext), { recursive: true, mode: 0o700 });
    await symlink("../next/dist/bin/next", linkedNext);
  }
  return script;
}

async function unexpectedFailureFixture(privatePath: string): Promise<string> {
  const root = await mkdtemp("/tmp/odeu-application-live-failure-test-");
  temporaryRoots.push(root);
  const script = join(root, "scripts", "application-live-readiness.mjs");
  const source = await readFile(readinessScript, "utf8");
  const instrumented = source.replace(
    "async function main() {",
    `async function main() {\n  await readFile(${JSON.stringify(privatePath)}, "utf8");`,
  );
  if (instrumented === source) {
    throw new Error("The readiness failure fixture could not be instrumented.");
  }
  await writeFixtureFile(script, instrumented, 0o700);
  return script;
}

function readinessArguments(runtimeRoot: string, evidenceFile: string): string[] {
  return [
    "--runtime-root",
    runtimeRoot,
    "--evidence-file",
    evidenceFile,
  ];
}

async function temporaryBoundary(): Promise<{
  readonly root: string;
  readonly runtimeRoot: string;
  readonly evidenceFile: string;
}> {
  const root = await mkdtemp("/tmp/odeu-application-live-readiness-test-");
  temporaryRoots.push(root);
  return {
    root,
    runtimeRoot: join(root, "runtime"),
    evidenceFile: join(root, "evidence.json"),
  };
}

function parseEvidence(content: string): ReadinessEvidence {
  return JSON.parse(content) as ReadinessEvidence;
}

function fileMode(mode: number): number {
  return mode & 0o777;
}

function exportedValue(content: string, key: string): string {
  const match = new RegExp(`^export ${key}='([^']*)'$`, "mu").exec(content);
  if (!match?.[1]) throw new Error(`Missing generated ${key} value.`);
  return match[1];
}

async function git(args: readonly string[]): Promise<string> {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("/usr/bin/git", args, {
      env: {
        HOME: "/tmp",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NODE_ENV: "test",
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectGit);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolveGit(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      rejectGit(
        new Error(
          `Git readiness assertion failed: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "linux")(
  "application-live readiness provisioner",
  () => {
    it("provisions a private exact Git boundary and reports only the unread provider key", async () => {
      const boundary = await temporaryBoundary();
      const providerSentinel = "dry-run-provider-secret-must-not-be-read";
      const result = await runReadiness(
        readinessArguments(boundary.runtimeRoot, boundary.evidenceFile),
        {
          OPENAI_API_KEY: providerSentinel,
          CODEX_API_KEY: "dry-run-codex-secret-must-not-be-read",
        },
      );

      expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
      expect(await readFile(boundary.evidenceFile, "utf8")).toBe(result.stdout);
      const evidence = parseEvidence(result.stdout);
      expect(evidence).toMatchObject({
        schema: "odeu.application-live-readiness-evidence",
        status: "ready_except_provider_credential",
        mode: "dry-run",
        authority: {
          class: "readiness_only",
          providerCapableReadinessAuthorized: false,
          providerCallAuthorized: false,
          applicationRunAuthorized: false,
          closureEligible: false,
          candidateEligible: false,
          reconciliationEligible: false,
          promotionEligible: false,
        },
        provider: {
          credentialObservation: "intentionally_not_read",
          missingConfiguration: ["OPENAI_API_KEY"],
          callExecuted: false,
          browserJourneyExecuted: false,
        },
        runtime: {
          root: "private_path_redacted",
          providerCredentialPersisted: false,
          ledgerPublication: {
            initialState: "awaiting_exact_browser_ledger",
            replacementBoundary:
              "existing_live_authorization_request_publishes_exact_browser_ledger",
            additionalOperatorInputRequired: false,
          },
        },
        dependencies: {
          nodeVersion: expect.stringMatching(/^v24\./u),
          npmVersion: "11.9.0",
          productionDependencyVersions: expect.objectContaining({
            "@openai/codex-sdk": "0.144.5",
            next: "16.2.10",
            openai: "6.47.0",
          }),
          openaiRuntimeEntryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          codexNativeExecutableDigest: expect.stringMatching(
            /^sha256:[a-f0-9]{64}$/u,
          ),
          nextNativeRuntimeDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          importSmokeDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          codexCliVersion: "0.144.5",
        },
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
      });

      const serializedEvidence = JSON.stringify(evidence);
      expect(serializedEvidence).not.toContain(boundary.root);
      expect(serializedEvidence).not.toContain(providerSentinel);
      expect(fileMode((await stat(boundary.runtimeRoot)).mode)).toBe(0o700);
      expect(fileMode((await stat(boundary.evidenceFile)).mode)).toBe(0o600);
      for (const directory of [
        "authority",
        "candidate-store",
        "codex-home",
        "promotion-status",
        "repository.git",
        "workspace",
      ]) {
        expect(
          fileMode((await stat(join(boundary.runtimeRoot, directory))).mode),
        ).toBe(0o700);
      }

      const environment = await readFile(
        join(boundary.runtimeRoot, "application-live.env"),
        "utf8",
      );
      expect(environment).toContain("export ODEU_MANAGER_MODE='live'");
      expect(environment).toContain("export ODEU_CODEX_MODE='live'");
      expect(environment).not.toMatch(
        /^export (?:OPENAI_API_KEY|CODEX_API_KEY)=/mu,
      );
      for (const secretKey of [
        "ODEU_OPERATOR_BEARER_SECRET",
        "ODEU_CODEX_AUTH_SECRET",
        "ODEU_CODEX_ARTIFACT_SIGNING_SECRET",
      ]) {
        expect(serializedEvidence).not.toContain(
          exportedValue(environment, secretKey),
        );
      }
      expect(
        JSON.parse(
          await readFile(
            join(boundary.runtimeRoot, "authority", "ledger.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        kind: "odeu.application-live-ledger-publication-slot",
        status: "awaiting_exact_browser_ledger",
      });

      const repository = join(boundary.runtimeRoot, "repository.git");
      const workspace = join(boundary.runtimeRoot, "workspace");
      const head = await git(["-C", workspace, "rev-parse", "HEAD"]);
      expect(await git(["-C", repository, "rev-parse", "refs/heads/main"])).toBe(
        head,
      );
      expect(await git(["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(
        "HEAD",
      );
      expect(
        await git([
          "-C",
          workspace,
          "status",
          "--ignored",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
      ).toBe("");
    }, 15_000);

    it(
      "creates the same deterministic base in independent private runtimes",
      async () => {
        const first = await temporaryBoundary();
        const second = await temporaryBoundary();
        const firstResult = await runReadiness(
          readinessArguments(first.runtimeRoot, first.evidenceFile),
        );
        const secondResult = await runReadiness(
          readinessArguments(second.runtimeRoot, second.evidenceFile),
        );

        expect(firstResult.exitCode).toBe(0);
        expect(secondResult.exitCode).toBe(0);
        const firstEvidence = parseEvidence(firstResult.stdout);
        const secondEvidence = parseEvidence(secondResult.stdout);
        expect({
          baseCommit: secondEvidence.runtime.baseCommit,
          baseTree: secondEvidence.runtime.baseTree,
          seedManifestDigest: secondEvidence.runtime.seedManifestDigest,
        }).toEqual({
          baseCommit: firstEvidence.runtime.baseCommit,
          baseTree: firstEvidence.runtime.baseTree,
          seedManifestDigest: firstEvidence.runtime.seedManifestDigest,
        });
        expect(secondEvidence.runtime.rootDigest).not.toBe(
          firstEvidence.runtime.rootDigest,
        );
      },
      15_000,
    );

    it("refuses to replace either evidence or an existing runtime", async () => {
      const boundary = await temporaryBoundary();
      await writeFile(boundary.evidenceFile, "operator-owned-evidence\n", {
        mode: 0o600,
      });
      const evidenceCollision = await runReadiness(
        readinessArguments(boundary.runtimeRoot, boundary.evidenceFile),
      );

      expect(evidenceCollision).toMatchObject({
        exitCode: 1,
        signal: null,
        stdout: "",
      });
      expect(JSON.parse(evidenceCollision.stderr)).toMatchObject({
        status: "failed",
        code: "evidence_destination_exists",
        providerCallExecuted: false,
      });
      expect(await readFile(boundary.evidenceFile, "utf8")).toBe(
        "operator-owned-evidence\n",
      );
      await expect(lstat(boundary.runtimeRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const successfulEvidence = join(boundary.root, "successful.json");
      const successful = await runReadiness(
        readinessArguments(boundary.runtimeRoot, successfulEvidence),
      );
      expect(successful.exitCode).toBe(0);
      const environmentFile = join(
        boundary.runtimeRoot,
        "application-live.env",
      );
      const originalEnvironment = await readFile(environmentFile, "utf8");
      const secondEvidence = join(boundary.root, "must-not-exist.json");
      const runtimeCollision = await runReadiness(
        readinessArguments(boundary.runtimeRoot, secondEvidence),
      );

      expect(JSON.parse(runtimeCollision.stderr)).toMatchObject({
        status: "failed",
        code: "runtime_root_exists",
        providerCallExecuted: false,
      });
      expect(await readFile(environmentFile, "utf8")).toBe(originalEnvironment);
      await expect(lstat(secondEvidence)).rejects.toMatchObject({ code: "ENOENT" });
    }, 15_000);

    it("fails closed on stale OpenAI runtime metadata and a missing native Codex executable", async () => {
      for (const failure of [
        "stale-openai-runtime",
        "missing-codex-native",
      ] as const) {
        const boundary = await temporaryBoundary();
        const fixtureScript = await dependencyFixture(failure);
        const result = await runReadiness(
          readinessArguments(boundary.runtimeRoot, boundary.evidenceFile),
          {},
          fixtureScript,
        );

        expect(result).toMatchObject({ exitCode: 1, signal: null, stdout: "" });
        expect(JSON.parse(result.stderr)).toMatchObject({
          status: "failed",
          code: "application_dependencies_unavailable",
          message:
            "The exact installed application runtime is unavailable or does not match package-lock.json; run npm ci first.",
          rawPathsIncluded: false,
          providerCallExecuted: false,
        });
        expect(result.stderr).not.toContain(boundary.root);
        await expect(lstat(boundary.runtimeRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(lstat(boundary.evidenceFile)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });

    it("rejects repository-local outputs outside the ignored private working root", async () => {
      const unsafeToken = `application-live-readiness-unsafe-${process.pid}-${Date.now()}`;
      for (const unsafeRoot of [
        join(repositoryRoot, unsafeToken),
        join(repositoryRoot, ".git", unsafeToken),
      ]) {
        const boundary = await temporaryBoundary();
        const result = await runReadiness(
          readinessArguments(unsafeRoot, boundary.evidenceFile),
        );

        expect(result).toMatchObject({ exitCode: 1, signal: null, stdout: "" });
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: "runtime_location_invalid",
          rawPathsIncluded: false,
          providerCallExecuted: false,
        });
        expect(result.stderr).not.toContain(unsafeToken);
        await expect(lstat(unsafeRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(boundary.evidenceFile)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });

    it(
      "does not echo native filesystem failures in public failure output",
      async () => {
        const boundary = await temporaryBoundary();
        const privateSentinel = `application-live-native-error-${process.pid}-${Date.now()}`;
        const privatePath = join("/tmp", privateSentinel, "missing-runtime");
        const fixtureScript = await unexpectedFailureFixture(privatePath);
        const result = await runReadiness(
          readinessArguments(boundary.runtimeRoot, boundary.evidenceFile),
          {},
          fixtureScript,
        );

        expect(result).toMatchObject({ exitCode: 1, signal: null, stdout: "" });
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: "unexpected_failure",
          message:
            "Application-live readiness failed before redacted evidence could be published.",
          rawSecretsIncluded: false,
          rawPathsIncluded: false,
          providerCallExecuted: false,
        });
        expect(result.stderr).not.toContain(privateSentinel);
        expect(result.stderr).not.toContain(privatePath);
        await expect(lstat(boundary.runtimeRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(lstat(boundary.evidenceFile)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      15_000,
    );

    it("requires explicit provider gates and never executes the provider journey", async () => {
      const boundary = await temporaryBoundary();
      const args = [
        "--mode",
        "provider-capable",
        ...readinessArguments(boundary.runtimeRoot, boundary.evidenceFile),
      ];
      const providerSentinel = "provider-capable-key-must-remain-redacted";

      const noOptIn = await runReadiness(args, {
        OPENAI_API_KEY: providerSentinel,
      });
      expect(noOptIn.exitCode).toBe(2);
      expect(JSON.parse(noOptIn.stderr)).toMatchObject({
        code: "provider_capable_opt_in_missing",
        providerCallExecuted: false,
      });

      const noCredential = await runReadiness([
        "--allow-provider-capable-readiness",
        ...args,
      ]);
      expect(noCredential.exitCode).toBe(1);
      expect(JSON.parse(noCredential.stderr)).toMatchObject({
        code: "provider_credential_missing",
        providerCallExecuted: false,
      });

      const noCiOptIn = await runReadiness(
        ["--allow-provider-capable-readiness", ...args],
        { CI: "true", OPENAI_API_KEY: providerSentinel },
      );
      expect(noCiOptIn.exitCode).toBe(2);
      expect(JSON.parse(noCiOptIn.stderr)).toMatchObject({
        code: "ci_provider_capable_opt_in_missing",
        providerCallExecuted: false,
      });

      const ready = await runReadiness(
        [
          "--allow-provider-capable-readiness",
          "--allow-ci-provider-capable-readiness",
          ...args,
        ],
        {
          CI: "true",
          OPENAI_API_KEY: providerSentinel,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        },
      );
      expect(ready).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
      const evidence = parseEvidence(ready.stdout);
      expect(evidence).toMatchObject({
        status: "ready_for_manual_provider_journey",
        mode: "provider-capable",
        authority: {
          providerCapableReadinessAuthorized: true,
          providerCallAuthorized: false,
          applicationRunAuthorized: false,
        },
        provider: {
          credentialObservation: "configured_redacted",
          missingConfiguration: [],
          callExecuted: false,
          browserJourneyExecuted: false,
        },
      });
      expect(JSON.stringify(evidence)).not.toContain(providerSentinel);
      expect(
        await readFile(join(boundary.runtimeRoot, "application-live.env"), "utf8"),
      ).not.toContain(providerSentinel);
    }, 15_000);
  },
);
