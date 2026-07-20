import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { HOME_MOVE_REPLAY_IDENTITY } from "../../src/adapters/replay-evidence/bundle";
import {
  expectLayoutConformance,
  expectLayoutConformanceAtWidths,
  RESPONSIVE_LAYOUT_WIDTHS,
} from "./layout-conformance";

const SOURCE =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";

async function openWorkbench(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(
    page.locator("[data-morphic-root='worldstate-workbench']"),
  ).toHaveAttribute("data-worldstate-revision", /.+/);
}

async function reopenWorkbench(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(
    page.locator("[data-morphic-root='worldstate-workbench']"),
  ).toHaveAttribute("data-worldstate-revision", /.+/);
}

async function persistedLedgerEventCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const openRequest = indexedDB.open("odeu-worldstate");
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          const transaction = database.transaction("project-ledgers", "readonly");
          const getRequest = transaction.objectStore("project-ledgers").get("project-home-move");
          getRequest.onerror = () => reject(getRequest.error);
          getRequest.onsuccess = () => {
            const document = getRequest.result as { events?: unknown[] } | undefined;
            database.close();
            resolve(document?.events?.length ?? 0);
          };
        };
      }),
  );
}

async function persistedLedgerEventTypeCount(
  page: Page,
  eventType: string,
): Promise<number> {
  return page.evaluate(
    ({ type }) =>
      new Promise<number>((resolve, reject) => {
        const openRequest = indexedDB.open("odeu-worldstate");
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          const transaction = database.transaction(
            "project-ledgers",
            "readonly",
          );
          const getRequest = transaction
            .objectStore("project-ledgers")
            .get("project-home-move");
          getRequest.onerror = () => reject(getRequest.error);
          getRequest.onsuccess = () => {
            const document = getRequest.result as
              | { events?: Array<{ type?: string }> }
              | undefined;
            database.close();
            resolve(
              document?.events?.filter((event) => event.type === type).length ??
                0,
            );
          };
        };
      }),
    { type: eventType },
  );
}

test("persists capture and placement before one semantic commit, then reloads exactly", async ({
  page,
}) => {
  await openWorkbench(page);
  const root = page.locator("[data-morphic-root='worldstate-workbench']");
  const capture = page.getByRole("button", { name: "Capture & place" });
  await expect(capture).toBeVisible();

  const initialRevision = await root.getAttribute("data-worldstate-revision");
  await capture.click();

  const accept = page.getByRole("button", { name: "Adopt this placement" });
  await expect(accept).toBeEnabled();
  await expect(root).toHaveAttribute("data-worldstate-revision", initialRevision as string);
  await expect(page.getByText(SOURCE, { exact: false })).toBeVisible();
  await expect(page.getByText("Suggested · canonical unchanged")).toBeVisible();
  await expect(
    page.getByText(/Adopt a placement before preparing a bounded agent brief/i),
  ).toBeVisible();

  await accept.click();
  await expect(page.getByRole("button", { name: "Placement adopted" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Prepare agent brief" })).toBeEnabled();
  const adoptedRevision = await root.getAttribute("data-worldstate-revision");
  const adoptedSelectedObject = await root.getAttribute("data-selected-object-id");
  const adoptedExchangeReceipt = await page
    .locator("[data-evidence-anchor='placement-exchange'] small")
    .textContent();
  expect(adoptedRevision).not.toBe(initialRevision);
  expect(adoptedSelectedObject).toBeTruthy();
  expect(adoptedExchangeReceipt).toMatch(
    /^source-placement-exchange:.* · receipt receipt-/,
  );

  await reopenWorkbench(page);
  await expect(page.getByRole("button", { name: "Placement adopted" })).toBeDisabled();
  await expect(root).toHaveAttribute("data-worldstate-revision", adoptedRevision as string);
  await expect(root).toHaveAttribute(
    "data-selected-object-id",
    adoptedSelectedObject as string,
  );
  await expect(
    page.locator("[data-evidence-anchor='placement-exchange'] small"),
  ).toHaveText(adoptedExchangeReceipt as string);
  await expect(page.getByText(SOURCE, { exact: false })).toBeVisible();
  await expect(
    page
      .locator("[data-morphic-lane='runtime-truth']")
      .getByText("Deterministic fixture manager", { exact: true }),
  ).toBeVisible();
});

test("stages, validates, reconciles, and explicitly integrates one replay result", async ({
  page,
}) => {
  test.slow();
  await openWorkbench(page);
  const root = page.locator("[data-morphic-root='worldstate-workbench']");
  await page.getByRole("button", { name: "Capture & place" }).click();
  await page.getByRole("button", { name: "Adopt this placement" }).click();
  await expect(
    page.getByRole("button", { name: "Placement adopted" }),
  ).toBeDisabled();
  const revisionBeforeDelegation = await root.getAttribute(
    "data-worldstate-revision",
  );

  await page.getByRole("button", { name: "Prepare agent brief" }).click();

  await expect(page.getByRole("button", { name: "Brief prepared" })).toBeDisabled();
  await expect(page.getByText("Shared with agent · 5")).toBeVisible();
  await expect(page.getByText(/Kept private \/ out of scope/i)).toBeVisible();
  await expect(page.getByText("npm test -- moving-cost")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Authorize fixture replay" }),
  ).toBeEnabled();
  await expect(root).toHaveAttribute(
    "data-worldstate-revision",
    revisionBeforeDelegation as string,
  );
  await expectLayoutConformanceAtWidths(
    page,
    root,
    RESPONSIVE_LAYOUT_WIDTHS,
    "prepared brief",
  );

  await page.getByRole("button", { name: "Authorize fixture replay" }).click();

  await expect(
    page.getByText(`Fixture replay · ${HOME_MOVE_REPLAY_IDENTITY}`),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lifecycle · returned" })).toBeVisible();
  await expect(page.getByText("Staged closure witness")).toBeVisible();
  await expect(
    page.getByText(/Returned is not verified\. Claims and observations remain separate/i),
  ).toBeVisible();
  await expect(
    page.getByText("No reconciliation candidate is projected"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Prepare reconciliation proposal" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Integrate reviewed result" }),
  ).toBeDisabled();
  await expect(root).toHaveAttribute(
    "data-worldstate-revision",
    revisionBeforeDelegation as string,
  );
  await expectLayoutConformanceAtWidths(
    page,
    root,
    RESPONSIVE_LAYOUT_WIDTHS,
    "returned fixture replay",
  );
  const replayEventCount = await persistedLedgerEventCount(page);
  const validate = page.getByRole("button", {
    name: "Run independent validation",
  });
  await expect(validate).toBeEnabled();
  await validate.click();
  await expect(
    page.getByRole("button", { name: "Evidence validation recorded" }),
  ).toBeDisabled();
  await expect(
    page
      .locator("[data-validation-verdict='verified']")
      .getByText("Required evidence verified"),
  ).toBeVisible();
  await expect(
    page.locator(
      "[data-evidence-anchor='independent-observations'] [data-observation-result='passed']",
    ),
  ).toHaveCount(2);
  await expect(
    page.locator(
      "[data-execution-kind='fixture_equivalent'][data-declared-command-executed='false']",
    ),
  ).toContainText("Declared command not executed · 3/3 registered cases passed");
  const evidenceTopology = await root.evaluate((workbench) => {
    const claims = workbench.querySelector(
      "[data-evidence-anchor='worker-claims']",
    );
    const validation = workbench.querySelector(
      "[data-morphic-lane='independent-validation']",
    );
    const reconciliation = workbench.querySelector(
      "[data-morphic-lane='reconciliation-boundary']",
    );
    return {
      allInsideRoot: Boolean(claims && validation && reconciliation),
      claimsBeforeValidation: Boolean(
        claims &&
          validation &&
          claims.compareDocumentPosition(validation) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      validationBeforeReconciliation: Boolean(
        validation &&
          reconciliation &&
          validation.compareDocumentPosition(reconciliation) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    };
  });
  expect(evidenceTopology).toEqual({
    allInsideRoot: true,
    claimsBeforeValidation: true,
    validationBeforeReconciliation: true,
  });
  const validationOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(validationOverflow).toBeLessThanOrEqual(1);
  const validationAccessibility = await new AxeBuilder({ page })
    .include("[data-morphic-root='worldstate-workbench']")
    .analyze();
  expect(validationAccessibility.violations).toEqual([]);
  await expect(root).toHaveAttribute(
    "data-worldstate-revision",
    revisionBeforeDelegation as string,
  );
  expect(await persistedLedgerEventCount(page)).toBe(replayEventCount + 3);
  expect(
    await persistedLedgerEventTypeCount(page, "evidence.validation_recorded"),
  ).toBe(1);
  await expectLayoutConformanceAtWidths(
    page,
    root,
    RESPONSIVE_LAYOUT_WIDTHS,
    "independent validation",
  );
  const validatedEventCount = await persistedLedgerEventCount(page);
  const proposalCountBeforeReconciliation =
    await persistedLedgerEventTypeCount(page, "delta.proposed");
  const acceptanceCountBeforeIntegration =
    await persistedLedgerEventTypeCount(page, "delta.accepted");

  const prepareReconciliation = page.getByRole("button", {
    name: "Prepare reconciliation proposal",
  });
  await expect(prepareReconciliation).toBeEnabled();
  await prepareReconciliation.click();

  await expect(
    page.getByRole("button", { name: "Candidate prepared" }),
  ).toBeDisabled();
  const candidateLane = page.locator(
    "[data-morphic-lane='reconciliation-boundary']",
  );
  const integrationLane = page.locator(
    "[data-morphic-lane='integration-boundary']",
  );
  await expect(candidateLane).toHaveAttribute("data-state", "candidate");
  await expect(candidateLane).toHaveAttribute(
    "data-reconciliation-disposition",
    "pending",
  );
  await expect(
    candidateLane.getByText(
      "Work · Planned / Unverified → Completed / Verified",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    candidateLane.getByText(
      "Semantic integration only · artifact promotion not performed",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(candidateLane).toContainText(
    /does not establish live execution, causal repository authorship, deployment, or file promotion/i,
  );
  await expect(
    candidateLane.locator("[data-evidence-anchor='integration-gate-evidence']"),
  ).toHaveAttribute("data-integration-verified", "true");
  await expect(integrationLane).toHaveAttribute("data-gate-state", "ready");
  await expect(
    page.getByRole("button", { name: "Integrate reviewed result" }),
  ).toBeEnabled();
  await expect(root).toHaveAttribute(
    "data-worldstate-revision",
    revisionBeforeDelegation as string,
  );
  expect(await persistedLedgerEventCount(page)).toBe(validatedEventCount + 2);
  expect(await persistedLedgerEventTypeCount(page, "delta.proposed")).toBe(
    proposalCountBeforeReconciliation + 1,
  );
  await expectLayoutConformanceAtWidths(
    page,
    root,
    RESPONSIVE_LAYOUT_WIDTHS,
    "reconciliation candidate",
  );
  const proposedEventCount = await persistedLedgerEventCount(page);

  const integrationTopology = await root.evaluate((workbench) => {
    const validation = workbench.querySelector(
      "[data-morphic-lane='independent-validation']",
    );
    const candidate = workbench.querySelector(
      "[data-morphic-lane='reconciliation-boundary']",
    );
    const integration = workbench.querySelector(
      "[data-morphic-lane='integration-boundary']",
    );
    return {
      allInsideRoot: Boolean(validation && candidate && integration),
      validationBeforeCandidate: Boolean(
        validation &&
          candidate &&
          validation.compareDocumentPosition(candidate) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      candidateBeforeIntegration: Boolean(
        candidate &&
          integration &&
          candidate.compareDocumentPosition(integration) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    };
  });
  expect(integrationTopology).toEqual({
    allInsideRoot: true,
    validationBeforeCandidate: true,
    candidateBeforeIntegration: true,
  });

  await page.getByRole("button", { name: "Integrate reviewed result" }).click();
  await expect(
    page.getByRole("button", { name: "Result integrated", exact: true }),
  ).toBeDisabled();
  const integratedRevision = await root.getAttribute(
    "data-worldstate-revision",
  );
  expect(integratedRevision).toBeTruthy();
  expect(integratedRevision).not.toBe(revisionBeforeDelegation);
  await expect(candidateLane).toHaveAttribute("data-state", "integrated");
  await expect(candidateLane).toHaveAttribute(
    "data-reconciliation-disposition",
    "accepted",
  );
  await expect(candidateLane).toHaveAttribute(
    "data-state-surface",
    "authoritative-status-surface",
  );
  await expect(integrationLane).toHaveAttribute("data-gate-state", "satisfied");
  await expect(
    page.locator("[data-validation-verdict='verified']"),
  ).toContainText(/consumed by/i);
  await expect(
    page.getByRole("heading", { name: "Lifecycle · returned" }),
  ).toBeVisible();
  expect(await persistedLedgerEventCount(page)).toBe(proposedEventCount + 1);
  expect(await persistedLedgerEventTypeCount(page, "delta.accepted")).toBe(
    acceptanceCountBeforeIntegration + 1,
  );
  await expectLayoutConformanceAtWidths(
    page,
    root,
    RESPONSIVE_LAYOUT_WIDTHS,
    "integrated result",
  );
  const integratedEventCount = await persistedLedgerEventCount(page);

  for (const view of ["Outline", "Map", "Timeline", "Focus"]) {
    await page.getByRole("tab", { name: new RegExp(view, "i") }).click();
    await expect(root).toHaveAttribute("data-view", view.toLowerCase());
    await expect(root).toHaveAttribute(
      "data-worldstate-revision",
      integratedRevision as string,
    );
    await expect(
      page.getByRole("button", { name: "Result integrated", exact: true }),
    ).toBeDisabled();
    expect(await persistedLedgerEventCount(page)).toBe(integratedEventCount);
  }
  await page.getByRole("tab", { name: /Timeline/i }).click();
  await expect(page.getByText("Reconciliation receipt persisted")).toBeVisible();
  await expect(page.getByText("Result integrated", { exact: true }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    '"kind":"odeu.result-reconciliation"',
  );

  const integrationOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(integrationOverflow).toBeLessThanOrEqual(1);
  const integrationAccessibility = await new AxeBuilder({ page })
    .include("[data-morphic-root='worldstate-workbench']")
    .analyze();
  expect(integrationAccessibility.violations).toEqual([]);

  await reopenWorkbench(page);

  await expect(
    page.getByText(`Fixture replay · ${HOME_MOVE_REPLAY_IDENTITY}`),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lifecycle · returned" })).toBeVisible();
  await expect(
    page
      .locator("[data-validation-verdict='verified']")
      .getByText("Required evidence verified"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Evidence validation recorded" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Result integrated", exact: true }),
  ).toBeDisabled();
  await expect(root).toHaveAttribute(
    "data-worldstate-revision",
    integratedRevision as string,
  );
  await expect(
    page.locator("[data-validation-verdict='verified']"),
  ).toContainText(/consumed by/i);
  expect(await persistedLedgerEventCount(page)).toBe(integratedEventCount);
  expect(
    await persistedLedgerEventTypeCount(page, "evidence.validation_recorded"),
  ).toBe(1);
});

test("shows one dynamic candidate in outline, map, timeline, and focus without ledger writes", async ({
  page,
}) => {
  await openWorkbench(page);
  await page.getByRole("button", { name: "Capture & place" }).click();
  await expect(page.getByRole("button", { name: "Adopt this placement" })).toBeEnabled();

  const root = page.locator("[data-morphic-root='worldstate-workbench']");
  const candidateId = await root.getAttribute("data-selected-object-id");
  const revision = await root.getAttribute("data-worldstate-revision");
  const eventCount = await persistedLedgerEventCount(page);
  expect(candidateId).toBeTruthy();
  expect(eventCount).toBeGreaterThan(0);

  for (const view of ["Outline", "Map", "Timeline", "Focus"]) {
    await page.getByRole("tab", { name: new RegExp(view, "i") }).click();
    await expect(root).toHaveAttribute("data-view", view.toLowerCase());
    await expect(
      page.locator(
        `[data-view='${view.toLowerCase()}'] [data-worldstate-id='${candidateId}']`,
    ).first(),
    ).toBeVisible();
    await expect(root).toHaveAttribute("data-worldstate-revision", revision as string);
    expect(await persistedLedgerEventCount(page)).toBe(eventCount);
  }
});

test("keeps runtime truth and evidence-before-commit conformant across responsive widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  const root = page.locator("[data-morphic-root='worldstate-workbench']");

  await expect(root).toHaveAttribute("data-view", "focus");
  await expect(
    page.locator("[data-morphic-lane='runtime-truth'] [data-runtime-mode]"),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-morphic-lane='runtime-truth']")
      .getByText(/Placement manager not observed yet/i),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /Outline/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Map/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Timeline/i })).toBeVisible();

  const evidenceBeforeCommit = await page.evaluate(() => {
    const evidence = document.querySelector("[data-morphic-region='evidence']");
    const commit = document.querySelector("[data-morphic-region='semantic-commit']");
    return Boolean(
      evidence &&
        commit &&
        evidence.compareDocumentPosition(commit) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(evidenceBeforeCommit).toBe(true);
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  await expectLayoutConformanceAtWidths(
    page,
    root,
    RESPONSIVE_LAYOUT_WIDTHS,
    "idle Workbench",
  );
});

test("requires explicit confirmation and leaves the sandbox reusable after reset", async ({
  page,
}) => {
  await openWorkbench(page);
  await page.getByRole("button", { name: "Capture & place" }).click();
  await expect(page.getByRole("button", { name: "Adopt this placement" })).toBeEnabled();

  await page.getByRole("button", { name: "Reset sandbox" }).click();
  await expect(page.getByRole("button", { name: "Confirm reset" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await expect(page.getByRole("button", { name: "Capture & place" })).toBeVisible();
  await expect(page.getByText("No placement has been requested yet.")).toBeVisible();

  await page.getByRole("button", { name: "Capture & place" }).click();
  await expect(page.getByRole("button", { name: "Adopt this placement" })).toBeEnabled();
});

test("has no automatically detectable accessibility violations", async ({ page }) => {
  await openWorkbench(page);
  const root = page.locator("[data-morphic-root='worldstate-workbench']");
  await expect(page.getByRole("button", { name: "Capture & place" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to project projection" })).toBeFocused();
  await expectLayoutConformance(root, "focused skip link");
  await page.keyboard.press("Enter");
  await expect(page.locator("#primary-projection")).toBeFocused();
  const results = await new AxeBuilder({ page })
    .include("[data-morphic-root='worldstate-workbench']")
    .analyze();

  expect(results.violations).toEqual([]);
});
