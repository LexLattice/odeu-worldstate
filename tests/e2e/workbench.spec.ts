import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SOURCE =
  "Ask Codex to add a simple moving-cost comparison tool to my relocation project.";

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

test("persists capture and placement before one semantic commit, then reloads exactly", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("[data-morphic-root='worldstate-workbench']");
  const capture = page.getByRole("button", { name: "Capture & place" });
  await expect(capture).toBeVisible();

  const initialRevision = await root.getAttribute("data-worldstate-revision");
  await capture.click();

  const accept = page.getByRole("button", { name: "Adopt this placement" });
  await expect(accept).toBeEnabled();
  await expect(root).toHaveAttribute("data-worldstate-revision", initialRevision as string);
  await expect(page.getByText(SOURCE, { exact: false })).toBeVisible();
  await expect(page.getByText("Suggested · no change yet")).toBeVisible();
  await expect(page.getByText("Agent execution unavailable in this slice")).toBeVisible();

  await accept.click();
  await expect(page.getByRole("button", { name: "Placement adopted" })).toBeDisabled();
  const adoptedRevision = await root.getAttribute("data-worldstate-revision");
  const adoptedSelectedObject = await root.getAttribute("data-selected-object-id");
  const adoptedReceipt = await page
    .locator("[data-evidence-anchor='placement-exchange'] small")
    .textContent();
  expect(adoptedRevision).not.toBe(initialRevision);
  expect(adoptedSelectedObject).toBeTruthy();
  expect(adoptedReceipt).toMatch(/^receipt-/);

  await page.reload();
  await expect(page.getByRole("button", { name: "Placement adopted" })).toBeDisabled();
  await expect(root).toHaveAttribute("data-worldstate-revision", adoptedRevision as string);
  await expect(root).toHaveAttribute(
    "data-selected-object-id",
    adoptedSelectedObject as string,
  );
  await expect(
    page.locator("[data-evidence-anchor='placement-exchange'] small"),
  ).toHaveText(adoptedReceipt as string);
  await expect(page.getByText(SOURCE, { exact: false })).toBeVisible();
  await expect(
    page
      .locator("[data-morphic-lane='runtime-truth']")
      .getByText("Deterministic fixture manager", { exact: true }),
  ).toBeVisible();
});

test("shows one dynamic candidate in outline, map, timeline, and focus without ledger writes", async ({
  page,
}) => {
  await page.goto("/");
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

test("keeps runtime truth and evidence-before-commit visible on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
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
});

test("requires explicit confirmation and leaves the sandbox reusable after reset", async ({
  page,
}) => {
  await page.goto("/");
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
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Capture & place" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to project projection" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#primary-projection")).toBeFocused();
  const results = await new AxeBuilder({ page })
    .include("[data-morphic-root='worldstate-workbench']")
    .analyze();

  expect(results.violations).toEqual([]);
});
