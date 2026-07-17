import {
  MANAGER_PROPOSED_SUMMARY_MAX_LENGTH,
  ManagerPlacementInterpretationSchema,
  type ManagerPlacementInterpretation,
  type PlacementRequest,
} from "./schema";

const FIXTURE_SOURCE_EXCERPT_NOTICE =
  "Fixture summary is excerpted; review the preserved original source.";

function summaryFromSource(source: string): {
  readonly text: string;
  readonly excerpted: boolean;
} {
  if (source.length <= MANAGER_PROPOSED_SUMMARY_MAX_LENGTH) {
    return { text: source, excerpted: false };
  }

  let excerpt = source
    .slice(0, MANAGER_PROPOSED_SUMMARY_MAX_LENGTH - 1)
    .trimEnd();
  if (/[\uD800-\uDBFF]$/.test(excerpt)) {
    excerpt = excerpt.slice(0, -1);
  }

  return { text: `${excerpt}…`, excerpted: true };
}

function titleFromSource(source: string): string {
  const normalized = source.toLowerCase();

  if (
    normalized.includes("comparison") ||
    normalized.includes("compare") ||
    normalized.includes("quote")
  ) {
    return "Compare provider quotes";
  }

  const trimmed = source.trim().replace(/[.!?]+$/, "");
  return trimmed.length <= 76 ? trimmed : `${trimmed.slice(0, 73).trimEnd()}…`;
}

function chooseLocation(request: PlacementRequest) {
  const normalized = request.source.text.toLowerCase();
  const nodes = request.projection.nodes;
  const selected = nodes.find(
    (node) => node.id === request.projection.selectedNodeId,
  );

  if (selected) {
    return selected;
  }

  if (
    ["cost", "budget", "price", "quote", "provider"].some((keyword) =>
      normalized.includes(keyword),
    )
  ) {
    const budgetNode = nodes.find((node) =>
      node.title.toLowerCase().includes("budget"),
    );

    if (budgetNode) {
      return budgetNode;
    }
  }

  return (
    nodes.find((node) => node.id === request.projection.projectId) ??
    nodes.find((node) => node.kind === "Project") ??
    nodes[0] ??
    null
  );
}

export function interpretFixturePlacement(
  request: PlacementRequest,
): ManagerPlacementInterpretation {
  const normalizedSource = request.source.text.toLowerCase();
  const isCostComparison = ["cost", "compare", "comparison", "quote"].some(
    (keyword) => normalizedSource.includes(keyword),
  );
  const sourceSummary = summaryFromSource(request.source.text);
  const location = chooseLocation(request);
  const project =
    request.projection.nodes.find(
      (node) => node.id === request.projection.projectId,
    ) ??
    request.projection.nodes.find((node) => node.kind === "Project") ??
    null;

  if (location === null) {
    return ManagerPlacementInterpretationSchema.parse({
      projectId: null,
      locationTargetNodeId: null,
      locationLabel: "Project not selected",
      breadcrumb: ["World"],
      proposedKind: "Idea",
      proposedTitle: titleFromSource(request.source.text),
      proposedSummary: sourceSummary.text,
      rationale:
        "The fixture manager cannot place this source without a bounded project node.",
      confidence: "low",
      uncertainty: [
        "No project node was supplied in the bounded projection.",
        ...(sourceSummary.excerpted ? [FIXTURE_SOURCE_EXCERPT_NOTICE] : []),
      ],
      conflicts: [],
      alternatives: [],
      affectedNodeIds: [],
      relations: [],
      clarificationNeeded: true,
      clarificationQuestion: "Which project should this idea belong to?",
    });
  }

  const breadcrumb = [project?.title, location.title].filter(
    (segment, index, segments): segment is string =>
      Boolean(segment) && segments.indexOf(segment) === index,
  );

  return ManagerPlacementInterpretationSchema.parse({
    projectId: project?.id ?? request.projection.projectId,
    locationTargetNodeId: location.id,
    locationLabel: location.title,
    breadcrumb,
    proposedKind: "Task",
    proposedTitle: titleFromSource(request.source.text),
    proposedSummary: isCostComparison
      ? "Create a small comparison tool for moving-provider costs and return focused implementation evidence."
      : sourceSummary.text,
    rationale: isCostComparison
      ? "The request is actionable work and its cost-comparison language makes the budget area the most relevant placement."
      : "The deterministic fixture places actionable work in the selected area, or at project level when no area is selected.",
    confidence: isCostComparison ? "high" : "medium",
    uncertainty: isCostComparison
      ? ["Recurring storage costs may need a separate comparison."]
      : [
          "Fixture mode does not infer details beyond the supplied source.",
          ...(sourceSummary.excerpted ? [FIXTURE_SOURCE_EXCERPT_NOTICE] : []),
        ],
    conflicts: [],
    alternatives: project
      ? [
          {
            targetNodeId: project.id,
            targetTitle: project.title,
            rationale:
              "Place it at project level if the tool will cover schedule and provider quality as well as budget.",
          },
        ]
      : [],
    affectedNodeIds: [location.id],
    relations: [
      {
        kind: "belongs_to",
        targetNodeId: location.id,
        direction: "from_proposed",
        rationale: "The proposed task is organized under this project area.",
      },
    ],
    clarificationNeeded: false,
    clarificationQuestion: null,
  });
}
