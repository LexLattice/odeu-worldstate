import { describe, expect, it } from "vitest";

import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import { CodexReplayNotApplicableError, runCodexReplay } from "./replay";
import { AgentRunSuccessSchema } from "./schema";

function registeredRequest(requestId: string) {
  const fixture = createPrivateProjectionFixture();
  return domainBriefToCodexRunRequest(
    fixture.brief,
    `run-${requestId}`,
    "replay",
    requestId,
  );
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
    expect(first.closure.runId).toBe(request.runId);
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

  it("matches authored semantics across freshly compiled identities", () => {
    const request = registeredRequest("dynamic-identities");
    const sharedIds = new Map(
      request.brief.context.shared.map((item, index) => [
        item.id,
        `dynamic-context-${index}`,
      ]),
    );
    const result = runCodexReplay({
      ...request,
      runId: "run-dynamically-compiled",
      brief: {
        ...request.brief,
        briefId: "brief-dynamically-compiled",
        sourceRevisionId: "revision-dynamically-compiled",
        artifactBaseRef: "git:dynamically-compiled",
        context: {
          ...request.brief.context,
          shared: request.brief.context.shared.map((item) => ({
            ...item,
            id: sharedIds.get(item.id) as string,
          })),
          relations: request.brief.context.relations.map((relation, index) => ({
            ...relation,
            id: `dynamic-relation-${index}`,
            fromId: sharedIds.get(relation.fromId) as string,
            toId: sharedIds.get(relation.toId) as string,
          })),
        },
        evidenceContract: {
          ...request.brief.evidenceContract,
          requiredChecks: request.brief.evidenceContract.requiredChecks.map(
            (check, index) => ({ ...check, checkId: `dynamic-check-${index}` }),
          ),
        },
      },
    });

    expect(result.closure).toMatchObject({
      runId: "run-dynamically-compiled",
      briefId: "brief-dynamically-compiled",
      sourceRevisionIdUsed: "revision-dynamically-compiled",
      artifactBaseRefUsed: "git:dynamically-compiled",
    });
  });

  it("refuses a live request at the replay adapter boundary", () => {
    expect(() =>
      runCodexReplay({ ...registeredRequest("wrong-mode"), mode: "live" }),
    ).toThrow("replay Codex adapter cannot execute a live run request");
  });
});
