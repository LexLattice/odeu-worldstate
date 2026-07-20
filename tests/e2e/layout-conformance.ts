import { expect, type Locator, type Page } from "@playwright/test";

export const RESPONSIVE_LAYOUT_WIDTHS = [
  320, 360, 390, 430, 768, 1024, 1280, 1440,
] as const;

export type LayoutViolationKind =
  | "first-order-out-of-bounds"
  | "first-order-content-overflow"
  | "second-order-out-of-bounds"
  | "second-order-clipped"
  | "truncate-without-full-label";

export interface LayoutViolation {
  readonly kind: LayoutViolationKind;
  readonly target: string;
  readonly detail: string;
  readonly text?: string;
}

export async function inspectLayoutConformance(
  root: Locator,
): Promise<readonly LayoutViolation[]> {
  return root.evaluate((rootNode) => {
    const tolerance = 1.5;
    const firstOrderSelector = [
      "[data-morphic-root]",
      "[data-morphic-region]",
      "[data-morphic-lane]",
      "[data-layout-object='primary']",
    ].join(",");
    const violations: LayoutViolation[] = [];
    const recorded = new Set<string>();
    const rootElement = rootNode as HTMLElement;
    const rootRect = rootElement.getBoundingClientRect();

    const describe = (element: Element): string => {
      for (const attribute of [
        "data-morphic-root",
        "data-morphic-region",
        "data-morphic-lane",
        "data-layout-object",
      ]) {
        const value = element.getAttribute(attribute);
        if (value) return `[${attribute}='${value}']`;
      }
      if (element.id) return `#${element.id}`;
      const className =
        element instanceof HTMLElement
          ? element.className
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .join(".")
          : "";
      return `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
    };

    const record = (violation: LayoutViolation): void => {
      const key = `${violation.kind}:${violation.target}:${violation.detail}:${violation.text ?? ""}`;
      if (recorded.has(key)) return;
      recorded.add(key);
      violations.push(violation);
    };

    const isRendered = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.contentVisibility !== "hidden" &&
        rect.width > tolerance &&
        rect.height > tolerance
      );
    };

    const overflowPolicy = (element: Element): string =>
      element
        .closest<HTMLElement>("[data-overflow-policy]")
        ?.dataset.overflowPolicy?.trim() || "wrap";

    const firstOrderElements = [
      rootElement,
      ...Array.from(
        rootElement.querySelectorAll<HTMLElement>(firstOrderSelector),
      ),
    ].filter(
      (element, index, elements) =>
        elements.indexOf(element) === index && isRendered(element),
    );

    for (const element of firstOrderElements) {
      const rect = element.getBoundingClientRect();
      const target = describe(element);
      const leftBoundary = element === rootElement ? 0 : rootRect.left;
      const rightBoundary =
        element === rootElement ? window.innerWidth : rootRect.right;
      if (
        rect.left < leftBoundary - tolerance ||
        rect.right > rightBoundary + tolerance
      ) {
        record({
          kind: "first-order-out-of-bounds",
          target,
          detail: `horizontal bounds ${rect.left.toFixed(1)}..${rect.right.toFixed(1)} exceed ${leftBoundary.toFixed(1)}..${rightBoundary.toFixed(1)}`,
        });
      }

      const policy = overflowPolicy(element);
      if (
        policy === "wrap" &&
        (element.scrollWidth > element.clientWidth + tolerance ||
          (element.matches("[data-layout-object='primary']") &&
            element.scrollHeight > element.clientHeight + tolerance))
      ) {
        const overflowingChild = Array.from(
          element.querySelectorAll<HTMLElement>("*"),
        )
          .filter(isRendered)
          .map((child) => ({ child, rect: child.getBoundingClientRect() }))
          .filter(
            ({ rect: childRect }) =>
              childRect.left < rect.left - tolerance ||
              childRect.right > rect.right + tolerance,
          )
          .sort(
            (left, right) =>
              right.rect.right - rect.right - (left.rect.right - rect.right),
          )[0];
        record({
          kind: "first-order-content-overflow",
          target,
          detail: `content ${element.scrollWidth}×${element.scrollHeight} exceeds client ${element.clientWidth}×${element.clientHeight}${
            overflowingChild
              ? `; descendant ${describe(overflowingChild.child)} spans ${overflowingChild.rect.left.toFixed(1)}..${overflowingChild.rect.right.toFixed(1)}`
              : ""
          }`,
        });
      }
    }

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
      rootElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) =>
          node.textContent?.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      },
    );
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || !isRendered(parent)) continue;
      const policy = overflowPolicy(parent);
      if (policy === "truncate") {
        const policyElement = parent.closest<HTMLElement>(
          "[data-overflow-policy='truncate']",
        );
        const fullLabel = policyElement?.getAttribute("aria-label")?.trim();
        const text = textNode.textContent?.trim().replace(/\s+/g, " ") ?? "";
        if (!fullLabel || !fullLabel.includes(text)) {
          record({
            kind: "truncate-without-full-label",
            target: describe(policyElement ?? parent),
            detail:
              "explicit truncation requires an aria-label containing the full visible text",
            text,
          });
        }
        continue;
      }
      if (["scroll", "focus-expand"].includes(policy)) continue;
      if (
        policy === "focus-reveal" &&
        !parent.closest<HTMLElement>("[data-overflow-policy='focus-reveal']")
          ?.matches(":focus-within")
      ) {
        continue;
      }

      const range = document.createRange();
      range.selectNodeContents(textNode);
      const lineRects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      range.detach();
      if (lineRects.length === 0) continue;

      const text = textNode.textContent?.trim().replace(/\s+/g, " ") ?? "";
      const textPreview = text.length > 96 ? `${text.slice(0, 93)}...` : text;
      const firstOrder =
        parent.closest<HTMLElement>(firstOrderSelector) ?? rootElement;
      const firstOrderRect = firstOrder.getBoundingClientRect();
      const target = `${describe(firstOrder)} > ${describe(parent)}`;

      for (const lineRect of lineRects) {
        if (
          lineRect.left < firstOrderRect.left - tolerance ||
          lineRect.right > firstOrderRect.right + tolerance ||
          lineRect.top < firstOrderRect.top - tolerance ||
          lineRect.bottom > firstOrderRect.bottom + tolerance
        ) {
          record({
            kind: "second-order-out-of-bounds",
            target,
            detail: "a rendered text line exceeds its nearest first-order object",
            text: textPreview,
          });
          break;
        }
      }

      let ancestor: HTMLElement | null = parent;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        const clipsX = ["hidden", "clip", "auto", "scroll"].includes(
          style.overflowX,
        );
        const clipsY = ["hidden", "clip", "auto", "scroll"].includes(
          style.overflowY,
        );
        if (clipsX || clipsY) {
          const ancestorRect = ancestor.getBoundingClientRect();
          const clipped = lineRects.some(
            (lineRect) =>
              (clipsX &&
                (lineRect.left < ancestorRect.left - tolerance ||
                  lineRect.right > ancestorRect.right + tolerance)) ||
              (clipsY &&
                (lineRect.top < ancestorRect.top - tolerance ||
                  lineRect.bottom > ancestorRect.bottom + tolerance)),
          );
          if (clipped) {
            record({
              kind: "second-order-clipped",
              target,
              detail: `text intersects clipping ancestor ${describe(ancestor)}`,
              text: textPreview,
            });
            break;
          }
        }
        if (ancestor === rootElement) break;
        ancestor = ancestor.parentElement;
      }
    }

    return violations;
  });
}

export async function expectLayoutConformance(
  root: Locator,
  context = "layout",
): Promise<void> {
  const violations = await inspectLayoutConformance(root);
  expect(
    violations,
    `${context} violations:\n${JSON.stringify(violations, null, 2)}`,
  ).toEqual([]);
}

export async function expectLayoutConformanceAtWidths(
  page: Page,
  root: Locator,
  widths: readonly number[],
  context: string,
  height = 900,
): Promise<void> {
  const originalViewport = page.viewportSize();
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expectLayoutConformance(root, `${context} at ${width}px`);
    }
  } finally {
    if (originalViewport && !page.isClosed()) {
      await page.setViewportSize(originalViewport);
    }
  }
}
