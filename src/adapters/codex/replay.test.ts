import { describe, expect, it } from "vitest";

import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { CodexReplayNotApplicableError, runCodexReplay } from "./replay";
import { AgentRunSuccessSchema } from "./schema";

function registeredRequest(requestId: string) {
  const fixture = createPrivateProjectionFixture();
  return domainBriefToCodexRunRequest(fixture.brief, requestId);
}

describe("runCodexReplay", () => {
  it("is deterministic and visibly a replay", () => {
    const request = registeredRequest("run-request-001");
    const first = runCodexReplay(request);
    const second = runCodexReplay(request);

    expect(first).toEqual(second);
    expect(first.runtime).toMatchObject({
      requestedMode: "replay",
      effectiveMode: "replay",
      status: "replayed",
      replayKind: "fixture",
    });
    expect(first.events.map((event) => event.status)).toEqual([
      "queued",
      "received",
      "working",
      "returned",
    ]);
    expect(AgentRunSuccessSchema.parse(first)).toEqual(first);
  });

  it("does not imply that the returned result mutated worldstate", () => {
    const result = runCodexReplay(registeredRequest("run-request-002"));

    expect(result.events.at(-1)?.detail).toContain("has not changed canonical worldstate");
    expect(result.closure.report.outcome).toBe("returned");
    expect(
      result.closure.report.claimedChecks.every((check) => check.status === "passed"),
    ).toBe(true);
  });

  it("refuses to apply recorded evidence to a different brief", () => {
    const request = registeredRequest("run-request-unrelated");
    expect(() =>
      runCodexReplay({
        ...request,
        brief: { ...request.brief, goal: "Publish an unrelated website." },
      }),
    ).toThrow(CodexReplayNotApplicableError);
  });
});
