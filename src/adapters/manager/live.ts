import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import {
  ManagerPlacementInterpretationSchema,
  type ManagerPlacementInterpretation,
  type PlacementRequest,
} from "./schema";

const PLACEMENT_SYSTEM_PROMPT = `You are the placement manager for ODEU Worldstate.
Interpret one source against only the supplied bounded worldstate projection.
Return a review receipt, not a canonical commit and not an agent dispatch.

Rules:
- Copy node IDs exactly. Never invent an existing project, target, affected, conflict, or alternative node ID.
- Preserve uncertainty and material conflicts; do not overwrite existing decisions or constraints.
- If project choice or placement materially changes meaning or disclosure, set clarificationNeeded to true.
- When clarificationNeeded is true, ask one specific question and do not force a target.
- Use relations only to existing nodes in the supplied projection.
- Treat private context as unavailable; it should not be included in the supplied projection.
- A request for implementation is usually a Task. A possibility without authorized work is usually an Idea.
- Return concise human-readable rationale. Hidden reasoning is not evidence.`;

export interface PlacementParseResult {
  responseId: string;
  model: string;
  output: unknown;
}

export type PlacementParser = (input: {
  request: PlacementRequest;
  model: string;
}) => Promise<PlacementParseResult>;

export function createOpenAIPlacementParser(apiKey: string): PlacementParser {
  const client = new OpenAI({ apiKey });

  return async ({ request, model }) => {
    const response = await client.responses.parse({
      model,
      input: [
        {
          role: "system",
          content: PLACEMENT_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            source: request.source,
            baseRevisionId: request.baseRevisionId,
            projection: request.projection,
          }),
        },
      ],
      text: {
        format: zodTextFormat(
          ManagerPlacementInterpretationSchema,
          "worldstate_placement",
        ),
      },
      store: false,
    });

    return {
      responseId: response.id,
      model: response.model ?? model,
      output: response.output_parsed,
    };
  };
}

export class LivePlacementOutputError extends Error {
  constructor(
    readonly code:
      | "structured_output_missing"
      | "structured_output_invalid",
    message: string,
    readonly issues: readonly string[] = [],
    readonly responseId: string | null = null,
    readonly model: string | null = null,
  ) {
    super(message);
    this.name = "LivePlacementOutputError";
  }
}

export async function interpretLivePlacement(
  request: PlacementRequest,
  model: string,
  parser: PlacementParser,
): Promise<{
  interpretation: ManagerPlacementInterpretation;
  responseId: string;
  model: string;
}> {
  const parsedResponse = await parser({ request, model });

  if (parsedResponse.output === null || parsedResponse.output === undefined) {
    throw new LivePlacementOutputError(
      "structured_output_missing",
      "The placement model returned no structured placement output.",
      [],
      parsedResponse.responseId,
      parsedResponse.model,
    );
  }

  const interpretation = ManagerPlacementInterpretationSchema.safeParse(
    parsedResponse.output,
  );

  if (!interpretation.success) {
    throw new LivePlacementOutputError(
      "structured_output_invalid",
      "The placement model returned output that did not match the placement contract.",
      interpretation.error.issues.map(
        (issue) => `${issue.path.join(".") || "output"}: ${issue.message}`,
      ),
      parsedResponse.responseId,
      parsedResponse.model,
    );
  }

  return {
    interpretation: interpretation.data,
    responseId: parsedResponse.responseId,
    model: parsedResponse.model,
  };
}
