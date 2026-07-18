import "server-only";

/**
 * Immutable server-owned verifier program. The live adapter materializes these
 * exact bytes in a private temporary directory and mounts them read-only into
 * the sandbox. Candidate files, package metadata, and browser input cannot
 * select or modify this program.
 */
export const LIVE_EVIDENCE_HARNESS_FILE_NAME =
  "moving-cost-contract-harness-v1.mjs";

export const LIVE_EVIDENCE_HARNESS_SOURCE = String.raw`import { readFile } from "node:fs/promises";
import vm from "node:vm";

const ARTIFACT_PATH = "/candidate/demo/moving-costs.html";
const SUPPORT_PATH = "/candidate/demo/moving-costs.mjs";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_SUPPORT_BYTES = 128 * 1024;
const MAX_PUBLIC_ERROR_CHARS = 1_024;
const VM_TIMEOUT_MS = 750;
const VECTORS = Object.freeze([
  Object.freeze({
    caseId: "two-ordinary-quotes",
    input: Object.freeze({ base: 900, distance: 120, fees: 80 }),
    expectedTotalCents: 110_000,
  }),
  Object.freeze({
    caseId: "decimal-components",
    input: Object.freeze({ base: 840.25, distance: 190.4, fees: 40.35 }),
    expectedTotalCents: 107_100,
  }),
  Object.freeze({
    caseId: "zero-fees",
    input: Object.freeze({ base: 1_100, distance: 0, fees: 0 }),
    expectedTotalCents: 110_000,
  }),
]);

function boundedMessage(error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "The candidate contract was rejected.";
  return message
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .slice(0, MAX_PUBLIC_ERROR_CHARS);
}

async function boundedUtf8(path, maximumBytes, label) {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(label + " is empty or exceeds its immutable harness bound.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function countMatches(value, pattern) {
  return Array.from(value.matchAll(pattern)).length;
}

function assertArtifactContract(html) {
  if (
    countMatches(html, /class\s*=\s*["'][^"']*\bquote\b[^"']*["']/giu) < 2 ||
    countMatches(html, /name\s*=\s*["']base["']/giu) < 2 ||
    countMatches(html, /name\s*=\s*["']distance["']/giu) < 2 ||
    countMatches(html, /name\s*=\s*["']fees["']/giu) < 2 ||
    !/<form\b/iu.test(html) ||
    !/<output\b/iu.test(html)
  ) {
    throw new Error(
      "The candidate HTML does not expose two bounded moving-quote inputs and a comparison result.",
    );
  }
  const supportImports = Array.from(
    html.matchAll(
      /import\s*\{\s*calculateMovingTotalCents\s*\}\s*from\s*["']\.\/moving-costs\.mjs["']/giu,
    ),
  );
  if (supportImports.length !== 1) {
    throw new Error(
      "The candidate HTML must import the one registered moving-cost calculator exactly once.",
    );
  }
}

async function loadCalculator(source) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "odeu-moving-cost-candidate-contract",
    codeGeneration: { strings: false, wasm: false },
  });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: "odeu-candidate:moving-costs.mjs",
    importModuleDynamically: async () => {
      throw new Error("Candidate dynamic imports are not permitted.");
    },
  });
  await module.link(async () => {
    throw new Error("Candidate module dependencies are not permitted.");
  });
  await module.evaluate({ timeout: VM_TIMEOUT_MS, breakOnSigint: true });
  const calculate = module.namespace.calculateMovingTotalCents;
  if (typeof calculate !== "function") {
    throw new Error(
      "The exact candidate module does not export calculateMovingTotalCents.",
    );
  }
  sandbox.__odeuCalculate = calculate;
  return { context, sandbox };
}

async function main() {
  if (
    process.argv.length !== 6 ||
    process.argv[2] !== ARTIFACT_PATH ||
    process.argv[3] !== SUPPORT_PATH ||
    !/^[0-9a-f]{64}$/u.test(process.argv[4]) ||
    !/^sha256:[0-9a-f]{64}$/u.test(process.argv[5])
  ) {
    throw new Error("The immutable harness received an unexpected candidate binding.");
  }
  const reportNonce = process.argv[4];
  const harnessDigest = process.argv[5];
  process.stderr.write(
    "odeu-host-harness-started:" + reportNonce + "\n",
  );
  const [html, support] = await Promise.all([
    boundedUtf8(ARTIFACT_PATH, MAX_ARTIFACT_BYTES, "The candidate HTML"),
    boundedUtf8(SUPPORT_PATH, MAX_SUPPORT_BYTES, "The candidate support module"),
  ]);
  assertArtifactContract(html);
  const { context, sandbox } = await loadCalculator(support);
  const invoke = new vm.Script("__odeuCalculate(__odeuInput)", {
    filename: "odeu-moving-cost-vector.vm.js",
  });
  const cases = [];
  for (const vector of VECTORS) {
    sandbox.__odeuInput = Object.freeze({ ...vector.input });
    const observed = invoke.runInContext(context, {
      timeout: VM_TIMEOUT_MS,
      breakOnSigint: true,
    });
    delete sandbox.__odeuInput;
    if (observed !== vector.expectedTotalCents) {
      throw new Error(
        "Registered vector " + vector.caseId + " returned an unexpected total.",
      );
    }
    cases.push({
      caseId: vector.caseId,
      observedTotalCents: observed,
      expectedTotalCents: vector.expectedTotalCents,
      result: "passed",
    });
  }
  process.stdout.write(
    JSON.stringify({
      kind: "odeu.moving-cost-host-harness-report",
      version: 1,
      nonce: reportNonce,
      harnessDigest,
      passed: true,
      cases,
      detail:
        "moving-cost immutable host harness verified " +
        VECTORS.length +
        " fixed vectors",
    }) + "\n",
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    "moving-cost immutable host harness rejected candidate: " +
      boundedMessage(error) +
      "\n",
  );
  process.exitCode = 1;
}
`;
