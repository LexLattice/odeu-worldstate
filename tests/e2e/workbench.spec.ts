import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("keeps semantic commit, fixture replay, and reconciliation as separate gates", async ({
  page,
}) => {
  await page.goto("/");
  const root = page.locator("[data-morphic-root='worldstate-workbench']");
  const dispatch = page.getByRole("button", { name: /Approve & load fixture replay/i });
  const integrate = page.getByRole("button", { name: /Integrate result/i });

  await expect(root).toHaveAttribute("data-worldstate-revision", "rev-018");
  await expect(dispatch).toBeDisabled();
  await expect(integrate).toBeDisabled();

  await page.getByRole("button", { name: "Add to my worldstate" }).click();
  await expect(root).toHaveAttribute("data-worldstate-revision", "rev-019");
  await expect(dispatch).toBeEnabled();

  await dispatch.click();
  await expect(root).toHaveAttribute("data-worldstate-revision", "rev-019");
  await expect(
    page
      .locator("[data-morphic-lane='worker-observation']")
      .getByText("home-move-fixture-replay-v0"),
  ).toBeVisible();
  await expect(page.getByText("Result staged", { exact: true })).toBeVisible();
  await expect(page.getByText("demo/moving-costs.html")).toBeVisible();
  await expect(integrate).toBeEnabled();

  await integrate.click();
  await expect(root).toHaveAttribute("data-worldstate-revision", "rev-020");
  await expect(page.getByRole("button", { name: "Result integrated" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("preserves selection while morphing between projections", async ({ page }) => {
  await page.goto("/");
  const root = page.locator("[data-morphic-root='worldstate-workbench']");

  await page.getByRole("tab", { name: /Outline/i }).click();
  await page
    .getByRole("button", { name: /Complete the move for less than €4,000/i })
    .click();
  await expect(root).toHaveAttribute("data-selected-object-id", "goal-under-4000");

  await page.getByRole("tab", { name: /Map/i }).click();
  await expect(root).toHaveAttribute("data-view", "map");
  await expect(root).toHaveAttribute("data-selected-object-id", "goal-under-4000");
  await expect(
    page.locator("[data-view='map'] [data-worldstate-id='goal-under-4000']"),
  ).toBeVisible();
});

test("defaults narrow screens to Focus without hiding other views", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const root = page.locator("[data-morphic-root='worldstate-workbench']");

  await expect(root).toHaveAttribute("data-view", "focus");
  await expect(page.getByRole("tab", { name: /Outline/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Map/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Timeline/i })).toBeVisible();
});

test("has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .include("[data-morphic-root='worldstate-workbench']")
    .analyze();

  expect(results.violations).toEqual([]);
});
