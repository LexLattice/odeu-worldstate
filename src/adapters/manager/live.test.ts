import { beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class OpenAIMock {
    responses = { parse };
  },
}));

import { createOpenAIPlacementParser } from "./live";
import type { PlacementRequest } from "./schema";

const request: PlacementRequest = {
  requestId: "request-1",
  source: { sourceId: "source-1", text: "Compare moving quotes" },
  baseRevisionId: "revision-1",
  projection: {
    scopeId: "scope-1",
    projectId: "project-1",
    selectedNodeId: null,
    nodes: [
      {
        id: "project-1",
        kind: "Project",
        title: "Plan our home move",
        summary: null,
        scopeId: "scope-1",
        visibility: "shared",
      },
    ],
    relations: [],
  },
};

describe("OpenAI placement parser", () => {
  beforeEach(() => {
    parse.mockReset();
  });

  it("uses Responses structured parsing with storage disabled", async () => {
    parse.mockResolvedValue({
      id: "resp-1",
      model: "gpt-5.6-sol",
      output_parsed: { marker: "structured output" },
    });

    const parser = createOpenAIPlacementParser("test-key-never-sent");
    const result = await parser({ request, model: "gpt-5.6" });

    expect(parse).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6",
        store: false,
        text: {
          format: expect.objectContaining({
            type: "json_schema",
            name: "worldstate_placement",
            strict: true,
          }),
        },
      }),
    );
    expect(result).toEqual({
      responseId: "resp-1",
      model: "gpt-5.6-sol",
      output: { marker: "structured output" },
    });
  });
});
