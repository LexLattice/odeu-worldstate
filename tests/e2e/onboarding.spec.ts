import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { HOME_MOVE_IDS } from "../../src/fixtures";

const onboardingRoot = (page: Page) =>
  page.locator("[data-morphic-root='onboarding-experience']");

const workbenchRoot = (page: Page) =>
  page.locator("[data-morphic-root='worldstate-workbench']");

async function persistedLedgerEventCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
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
              | { events?: unknown[] }
              | undefined;
            database.close();
            resolve(document?.events?.length ?? 0);
          };
        };
      }),
  );
}

async function chooseMode(page: Page, mode: "Interactive" | "Watch only") {
  await page.goto("/");
  await page.getByRole("button", { name: mode, exact: true }).click();
  await expect(workbenchRoot(page)).toHaveAttribute(
    "data-worldstate-revision",
    /.+/,
  );
}

test("requires explicit consent and can skip directly to the unchanged workbench", async ({
  page,
}) => {
  await page.goto("/");

  await expect(onboardingRoot(page)).toHaveAttribute(
    "data-onboarding-phase",
    "consent",
  );
  await expect(
    page.getByRole("heading", {
      name: "See the project before changing it.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Presentation only", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Unavailable · captions provided", { exact: true }),
  ).toBeVisible();
  await expect(workbenchRoot(page)).toHaveCount(0);

  const consentAccessibility = await new AxeBuilder({ page })
    .include("[data-morphic-root='onboarding-experience']")
    .analyze();
  expect(consentAccessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Skip", exact: true }).click();

  await expect(onboardingRoot(page)).toHaveAttribute(
    "data-onboarding-phase",
    "skipped",
  );
  await expect(workbenchRoot(page)).toHaveAttribute(
    "data-worldstate-revision",
    /.+/,
  );
  await expect(workbenchRoot(page)).toBeFocused();
  await expect(
    page.locator("[data-morphic-region='onboarding-guide']"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeEnabled();
  await expect(workbenchRoot(page)).toHaveAttribute(
    "data-mutation-access",
    "enabled",
  );
});

test("interactive guidance advances only after the user makes each presentation choice", async ({
  page,
}) => {
  await chooseMode(page, "Interactive");
  const onboarding = onboardingRoot(page);
  const workbench = workbenchRoot(page);
  const initialRevision = await workbench.getAttribute(
    "data-worldstate-revision",
  );
  const initialEventCount = await persistedLedgerEventCount(page);

  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "presentation-only",
  );
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reset sandbox" })).toBeDisabled();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "establish-project",
  );
  await expect(
    page.locator("[data-presentation-id='project-home-move']"),
  ).toHaveText("Plan our home move");
  await expect(
    page.locator(`[data-presentation-id='${HOME_MOVE_IDS.budget}']`),
  ).toHaveText("Budget");
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await expect(continueButton).toBeEnabled();

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(continueButton).toBeDisabled();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "establish-project",
  );
  await expect(page.getByText("Guidance is paused.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "select-outline",
  );
  await expect(
    page.getByRole("heading", { name: "See the project structure" }),
  ).toBeFocused();
  await page.getByRole("tab", { name: /Outline:/i }).click();
  await expect(workbench).toHaveAttribute("data-view", "outline");
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "select-goal",
  );
  await expect(
    page.getByRole("heading", { name: "Find the governing goal" }),
  ).toBeFocused();
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    HOME_MOVE_IDS.budget,
  );
  await expect(continueButton).toBeDisabled();
  await page
    .getByRole("button", {
      name: /Complete the move for less than €4,000/i,
    })
    .click();
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    HOME_MOVE_IDS.goal,
  );
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "source-capture-handoff",
  );
  await expect(
    page.getByRole("heading", { name: "Bring in an ordinary idea" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Finish opening" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Finish or skip the opening guide before saving this source/i),
  ).toBeVisible();
  await page.getByRole("button", { name: "Finish opening" }).click();

  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "complete");
  await expect(
    page.getByText("Opening complete · normal workbench available", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Opening complete · normal workbench available",
    }),
  ).toBeFocused();
  await expect(workbench).toHaveAttribute("data-mutation-access", "enabled");
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reset sandbox" })).toBeEnabled();
  await page.getByRole("button", { name: "Close guide" }).click();
  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "skipped");
  await expect(workbench).toBeFocused();
  await expect(workbench).toHaveAttribute(
    "data-worldstate-revision",
    initialRevision as string,
  );
  expect(await persistedLedgerEventCount(page)).toBe(initialEventCount);
});

test("watch-only guidance uses state-derived presentation commands without ledger writes and can replay", async ({
  page,
}) => {
  await chooseMode(page, "Watch only");
  const onboarding = onboardingRoot(page);
  const workbench = workbenchRoot(page);
  const initialRevision = await workbench.getAttribute(
    "data-worldstate-revision",
  );
  const initialEventCount = await persistedLedgerEventCount(page);
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "establish-project",
  );
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "presentation-only",
  );
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeDisabled();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "select-outline",
  );
  await expect(workbench).toHaveAttribute("data-view", "outline");
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "select-goal",
  );
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    HOME_MOVE_IDS.goal,
  );
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "source-capture-handoff",
  );
  await expect(
    page.getByRole("button", { name: "Finish opening" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Finish opening" }).click();

  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "complete");
  await expect(workbench).toHaveAttribute(
    "data-worldstate-revision",
    initialRevision as string,
  );
  expect(await persistedLedgerEventCount(page)).toBe(initialEventCount);

  await page.getByRole("button", { name: "Replay opening" }).click();
  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "guiding");
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "establish-project",
  );
  await expect(
    page.getByRole("heading", { name: "Meet the sandbox project" }),
  ).toBeFocused();
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "presentation-only",
  );
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeDisabled();
  await expect(continueButton).toBeEnabled();
  await expect(workbench).toHaveAttribute(
    "data-worldstate-revision",
    initialRevision as string,
  );
  expect(await persistedLedgerEventCount(page)).toBe(initialEventCount);

  const guidedAccessibility = await new AxeBuilder({ page })
    .include("[data-morphic-root='onboarding-experience']")
    .analyze();
  expect(guidedAccessibility.violations).toEqual([]);
});
