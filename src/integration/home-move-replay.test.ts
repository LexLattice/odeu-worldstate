import { describe, expect, it } from "vitest";

import { compileCodexPrompt } from "@/adapters/codex/prompt";
import { runCodexReplay } from "@/adapters/codex/replay";
import { createPrivateProjectionFixture } from "@/fixtures";

import { domainBriefToCodexRunRequest } from "./domain-brief-to-codex";

describe("home-move fixture execution boundary", () => {
  it("binds the kernel brief to its one truthful fixture replay", () => {
    const fixture = createPrivateProjectionFixture();
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      "request-home-move-fixture-replay",
    );
    const result = runCodexReplay(request);

    expect(result.runtime).toMatchObject({
      effectiveMode: "replay",
      replayKind: "fixture",
      replayIdentity: "home-move-fixture-replay-v0",
    });
    expect(result.closure).toMatchObject({
      briefId: fixture.brief.id,
      sourceRevisionIdUsed: fixture.state.canonical.head.id,
      artifactBaseRefUsed: fixture.brief.artifactBaseRef,
    });
    expect(result.closure.report.claimedChecks.map((item) => item.checkId)).toEqual([
      "requirement-focused-tests",
      "requirement-artifact-change",
    ]);
  });

  it("keeps the private fixture node out of the serialized worker prompt", () => {
    const fixture = createPrivateProjectionFixture();
    const request = domainBriefToCodexRunRequest(
      fixture.brief,
      "request-home-move-privacy-check",
    );
    const prompt = compileCodexPrompt(request.brief);

    expect(prompt).not.toContain("Keep the new address private until the lease is signed");
    expect(prompt).toContain('"omittedContextCount": 5');
  });
});
