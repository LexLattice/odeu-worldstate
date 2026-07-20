import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { HOME_MOVE_IDS } from "../../src/fixtures";
import {
  expectLayoutConformanceAtWidths,
  RESPONSIVE_LAYOUT_WIDTHS,
} from "./layout-conformance";

const onboardingRoot = (page: Page) =>
  page.locator("[data-morphic-root='onboarding-experience']");

const workbenchRoot = (page: Page) =>
  page.locator("[data-morphic-root='worldstate-workbench']");

interface PersistedLedgerSummary {
  readonly total: number;
  readonly humanSourceIds: readonly string[];
  readonly placementAttemptIds: readonly string[];
  readonly placementExchangeIds: readonly string[];
  readonly pendingDeltaIds: readonly string[];
  readonly acceptedCount: number;
  readonly briefCount: number;
  readonly runCount: number;
  readonly closureCount: number;
}

async function persistedLedgerSummary(
  page: Page,
): Promise<PersistedLedgerSummary> {
  return page.evaluate(
    () =>
      new Promise<PersistedLedgerSummary>((resolve, reject) => {
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
              | {
                  events?: Array<{
                    type?: string;
                    payload?: {
                      source?: { id?: string; kind?: string };
                      delta?: { id?: string };
                    };
                  }>;
                }
              | undefined;
            const events = document?.events ?? [];
            const sourceIds = events.flatMap((event) => {
              const source = event.payload?.source;
              return event.type === "source.captured" && source?.id
                ? [source]
                : [];
            });
            database.close();
            resolve({
              total: events.length,
              humanSourceIds: sourceIds
                .filter((source) => source.kind === "text")
                .map((source) => source.id as string)
                .sort(),
              placementAttemptIds: sourceIds
                .map((source) => source.id as string)
                .filter((id) => id.startsWith("source-placement-attempt:"))
                .sort(),
              placementExchangeIds: sourceIds
                .map((source) => source.id as string)
                .filter((id) => id.startsWith("source-placement-exchange:"))
                .sort(),
              pendingDeltaIds: events
                .flatMap((event) =>
                  event.type === "delta.proposed" &&
                  event.payload?.delta?.id
                    ? [event.payload.delta.id]
                    : [],
                )
                .sort(),
              acceptedCount: events.filter(
                (event) => event.type === "delta.accepted",
              ).length,
              briefCount: events.filter(
                (event) => event.type === "brief.compiled",
              ).length,
              runCount: events.filter(
                (event) => event.type === "run.authorized",
              ).length,
              closureCount: events.filter(
                (event) => event.type === "closure.staged",
              ).length,
            });
          };
        };
      }),
  );
}

async function persistedLedgerEventCount(page: Page): Promise<number> {
  return (await persistedLedgerSummary(page)).total;
}

async function chooseMode(page: Page, mode: "Interactive" | "Watch only") {
  await page.goto("/");
  await page.getByRole("button", { name: mode, exact: true }).click();
  await expect(workbenchRoot(page)).toHaveAttribute(
    "data-worldstate-revision",
    /.+/,
  );
}

async function completeOpening(
  page: Page,
  mode: "Interactive" | "Watch only",
) {
  await chooseMode(page, mode);
  const onboarding = onboardingRoot(page);
  const workbench = workbenchRoot(page);
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "establish-project",
  );
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "select-outline",
  );
  if (mode === "Interactive") {
    await page.getByRole("tab", { name: /Outline:/i }).click();
  }
  await expect(workbench).toHaveAttribute("data-view", "outline");
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "select-goal",
  );
  if (mode === "Interactive") {
    await page
      .getByRole("button", {
        name: /Complete the move for less than €4,000/i,
      })
      .click();
  }
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
  await page.getByRole("button", { name: "Finish opening" }).click();
  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "complete");
  await expect(
    page.getByRole("heading", {
      name: "Opening complete · choose the next boundary",
    }),
  ).toBeFocused();
}

async function startSourcePlacementGuide(
  page: Page,
  mode: "Interactive" | "Watch only",
) {
  const onboarding = onboardingRoot(page);
  const workbench = workbenchRoot(page);
  await page
    .getByRole("button", { name: "Start guided placement" })
    .click();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-chapter",
    "source-placement",
  );
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "select-budget-context",
  );
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "guided-capture",
  );
  if (mode === "Interactive") {
    await workbench
      .locator(`[data-worldstate-id='${HOME_MOVE_IDS.budget}']`)
      .first()
      .click();
  }
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    HOME_MOVE_IDS.budget,
  );
  await page
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "capture-source",
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
    page.getByText(/Source capture is unavailable in this guide posture/i),
  ).toBeVisible();
  await page.getByRole("button", { name: "Finish opening" }).click();

  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "complete");
  await expect(
    page.getByText("Opening complete · choose the next boundary", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Opening complete · choose the next boundary",
    }),
  ).toBeFocused();
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "presentation-only",
  );
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reset sandbox" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Start guided placement" }),
  ).toBeEnabled();
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

test("guided placement persists one exact provisional lineage and waits for a separate adoption decision", async ({
  page,
}) => {
  let placementCalls = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/placement"
    ) {
      placementCalls += 1;
    }
  });

  await completeOpening(page, "Interactive");
  const onboarding = onboardingRoot(page);
  const workbench = workbenchRoot(page);
  const initialRevision = await workbench.getAttribute(
    "data-worldstate-revision",
  );
  const initialRevisionId = initialRevision?.split(" · ").at(-1);
  const before = await persistedLedgerSummary(page);

  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "presentation-only",
  );
  await startSourcePlacementGuide(page, "Interactive");
  await expect(page.getByRole("button", { name: "Reset sandbox" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Adopt this placement" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Capture & place" }).click();
  await expect(page.getByText("Suggested · canonical unchanged")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review placement" }),
  ).toBeEnabled();
  expect(placementCalls).toBe(1);

  const sourceEvidence = page.locator(
    "[data-evidence-anchor='source-utterance'] small",
  );
  const requestEvidence = page.locator(
    "[data-evidence-anchor='placement-request'] small",
  );
  const exchangeEvidence = page.locator(
    "[data-evidence-anchor='placement-exchange'] small",
  );
  const deltaEvidence = page.locator(
    "[data-evidence-anchor='pending-delta'] small",
  );
  const baseEvidence = page.locator(
    "[data-evidence-anchor='placement-base-revision'] small",
  );
  await expect(sourceEvidence).toHaveText(/^source:/);
  await expect(requestEvidence).toContainText(/request:/);
  await expect(requestEvidence).toContainText(/source-placement-attempt:/);
  await expect(requestEvidence).toContainText(
    `selected context ${HOME_MOVE_IDS.budget}`,
  );
  await expect(exchangeEvidence).toContainText(/source-placement-exchange:/);
  await expect(exchangeEvidence).toContainText(/receipt-/);
  await expect(deltaEvidence).toHaveText(/delta-/);
  await expect(baseEvidence).toHaveText(initialRevisionId as string);
  await expect(workbench).toHaveAttribute(
    "data-worldstate-revision",
    initialRevision as string,
  );

  const afterPlacement = await persistedLedgerSummary(page);
  expect(afterPlacement.humanSourceIds).toHaveLength(
    before.humanSourceIds.length + 1,
  );
  expect(afterPlacement.placementAttemptIds).toHaveLength(
    before.placementAttemptIds.length + 1,
  );
  expect(afterPlacement.placementExchangeIds).toHaveLength(
    before.placementExchangeIds.length + 1,
  );
  expect(afterPlacement.pendingDeltaIds).toHaveLength(
    before.pendingDeltaIds.length + 1,
  );
  expect(afterPlacement.acceptedCount).toBe(before.acceptedCount);
  expect(afterPlacement.briefCount).toBe(before.briefCount);
  expect(afterPlacement.runCount).toBe(before.runCount);
  expect(afterPlacement.closureCount).toBe(before.closureCount);

  const receiptHeading = page.getByRole("heading", {
    name: "Placement receipt",
  });
  await expect(receiptHeading).not.toBeFocused();
  await page.getByRole("button", { name: "Review placement" }).click();
  await expect(receiptHeading).toBeFocused();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "review-placement",
  );

  const receiptAccessibility = await new AxeBuilder({ page })
    .include("[data-morphic-root='onboarding-experience']")
    .analyze();
  expect(receiptAccessibility.violations).toEqual([]);
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  await page
    .getByRole("button", { name: "Finish source chapter" })
    .click();
  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "complete");
  await expect(
    page.getByRole("heading", {
      name: "Source placement reviewed · decision remains separate",
    }),
  ).toBeFocused();
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "guided-capture",
  );
  await expect(
    page.getByRole("button", { name: "Adopt this placement" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Close guide" }).click();
  await expect(workbench).toHaveAttribute("data-mutation-access", "enabled");
  await expect(
    page.getByRole("button", { name: "Adopt this placement" }),
  ).toBeEnabled();
  await expect(workbench).toHaveAttribute(
    "data-worldstate-revision",
    initialRevision as string,
  );
  expect((await persistedLedgerSummary(page)).acceptedCount).toBe(
    before.acceptedCount,
  );
});

test("semantic adoption preserves one candidate across all views and advances exactly one human revision", async ({
  page,
}) => {
  await completeOpening(page, "Watch only");
  const onboarding = onboardingRoot(page);
  const workbench = workbenchRoot(page);
  const initialRevision = await workbench.getAttribute(
    "data-worldstate-revision",
  );
  await startSourcePlacementGuide(page, "Watch only");
  await page.getByRole("button", { name: "Capture & place" }).click();
  await page.getByRole("button", { name: "Review placement" }).click();
  await page
    .getByRole("button", { name: "Finish source chapter" })
    .click();

  const beforeAdoption = await persistedLedgerSummary(page);
  const candidateId = await workbench.getAttribute("data-selected-object-id");
  expect(candidateId).toMatch(/^candidate-/);
  await page
    .getByRole("button", { name: "Continue to adoption review" })
    .click();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-chapter",
    "semantic-adoption",
  );
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "review-outline",
  );
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "presentation-only",
  );
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    candidateId as string,
  );
  await expect(workbench).toHaveAttribute("data-view", "outline");
  expect(await persistedLedgerSummary(page)).toEqual(beforeAdoption);

  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "review-map",
  );
  await expect(workbench).toHaveAttribute("data-view", "map");
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    candidateId as string,
  );
  expect(await persistedLedgerSummary(page)).toEqual(beforeAdoption);

  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "review-timeline",
  );
  await expect(workbench).toHaveAttribute("data-view", "timeline");
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    candidateId as string,
  );

  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "review-focus",
  );
  await expect(workbench).toHaveAttribute("data-view", "focus");
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    candidateId as string,
  );

  const reviewAccessibility = await new AxeBuilder({ page })
    .include("[data-morphic-root='onboarding-experience']")
    .analyze();
  expect(reviewAccessibility.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await expectLayoutConformanceAtWidths(
    page,
    onboarding,
    RESPONSIVE_LAYOUT_WIDTHS,
    "semantic review",
  );

  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "adopt-placement",
  );
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "guided-adoption",
  );
  await expect(page.getByText("Guided semantic adoption")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset sandbox" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Adopt this placement" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Waiting for adoption" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Adopt this placement" }).click();
  await expect(
    page.getByRole("button", { name: "Placement adopted" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Finish adoption chapter" }),
  ).toBeEnabled();
  const acceptedRevision = await workbench.getAttribute(
    "data-worldstate-revision",
  );
  expect(acceptedRevision).not.toBe(initialRevision);

  const afterAdoption = await persistedLedgerSummary(page);
  expect(afterAdoption.acceptedCount).toBe(beforeAdoption.acceptedCount + 1);
  expect(afterAdoption.briefCount).toBe(beforeAdoption.briefCount);
  expect(afterAdoption.runCount).toBe(beforeAdoption.runCount);
  expect(afterAdoption.closureCount).toBe(beforeAdoption.closureCount);
  expect(afterAdoption.humanSourceIds).toEqual(beforeAdoption.humanSourceIds);
  expect(afterAdoption.placementAttemptIds).toEqual(
    beforeAdoption.placementAttemptIds,
  );
  expect(afterAdoption.placementExchangeIds).toEqual(
    beforeAdoption.placementExchangeIds,
  );

  await page
    .getByRole("button", { name: "Finish adoption chapter" })
    .click();
  await expect(onboarding).toHaveAttribute("data-onboarding-phase", "complete");
  await expect(
    page.getByRole("heading", {
      name: "Semantic update adopted · agent authority remains separate",
    }),
  ).toBeFocused();
  await expect(
    page.locator("[data-completion-kind='semantic-adoption']"),
  ).toHaveAttribute("data-state-surface", "authoritative-status-surface");
  await expect(workbench).toHaveAttribute(
    "data-mutation-access",
    "guided-adoption",
  );
  await expect(
    page.getByText("Guided semantic adoption complete"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Prepare agent brief" }),
  ).toBeDisabled();
  await expectLayoutConformanceAtWidths(
    page,
    onboarding,
    RESPONSIVE_LAYOUT_WIDTHS,
    "semantic adoption completion",
  );

  await page.getByRole("button", { name: "Close guide" }).click();
  await expect(workbench).toHaveAttribute("data-mutation-access", "enabled");
  await expect(
    page.getByRole("button", { name: "Prepare agent brief" }),
  ).toBeEnabled();

  await page.reload();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Placement adopted" }),
  ).toBeDisabled();
  await expect(workbenchRoot(page)).toHaveAttribute(
    "data-worldstate-revision",
    acceptedRevision as string,
  );
  expect(await persistedLedgerSummary(page)).toEqual(afterAdoption);
});

test("interactive semantic review blocks selection drift without mutating the pending placement", async ({
  page,
}) => {
  await completeOpening(page, "Interactive");
  const onboarding = onboardingRoot(page);
  const workbench = workbenchRoot(page);
  await startSourcePlacementGuide(page, "Interactive");
  await page.getByRole("button", { name: "Capture & place" }).click();
  await page.getByRole("button", { name: "Review placement" }).click();
  await page
    .getByRole("button", { name: "Finish source chapter" })
    .click();
  const pending = await persistedLedgerSummary(page);
  const candidateId = await workbench.getAttribute("data-selected-object-id");
  expect(candidateId).toMatch(/^candidate-/);
  await page
    .getByRole("button", { name: "Continue to adoption review" })
    .click();

  await expect(onboarding).toHaveAttribute(
    "data-onboarding-step",
    "review-outline",
  );
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await expect(continueButton).toBeEnabled();
  await workbench
    .locator(
      `[role='treeitem'][data-worldstate-id='${HOME_MOVE_IDS.budget}'] > button`,
    )
    .click();
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    HOME_MOVE_IDS.budget,
  );
  await expect(continueButton).toBeDisabled();
  expect(await persistedLedgerSummary(page)).toEqual(pending);

  await workbench
    .locator(
      `[role='treeitem'][data-worldstate-id='${candidateId}'] > button`,
    )
    .click();
  await expect(continueButton).toBeEnabled();
  await page.getByRole("button", { name: "Exit adoption guide" }).click();
  await expect(workbench).toHaveAttribute("data-mutation-access", "enabled");
  expect((await persistedLedgerSummary(page)).acceptedCount).toBe(
    pending.acceptedCount,
  );
});

test("selection drift before capture is retained as request truth and cannot complete the Budget chapter", async ({
  page,
}) => {
  await completeOpening(page, "Interactive");
  const workbench = workbenchRoot(page);
  const initialRevision = await workbench.getAttribute(
    "data-worldstate-revision",
  );
  const before = await persistedLedgerSummary(page);
  await startSourcePlacementGuide(page, "Interactive");

  await workbench
    .locator(`[data-worldstate-id='${HOME_MOVE_IDS.goal}']`)
    .first()
    .click();
  await expect(workbench).toHaveAttribute(
    "data-selected-object-id",
    HOME_MOVE_IDS.goal,
  );
  await page.getByRole("button", { name: "Capture & place" }).click();
  await expect(page.getByText("Suggested · canonical unchanged")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Waiting for placement" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/durable request was captured outside the required Budget context/i),
  ).toBeVisible();
  await expect(
    page.locator("[data-evidence-anchor='placement-request'] small"),
  ).toContainText(`selected context ${HOME_MOVE_IDS.goal}`);
  await expect(workbench).toHaveAttribute(
    "data-worldstate-revision",
    initialRevision as string,
  );
  const after = await persistedLedgerSummary(page);
  expect(after.acceptedCount).toBe(before.acceptedCount);
  expect(after.briefCount).toBe(before.briefCount);
  expect(after.runCount).toBe(before.runCount);
  expect(after.closureCount).toBe(before.closureCount);
});

test("watch-only source guidance never captures and reload reuses the same durable receipt", async ({
  page,
}) => {
  let placementCalls = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/placement"
    ) {
      placementCalls += 1;
    }
  });

  await completeOpening(page, "Watch only");
  const before = await persistedLedgerSummary(page);
  await startSourcePlacementGuide(page, "Watch only");
  expect(placementCalls).toBe(0);
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Capture & place" }).click();
  await expect(
    page.getByRole("button", { name: "Review placement" }),
  ).toBeEnabled();
  expect(placementCalls).toBe(1);
  const saved = await persistedLedgerSummary(page);
  expect(saved.humanSourceIds).toHaveLength(before.humanSourceIds.length + 1);
  expect(saved.placementAttemptIds).toHaveLength(
    before.placementAttemptIds.length + 1,
  );
  expect(saved.placementExchangeIds).toHaveLength(
    before.placementExchangeIds.length + 1,
  );
  expect(saved.pendingDeltaIds).toHaveLength(
    before.pendingDeltaIds.length + 1,
  );
  expect(saved.acceptedCount).toBe(before.acceptedCount);

  await page.reload();
  await page.getByRole("button", { name: "Watch only", exact: true }).click();
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await page.getByRole("button", { name: "Finish opening" }).click();
  await startSourcePlacementGuide(page, "Watch only");

  await expect(
    page.getByRole("button", { name: "Review placement" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Capture & place" }),
  ).toHaveCount(0);
  expect(placementCalls).toBe(1);
  expect(await persistedLedgerSummary(page)).toEqual(saved);

  await page.getByRole("button", { name: "Review placement" }).click();
  await page
    .getByRole("button", { name: "Finish source chapter" })
    .click();
  expect(await persistedLedgerSummary(page)).toEqual(saved);
});

test("a failed placement preserves one source and exact retry reaches review without adoption", async ({
  page,
}) => {
  let placementCalls = 0;
  await page.route("**/api/placement", async (route) => {
    placementCalls += 1;
    if (placementCalls === 1) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await completeOpening(page, "Watch only");
  const workbench = workbenchRoot(page);
  const initialRevision = await workbench.getAttribute(
    "data-worldstate-revision",
  );
  const before = await persistedLedgerSummary(page);
  await startSourcePlacementGuide(page, "Watch only");

  await page.getByRole("button", { name: "Capture & place" }).click();
  await expect(page.getByText("Placement failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Failed · source retained", { exact: true })).toBeVisible();
  const afterFailure = await persistedLedgerSummary(page);
  expect(placementCalls).toBe(1);
  expect(afterFailure.humanSourceIds).toHaveLength(
    before.humanSourceIds.length + 1,
  );
  expect(afterFailure.placementAttemptIds).toHaveLength(
    before.placementAttemptIds.length + 1,
  );
  expect(afterFailure.pendingDeltaIds).toHaveLength(
    before.pendingDeltaIds.length,
  );
  await expect(
    page.getByRole("button", { name: "Retry from preserved source" }),
  ).toBeEnabled();

  await page
    .getByRole("button", { name: "Retry from preserved source" })
    .click();
  await expect(
    page.getByRole("button", { name: "Review placement" }),
  ).toBeEnabled();
  expect(placementCalls).toBe(2);
  const afterRetry = await persistedLedgerSummary(page);
  expect(afterRetry.humanSourceIds).toEqual(afterFailure.humanSourceIds);
  expect(afterRetry.placementAttemptIds).toHaveLength(
    before.placementAttemptIds.length + 2,
  );
  expect(afterRetry.placementExchangeIds).toHaveLength(
    before.placementExchangeIds.length + 1,
  );
  expect(afterRetry.pendingDeltaIds).toHaveLength(
    before.pendingDeltaIds.length + 1,
  );
  expect(afterRetry.acceptedCount).toBe(before.acceptedCount);
  expect(afterRetry.briefCount).toBe(before.briefCount);
  expect(afterRetry.runCount).toBe(before.runCount);
  expect(afterRetry.closureCount).toBe(before.closureCount);
  await expect(workbench).toHaveAttribute(
    "data-worldstate-revision",
    initialRevision as string,
  );
});
