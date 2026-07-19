import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  ArtifactCandidateReceiptSchema,
  type ArtifactCandidateMetadata,
  type ArtifactCandidateReceipt,
} from "@/adapters/artifact-promotion/schema";
import { artifactCandidateId } from "@/adapters/artifact-promotion/server";

import {
  LIVE_EVIDENCE_ARTIFACT_PATH,
  LIVE_EVIDENCE_SUPPORT_PATH,
  LIVE_EVIDENCE_TEST_COMMAND,
  LiveEvidenceRequestSchema,
  type LiveEvidenceRequest,
} from "./schema";
import { canonicalArtifactCandidateMetadata } from "./server";

const execFileAsync = promisify(execFile);

export const TEST_LIVE_EVIDENCE_KEY_ID = "live-evidence-test-key";
export const TEST_LIVE_EVIDENCE_SECRET =
  "test-only-live-evidence-secret-with-sufficient-entropy";

export const TEST_LIVE_MOVING_COST_SUPPORT_SOURCE = [
  "export function movingCostCents(value) {",
  "  return Math.round((Number(value) + Number.EPSILON) * 100);",
  "}",
  "",
  "export function calculateMovingTotalCents(quote) {",
  "  return movingCostCents(quote.base) + movingCostCents(quote.distance) + movingCostCents(quote.fees);",
  "}",
  "",
].join("\n");

export const TEST_LIVE_MOVING_COST_ARTIFACT = [
  "<!doctype html>",
  '<form id="quotes">',
  '  <fieldset class="quote">',
  '    <input name="base" value="900">',
  '    <input name="distance" value="120">',
  '    <input name="fees" value="80">',
  "  </fieldset>",
  '  <fieldset class="quote">',
  '    <input name="base" value="840.25">',
  '    <input name="distance" value="190.4">',
  '    <input name="fees" value="40.35">',
  "  </fieldset>",
  '  <button type="submit">Compare totals</button>',
  "</form>",
  '<output id="result"></output>',
  '<script type="module">',
  "  import { calculateMovingTotalCents } from './moving-costs.mjs';",
  "  globalThis.calculateMovingTotalCents = calculateMovingTotalCents;",
  "</script>",
  "",
].join("\n");

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

async function git(repositoryPath: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

async function gitBuffer(
  repositoryPath: string,
  args: readonly string[],
): Promise<Buffer> {
  const result = await execFileAsync("/usr/bin/git", ["-C", repositoryPath, ...args], {
    encoding: "buffer",
    maxBuffer: 32 * 1_024 * 1_024,
  });
  return result.stdout;
}

async function treeEntry(
  repositoryPath: string,
  revision: string,
  path: string,
): Promise<{ readonly mode: "100644" | "100755"; readonly blob: string } | null> {
  const raw = await gitBuffer(repositoryPath, [
    "ls-tree",
    "-z",
    revision,
    "--",
    path,
  ]);
  if (raw.byteLength === 0) return null;
  const match = raw.toString("utf8").match(
    /^(100644|100755) blob ([0-9a-f]+)\t[^\0]+\0$/u,
  );
  if (!match) throw new Error(`Unexpected fixture tree entry for ${path}.`);
  return { mode: match[1] as "100644" | "100755", blob: match[2]! };
}

export function signCandidateMetadata(
  metadata: ArtifactCandidateMetadata,
  secret = TEST_LIVE_EVIDENCE_SECRET,
): ArtifactCandidateReceipt {
  return ArtifactCandidateReceiptSchema.parse({
    metadata,
    signature: {
      algorithm: "hmac-sha256",
      keyId: TEST_LIVE_EVIDENCE_KEY_ID,
      digest: `hmac-sha256:${createHmac("sha256", secret)
        .update(canonicalArtifactCandidateMetadata(metadata), "utf8")
        .digest("hex")}`,
    },
  });
}

export type LiveEvidenceGitFixture = {
  readonly repositoryPath: string;
  readonly request: LiveEvidenceRequest;
  readonly receipt: ArtifactCandidateReceipt;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly cleanup: () => Promise<void>;
};

export async function createLiveEvidenceGitFixture(input: {
  readonly changeDeclaredArtifact?: boolean;
  readonly candidatePackageTestScript?: string;
  readonly supportModuleSource?: string;
} = {}): Promise<LiveEvidenceGitFixture> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "odeu-live-evidence-repo-"));
  const changeDeclaredArtifact = input.changeDeclaredArtifact ?? true;
  await git(repositoryPath, ["init", "--initial-branch=main"]);
  await git(repositoryPath, ["config", "user.name", "ODEU verifier test"]);
  await git(repositoryPath, ["config", "user.email", "verifier@example.invalid"]);
  await mkdir(join(repositoryPath, "demo"), { recursive: true });
  await writeFile(
    join(repositoryPath, "package.json"),
    `${JSON.stringify(
      {
        name: "live-evidence-candidate-fixture",
        private: true,
        scripts: { test: "node moving-cost-test.cjs" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(repositoryPath, "moving-cost-test.cjs"),
    [
      'const { readFileSync } = require("node:fs");',
      'const artifact = readFileSync("demo/moving-costs.html", "utf8");',
      'if (!artifact.includes("data-moving-cost-ready=\\"true\\"")) {',
      '  console.error("moving-cost candidate marker missing");',
      "  process.exit(1);",
      "}",
      'console.log("moving-cost candidate verified");',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repositoryPath, LIVE_EVIDENCE_ARTIFACT_PATH),
    "<!doctype html><title>Moving costs</title>\n",
  );
  await writeFile(join(repositoryPath, "README.md"), "base\n");
  await git(repositoryPath, ["add", "--all"]);
  await git(repositoryPath, ["commit", "--message", "base candidate fixture"]);
  const baseCommit = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const baseTree = await git(repositoryPath, ["rev-parse", "HEAD^{tree}"]);

  await git(repositoryPath, ["switch", "--create", "candidate"]);
  const changedPaths: string[] = [];
  if (changeDeclaredArtifact) {
    await writeFile(
      join(repositoryPath, LIVE_EVIDENCE_ARTIFACT_PATH),
      TEST_LIVE_MOVING_COST_ARTIFACT,
    );
    await writeFile(
      join(repositoryPath, LIVE_EVIDENCE_SUPPORT_PATH),
      input.supportModuleSource ?? TEST_LIVE_MOVING_COST_SUPPORT_SOURCE,
    );
    changedPaths.push(LIVE_EVIDENCE_ARTIFACT_PATH, LIVE_EVIDENCE_SUPPORT_PATH);
  } else {
    await writeFile(
      join(repositoryPath, LIVE_EVIDENCE_SUPPORT_PATH),
      input.supportModuleSource ?? TEST_LIVE_MOVING_COST_SUPPORT_SOURCE,
    );
    changedPaths.push(LIVE_EVIDENCE_SUPPORT_PATH);
  }
  if (input.candidatePackageTestScript !== undefined) {
    await writeFile(
      join(repositoryPath, "package.json"),
      `${JSON.stringify(
        {
          name: "live-evidence-candidate-fixture",
          private: true,
          scripts: { test: input.candidatePackageTestScript },
        },
        null,
        2,
      )}\n`,
    );
    changedPaths.push("package.json");
  }
  await git(repositoryPath, ["add", "--all"]);
  await git(repositoryPath, ["commit", "--message", "sealed candidate"]);
  const candidateCommit = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const candidateTree = await git(repositoryPath, ["rev-parse", "HEAD^{tree}"]);
  await git(repositoryPath, ["update-ref", "refs/heads/main", baseCommit]);

  const entries = (
    await Promise.all(
      [...new Set(changedPaths)].map(async (path) => {
        const [oldEntry, newEntry] = await Promise.all([
          treeEntry(repositoryPath, baseCommit, path),
          treeEntry(repositoryPath, candidateCommit, path),
        ]);
        if (!newEntry) throw new Error(`Fixture candidate deleted ${path}.`);
        return {
          path,
          status: oldEntry ? ("modified" as const) : ("added" as const),
          oldMode: oldEntry?.mode ?? null,
          newMode: newEntry.mode,
          oldBlob: oldEntry?.blob ?? null,
          newBlob: newEntry.blob,
        };
      }),
    )
  ).sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
  const patch = await gitBuffer(repositoryPath, [
    "diff",
    "--binary",
    "--full-index",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    baseCommit,
    candidateTree,
    "--",
  ]);
  const metadataMaterial = {
    kind: "odeu.git-artifact-candidate",
    version: 1,
    repositoryId: "home-move-test-repository",
    targetRef: "refs/heads/main",
    runId: "run-live-evidence-test",
    briefId: "brief-live-evidence-test",
    baseRevisionId: "revision-live-evidence-test",
    sealedAt: "2026-07-18T12:00:00.000Z",
    git: {
      objectFormat: "sha1",
      baseCommit,
      baseTree,
      candidateCommit,
      candidateTree,
    },
    patch: {
      format: "git-binary-diff-v1",
      digest: sha256(patch),
      byteLength: patch.byteLength,
    },
    manifest: {
      digest: sha256(canonicalJson(entries)),
      entries,
    },
  } as const;
  const candidateId = artifactCandidateId(metadataMaterial);
  const candidateRef = `refs/odeu/candidates/${candidateId.slice("artifact-candidate:sha256:".length)}`;
  await git(repositoryPath, ["update-ref", candidateRef, candidateCommit]);
  const metadata: ArtifactCandidateMetadata = {
    ...metadataMaterial,
    candidateId,
    candidateRef,
  };
  const receipt = signCandidateMetadata(metadata);
  const request = LiveEvidenceRequestSchema.parse({
    mode: "live",
    validationRequestId: "request-live-evidence-test",
    validationId: "validation-live-evidence-test",
    closureId: "closure-live-evidence-test",
    runId: metadata.runId,
    briefId: metadata.briefId,
    baseRevisionId: metadata.baseRevisionId,
    artifactBaseRef: `git:${baseCommit}`,
    exchangeSourceId: "source-codex-exchange:request-live-evidence-test",
    artifactCandidateId: metadata.candidateId,
    artifactCandidateCommit: candidateCommit,
    evidenceRequirements: [
      {
        requirementId: "requirement-focused-tests",
        label: "Focused moving-cost calculation tests pass",
        kind: "test",
        command: LIVE_EVIDENCE_TEST_COMMAND,
        required: true,
      },
      {
        requirementId: "requirement-artifact-change",
        label: "The planning-page artifact change is addressable",
        kind: "artifact",
        command: null,
        required: true,
      },
    ],
    expectedArtifacts: [LIVE_EVIDENCE_ARTIFACT_PATH],
    candidateReceipt: receipt,
  });
  return {
    repositoryPath,
    request,
    receipt,
    baseCommit,
    candidateCommit,
    cleanup: () => rm(repositoryPath, { recursive: true, force: true }),
  };
}
