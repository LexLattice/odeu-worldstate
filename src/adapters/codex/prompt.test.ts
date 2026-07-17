import { describe, expect, it } from "vitest";

import { compileCodexPrompt } from "./prompt";
import { testBrief } from "./test-fixture";

describe("compileCodexPrompt", () => {
  it("makes the immutable scope explicit and denies private context by omission", () => {
    const prompt = compileCodexPrompt(testBrief);

    expect(prompt).toContain("complete authority boundary");
    expect(prompt).toContain('"omittedContextCount": 1');
    expect(prompt).not.toContain("Household account details");
    expect(prompt).not.toContain("Not needed to implement the calculator");
    expect(prompt).toContain("Do not publish");
    expect(prompt).toContain("blocked result is resumable");
  });
});
