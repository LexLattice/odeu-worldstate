import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { compileCodexPrompt } from "./prompt";
import type { AgentBrief } from "./schema";

export function executionBriefDigest(brief: AgentBrief): string {
  return `sha256:${createHash("sha256").update(compileCodexPrompt(brief)).digest("hex")}`;
}

export function authorizationMessage(input: {
  runId: string;
  mode: "live";
  requestId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  briefDigest: string;
  baseRevisionId: string;
  artifactBaseRef: string;
}): string {
  return [
    input.runId,
    input.mode,
    input.requestId,
    input.nonce,
    input.issuedAt,
    input.expiresAt,
    input.briefDigest,
    input.baseRevisionId,
    input.artifactBaseRef,
  ].join("\u0000");
}

export function signRunAuthorization(
  input: Parameters<typeof authorizationMessage>[0],
  secret: string,
): string {
  return createHmac("sha256", secret).update(authorizationMessage(input)).digest("hex");
}

export function authorizationMatches(
  input: Parameters<typeof authorizationMessage>[0],
  capability: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signRunAuthorization(input, secret), "hex");
  const received = Buffer.from(capability, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
