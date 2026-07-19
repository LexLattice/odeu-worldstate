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
- Propose delegationProfileId moving-cost-contract-v1 only when the Task appears to fit that registered moving-cost contract; otherwise return null. The visible ID is a host-bounded proposal, not execution authority, and a later compiler rechecks it against canonical topology.
- Return concise human-readable rationale. Hidden reasoning is not evidence.`;

export interface PlacementParseResult {
  responseId: string;
  model: string;
  output: unknown;
}

export const LIVE_PLACEMENT_PROVIDER_TIMEOUT_MS = 2 * 60 * 1_000;
export const MAX_LIVE_PLACEMENT_PROVIDER_TIMEOUT_MS = 2_147_483_647;

export class LivePlacementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LivePlacementConfigurationError";
  }
}

export class LivePlacementDeadlineExceededError extends Error {
  constructor(
    readonly timeoutMs: number,
    options: ErrorOptions = {},
  ) {
    super(
      `The live placement request exceeded its ${timeoutMs} ms provider deadline.`,
      options,
    );
    this.name = "LivePlacementDeadlineExceededError";
  }
}

export type PlacementParser = (input: {
  request: PlacementRequest;
  model: string;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<PlacementParseResult>;

export async function withLivePlacementDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = LIVE_PLACEMENT_PROVIDER_TIMEOUT_MS,
): Promise<T> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_LIVE_PLACEMENT_PROVIDER_TIMEOUT_MS
  ) {
    throw new LivePlacementConfigurationError(
      `The live placement provider deadline must be an integer from 1 through ${MAX_LIVE_PLACEMENT_PROVIDER_TIMEOUT_MS} milliseconds.`,
    );
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new LivePlacementDeadlineExceededError(timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  timer?.unref();

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createOpenAIPlacementParser(apiKey: string): PlacementParser {
  const client = new OpenAI({ apiKey });

  return async ({ request, model, signal, timeoutMs }) => {
    let response;
    try {
      response = await client.responses.parse(
        {
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
        },
        {
          signal,
          timeout: timeoutMs,
          maxRetries: 0,
        },
      );
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new LivePlacementDeadlineExceededError(timeoutMs, {
          cause: error,
        });
      }
      throw error;
    }

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
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<{
  interpretation: ManagerPlacementInterpretation;
  responseId: string;
  model: string;
}> {
  const parsedResponse = await parser({ request, model, ...options });

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
