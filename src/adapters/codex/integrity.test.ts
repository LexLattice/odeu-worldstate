import { describe, expect, it } from "vitest";

import { createPrivateProjectionFixture } from "@/fixtures";
import { domainBriefToCodexRunRequest } from "@/integration/domain-brief-to-codex";

import {
  authorizationMatches,
  executionBriefDigest,
  signRunAuthorization,
} from "./integrity";

describe("Codex execution integrity", () => {
  it("changes the digest when any worker-visible brief content changes", () => {
    const fixture = createPrivateProjectionFixture();
    const request = domainBriefToCodexRunRequest(fixture.brief, "request-digest");
    const original = executionBriefDigest(request.brief);
    const changed = executionBriefDigest({
      ...request.brief,
      actions: {
        ...request.brief.actions,
        allowed: [...request.brief.actions.allowed, "Publish externally"],
      },
    });

    expect(original).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(changed).not.toBe(original);
  });

  it("binds authorization to the run, brief, revision, and artifact base", () => {
    const input = {
      runId: "run-live-001",
      mode: "live" as const,
      requestId: "request-live-001",
      nonce: "00000000-0000-4000-8000-000000000001",
      issuedAt: "2026-07-16T09:00:00.000Z",
      expiresAt: "2026-07-16T09:05:00.000Z",
      briefDigest: `sha256:${"a".repeat(64)}`,
      baseRevisionId: "rev-001",
      artifactBaseRef: `git:${"b".repeat(40)}`,
    };
    const secret = "test-secret-not-for-production";
    const capability = signRunAuthorization(input, secret);

    expect(authorizationMatches(input, capability, secret)).toBe(true);
    expect(
      authorizationMatches(
        { ...input, requestId: "request-live-002" },
        capability,
        secret,
      ),
    ).toBe(false);
  });
});
