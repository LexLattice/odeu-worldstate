import { AgentBriefSchema } from "./schema";

export const testBrief = AgentBriefSchema.parse({
  briefId: "brief-moving-cost-tool",
  sourceRevisionId: "rev-0002-6c389ed3268a",
  artifactBaseRef: "git:demo-base-001",
  goal: "Add a simple moving-cost comparison tool to the demo planning page.",
  doneMeans: [
    "A user can enter at least two provider quotes and compare totals.",
    "Focused tests for total calculation pass.",
  ],
  environment: "Disposable local demo workspace",
  agentProfile: "Codex, repository-local implementation",
  context: {
    shared: [
      {
        id: "work-cost-compare",
        kind: "work",
        label: "Compare moving costs",
        summary: "Help compare two relocation choices.",
      },
    ],
    relations: [],
    omittedCount: 1,
  },
  unknowns: ["Whether deposits are treated as costs"],
  constraints: ["Keep the interaction understandable without financial jargon"],
  actions: {
    allowed: ["Edit repo-local demo files", "Run focused tests"],
    denied: ["Publish or push changes"],
    confirmationRequired: ["Add a new dependency"],
  },
  evidenceContract: {
    requiredChecks: [
      {
        checkId: "requirement-focused-tests",
        label: "Focused moving-cost calculation tests pass",
        kind: "test",
        command: "npm test -- moving-cost",
        blocking: true,
      },
      {
        checkId: "requirement-artifact-change",
        label: "The planning-page artifact change is addressable",
        kind: "artifact",
        command: null,
        blocking: true,
      },
    ],
    expectedArtifacts: ["A runnable comparison surface"],
    blockIntegration: true,
  },
  escalationPath: "Return blocked with the missing decision; do not guess.",
});
