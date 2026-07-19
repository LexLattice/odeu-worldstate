import { describe, expect, it } from "vitest";

import { compileCodexPrompt } from "@/adapters/codex/prompt";
import { runCodexReplay } from "@/adapters/codex/replay";
import { AgentRunRequestSchema } from "@/adapters/codex/schema";
import {
  AgentBriefSchema,
  MOVING_COST_DELEGATION_PROFILE_ID,
} from "@/domain";

import { domainBriefToCodexRunRequest } from "./domain-brief-to-codex";

const domainBrief = AgentBriefSchema.parse({
  id: "brief-home-move-001",
  baseRevisionId: "rev-home-move-019",
  artifactBaseRef: "commit:008a1a7",
  targetNodeId: "task-compare-quotes",
  delegationProfileId: MOVING_COST_DELEGATION_PROFILE_ID,
  goal: "Add a moving-cost comparison tool.",
  doneMeans: ["Two provider totals can be compared", "Focused checks pass"],
  unknowns: ["Compare recurring storage separately?"],
  constraints: ["Keep the comparison understandable without financial jargon"],
  expectedArtifacts: ["A runnable moving-cost comparison surface"],
  sharedNodes: [
    {
      id: "task-compare-quotes",
      scopeId: "project-home-move",
      kind: "Task",
      delegationProfileId: MOVING_COST_DELEGATION_PROFILE_ID,
      title: "Compare provider quotes",
      description: "Add a simple comparison to the local planning page.",
      visibility: "shared",
      sourceRefs: ["source-home-move-001"],
      data: {},
      createdRevisionId: "rev-home-move-019",
    },
    {
      id: "artifact-planning-page",
      scopeId: "project-home-move",
      kind: "Artifact",
      title: "Local planning page",
      visibility: "shared",
      sourceRefs: [],
      data: {},
      createdRevisionId: "rev-home-move-012",
    },
    {
      id: "question-storage",
      scopeId: "project-home-move",
      kind: "OpenQuestion",
      title: "Compare recurring storage separately?",
      visibility: "shared",
      sourceRefs: [],
      data: {},
      createdRevisionId: "rev-home-move-019",
    },
  ],
  sharedRelations: [],
  omittedContext: [
    {
      nodeId: "private-household-finance",
      title: "Household account details",
      reason: "private",
    },
  ],
  environment: "Isolated repository worktree",
  agentProfile: "Codex repo worker",
  allowedActions: ["Edit the scoped local artifact", "Run focused checks"],
  deniedActions: ["Publish or push changes"],
  confirmationRequired: ["Add a dependency"],
  evidenceContract: {
    requirements: [
      {
        id: "check-focused-tests",
        label: "Focused tests pass",
        kind: "test",
        command: "npm test -- moving-cost",
        required: true,
      },
    ],
    policy: { blockIntegration: true },
  },
  escalationPath: "Return blocked rather than broadening scope.",
});

describe("domainBriefToCodexRunRequest", () => {
  it("sends only the execution projection across the server boundary", () => {
    const request = domainBriefToCodexRunRequest(
      domainBrief,
      "run-agent-001",
      "replay",
      "request-agent-001",
    );

    expect(request).toMatchObject({
      runId: "run-agent-001",
      mode: "replay",
      requestId: "request-agent-001",
    });
    expect(request.brief.context.omittedCount).toBe(1);
    expect(request.brief.delegationProfileId).toBe(
      MOVING_COST_DELEGATION_PROFILE_ID,
    );
    expect(JSON.stringify(request)).not.toContain("Household account details");
    expect(request.brief.unknowns).toContain("Compare recurring storage separately?");
    expect(request.brief.evidenceContract.blockIntegration).toBe(true);
    expect(request.brief.evidenceContract.requiredChecks[0]?.kind).toBe("test");
    expect(request.brief.evidenceContract.requiredChecks[0]?.command).toBe(
      "npm test -- moving-cost",
    );
    expect(request.brief.constraints).toEqual([
      "Keep the comparison understandable without financial jargon",
    ]);
    expect(request.brief.evidenceContract.expectedArtifacts).toEqual([
      "A runnable moving-cost comparison surface",
    ]);

    const prompt = compileCodexPrompt(request.brief);
    expect(prompt).not.toContain("Household account details");
    expect(prompt).toContain(
      `"delegationProfileId": "${MOVING_COST_DELEGATION_PROFILE_ID}"`,
    );
    expect(prompt).toContain('"omittedContextCount": 1');
  });

  it("cannot change the execution mode frozen into the durable brief", () => {
    expect(() =>
      domainBriefToCodexRunRequest(
        domainBrief,
        "run-agent-live-substitution",
        "live",
        "request-agent-live-substitution",
      ),
    ).toThrow("bound to replay");
  });

  it("parses legacy unbound briefs for history but rejects every execution path", () => {
    const { delegationProfileId: _domainProfile, ...legacyDomainInput } =
      domainBrief;
    void _domainProfile;
    const legacyDomainBrief = AgentBriefSchema.parse(legacyDomainInput);
    expect(legacyDomainBrief.delegationProfileId).toBeNull();
    expect(() =>
      domainBriefToCodexRunRequest(
        legacyDomainBrief,
        "run-legacy-unbound",
        "replay",
        "request-legacy-unbound",
      ),
    ).toThrow("ineligible for execution");

    const currentRequest = domainBriefToCodexRunRequest(
      domainBrief,
      "run-current-profiled",
      "replay",
      "request-current-profiled",
    );
    const {
      delegationProfileId: _codexProfile,
      ...legacyCodexBriefInput
    } = currentRequest.brief;
    void _codexProfile;
    const legacyRequest = AgentRunRequestSchema.parse({
      ...currentRequest,
      runId: "run-legacy-low-level",
      requestId: "request-legacy-low-level",
      brief: legacyCodexBriefInput,
    });
    expect(legacyRequest.brief.delegationProfileId).toBeNull();
    expect(() => runCodexReplay(legacyRequest)).toThrow(
      "ineligible for Codex execution",
    );
  });
});
