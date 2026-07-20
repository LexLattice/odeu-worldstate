import { expect, test } from "@playwright/test";

import {
  expectLayoutConformance,
  inspectLayoutConformance,
} from "./layout-conformance";

test("accepts first-order containment with second-order wrap and growth", async ({
  page,
}) => {
  await page.setContent(`
    <main data-morphic-root="test-root" style="width: 240px">
      <section data-morphic-region="truth" style="width: 100%">
        <div data-layout-object="primary" data-overflow-policy="wrap"
          style="min-width: 0; white-space: normal; overflow-wrap: anywhere">
          Placement manager not observed yet
        </div>
      </section>
    </main>
  `);

  await expectLayoutConformance(
    page.locator("[data-morphic-root='test-root']"),
    "wrap-and-grow fixture",
  );
});

test("detects first-order objects that exceed their workbench", async ({
  page,
}) => {
  await page.setContent(`
    <main data-morphic-root="test-root" style="width: 200px; overflow: clip">
      <section data-morphic-region="truth" style="width: 280px">Truth</section>
    </main>
  `);

  const violations = await inspectLayoutConformance(
    page.locator("[data-morphic-root='test-root']"),
  );
  expect(violations.map(({ kind }) => kind)).toContain(
    "first-order-out-of-bounds",
  );
});

test("detects second-order text clipped inside a visible first-order box", async ({
  page,
}) => {
  await page.setContent(`
    <main data-morphic-root="test-root" style="width: 240px">
      <span data-layout-object="primary"
        style="display: block; width: 110px; overflow: hidden; white-space: nowrap">
        Placement manager not observed yet
      </span>
    </main>
  `);

  const violations = await inspectLayoutConformance(
    page.locator("[data-morphic-root='test-root']"),
  );
  expect(violations.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining([
      "first-order-content-overflow",
      "second-order-out-of-bounds",
      "second-order-clipped",
    ]),
  );
});

test("permits explicitly classified auxiliary truncation", async ({ page }) => {
  await page.setContent(`
    <main data-morphic-root="test-root" style="width: 240px">
      <span data-layout-object="primary" data-overflow-policy=" TrUnCaTe "
        aria-label="Auxiliary diagnostic identifier abcdefghijklmnopqrstuvwxyz"
        style="display: block; width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
        Auxiliary diagnostic identifier abcdefghijklmnopqrstuvwxyz
      </span>
    </main>
  `);

  await expectLayoutConformance(
    page.locator("[data-morphic-root='test-root']"),
    "explicit truncation fixture",
  );
});

test("rejects truncation without a full accessible label", async ({ page }) => {
  await page.setContent(`
    <main data-morphic-root="test-root" style="width: 240px">
      <span data-layout-object="primary" data-overflow-policy="truncate"
        style="display: block; width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
        Auxiliary diagnostic identifier abcdefghijklmnopqrstuvwxyz
      </span>
    </main>
  `);

  const violations = await inspectLayoutConformance(
    page.locator("[data-morphic-root='test-root']"),
  );
  expect(violations.map(({ kind }) => kind)).toContain(
    "truncate-without-full-label",
  );
});

test("normalizes focus-reveal policy ownership and inspects it while focused", async ({
  page,
}) => {
  await page.setContent(`
    <main data-morphic-root="test-root" style="width: 240px; overflow: hidden">
      <a href="#target" data-overflow-policy=" Focus-Reveal "
        style="display: block; transform: translateY(-200%)">
        Skip to target
      </a>
      <div id="target">Target</div>
    </main>
  `);

  const root = page.locator("[data-morphic-root='test-root']");
  await expectLayoutConformance(root, "unfocused focus-reveal fixture");

  await page.getByRole("link", { name: "Skip to target" }).focus();
  const violations = await inspectLayoutConformance(root);
  expect(violations.map(({ kind }) => kind)).toContain(
    "second-order-out-of-bounds",
  );
});
