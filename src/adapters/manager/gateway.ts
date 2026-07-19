import { interpretFixturePlacement } from "./fixture";
import {
  createOpenAIPlacementParser,
  interpretLivePlacement,
  LIVE_PLACEMENT_PROVIDER_TIMEOUT_MS,
  LivePlacementConfigurationError,
  LivePlacementDeadlineExceededError,
  LivePlacementOutputError,
  type PlacementParser,
  withLivePlacementDeadline,
} from "./live";
import {
  freezePlacementArtifact,
  materializePlacementProposal,
  PlacementInterpretationError,
} from "./proposal";
import {
  ManagerModeSchema,
  PlacementErrorResponseSchema,
  PlacementRequestSchema,
  PlacementSuccessResponseSchema,
  type PlacementErrorCode,
  type PlacementErrorResponse,
  type PlacementRequest,
  type PlacementResponse,
} from "./schema";

const DEFAULT_MODEL = "gpt-5.6";

export interface ManagerEnvironment {
  [key: string]: string | undefined;
  ODEU_MANAGER_MODE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

export interface PlacementGatewayDependencies {
  environment?: ManagerEnvironment;
  liveParser?: PlacementParser;
  liveTimeoutMs?: number;
}

export interface PlacementGatewayResult {
  status: number;
  body: PlacementResponse;
}

function issueMessages(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
  );
}

function errorResult(input: {
  status: number;
  requestedMode: string;
  effectiveMode: "fixture" | "live" | null;
  runtimeStatus: "unavailable" | "failed";
  provider: "fixture" | "openai" | null;
  model: string | null;
  responseId?: string | null;
  code: PlacementErrorCode;
  message: string;
  retryable: boolean;
  issues?: readonly string[];
}): PlacementGatewayResult {
  const body: PlacementErrorResponse = PlacementErrorResponseSchema.parse({
    ok: false,
    manager: {
      requestedMode: input.requestedMode,
      effectiveMode: input.effectiveMode,
      status: input.runtimeStatus,
      provider: input.provider,
      model: input.model,
      responseId: input.responseId ?? null,
    },
    sourcePreserved: true,
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      issues: [...(input.issues ?? [])],
    },
  });

  return { status: input.status, body };
}

function requestMode(environment: ManagerEnvironment): string {
  return environment.ODEU_MANAGER_MODE?.trim().toLowerCase() || "fixture";
}

async function runPlacement(
  request: PlacementRequest,
  dependencies: PlacementGatewayDependencies,
): Promise<PlacementGatewayResult> {
  const environment = dependencies.environment ?? process.env;
  const requestedMode = requestMode(environment);
  const parsedMode = ManagerModeSchema.safeParse(requestedMode);

  if (!parsedMode.success) {
    return errorResult({
      status: 503,
      requestedMode,
      effectiveMode: null,
      runtimeStatus: "unavailable",
      provider: null,
      model: null,
      code: "invalid_manager_mode",
      message: `Manager mode ${requestedMode} is not supported. Use fixture or live.`,
      retryable: false,
    });
  }

  if (parsedMode.data === "fixture") {
    const interpretation = interpretFixturePlacement(request);
    const proposal = materializePlacementProposal(request, interpretation);
    const body = PlacementSuccessResponseSchema.parse({
      ok: true,
      manager: {
        requestedMode,
        effectiveMode: "fixture",
        status: "available",
        provider: "fixture",
        model: null,
        responseId: null,
      },
      ...proposal,
    });

    return { status: 200, body: freezePlacementArtifact(body) };
  }

  const model = environment.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const apiKey = environment.OPENAI_API_KEY?.trim();

  if (!apiKey && !dependencies.liveParser) {
    return errorResult({
      status: 503,
      requestedMode,
      effectiveMode: null,
      runtimeStatus: "unavailable",
      provider: "openai",
      model,
      code: "live_credentials_missing",
      message:
        "Live manager mode is unavailable because OPENAI_API_KEY is not configured.",
      retryable: false,
    });
  }

  let responseId: string | null = null;
  let responseModel = model;

  try {
    const parser =
      dependencies.liveParser ?? createOpenAIPlacementParser(apiKey as string);
    const timeoutMs =
      dependencies.liveTimeoutMs ?? LIVE_PLACEMENT_PROVIDER_TIMEOUT_MS;
    const liveResult = await withLivePlacementDeadline(
      (signal) =>
        interpretLivePlacement(request, model, parser, {
          signal,
          timeoutMs,
        }),
      timeoutMs,
    );
    responseId = liveResult.responseId;
    responseModel = liveResult.model;
    const proposal = materializePlacementProposal(
      request,
      liveResult.interpretation,
    );
    const body = PlacementSuccessResponseSchema.parse({
      ok: true,
      manager: {
        requestedMode,
        effectiveMode: "live",
        status: "available",
        provider: "openai",
        model: liveResult.model,
        responseId: liveResult.responseId,
      },
      ...proposal,
    });

    return { status: 200, body: freezePlacementArtifact(body) };
  } catch (error) {
    if (error instanceof LivePlacementConfigurationError) {
      return errorResult({
        status: 503,
        requestedMode,
        effectiveMode: null,
        runtimeStatus: "unavailable",
        provider: "openai",
        model,
        responseId,
        code: "live_configuration_invalid",
        message: error.message,
        retryable: false,
      });
    }

    if (error instanceof LivePlacementDeadlineExceededError) {
      return errorResult({
        status: 504,
        requestedMode,
        effectiveMode: "live",
        runtimeStatus: "failed",
        provider: "openai",
        model,
        responseId,
        code: "provider_timed_out",
        message:
          "The live placement request exceeded its configured provider deadline. The captured source remains available for retry or manual placement.",
        retryable: true,
      });
    }

    if (error instanceof LivePlacementOutputError) {
      return errorResult({
        status: 502,
        requestedMode,
        effectiveMode: "live",
        runtimeStatus: "failed",
        provider: "openai",
        model: error.model ?? model,
        responseId: error.responseId ?? responseId,
        code: error.code,
        message: error.message,
        retryable: true,
        issues: error.issues,
      });
    }

    if (error instanceof PlacementInterpretationError) {
      return errorResult({
        status: 422,
        requestedMode,
        effectiveMode: "live",
        runtimeStatus: "failed",
        provider: "openai",
        model: responseModel,
        responseId,
        code: error.code,
        message: error.message,
        retryable: true,
      });
    }

    return errorResult({
      status: 502,
      requestedMode,
      effectiveMode: "live",
      runtimeStatus: "failed",
      provider: "openai",
      model,
      responseId,
      code: "provider_request_failed",
      message:
        "The live placement request failed. The captured source remains available for retry or manual placement.",
      retryable: true,
    });
  }
}

export async function placeSource(
  input: unknown,
  dependencies: PlacementGatewayDependencies = {},
): Promise<PlacementGatewayResult> {
  const environment = dependencies.environment ?? process.env;
  const requestedMode = requestMode(environment);
  const request = PlacementRequestSchema.safeParse(input);

  if (!request.success) {
    return errorResult({
      status: 400,
      requestedMode,
      effectiveMode: null,
      runtimeStatus: "unavailable",
      provider: null,
      model: null,
      code: "invalid_request",
      message: "The placement request does not match the gateway contract.",
      retryable: false,
      issues: issueMessages(request.error),
    });
  }

  return runPlacement(request.data, dependencies);
}

export function invalidJsonPlacementResponse(
  environment: ManagerEnvironment = process.env,
): PlacementGatewayResult {
  return errorResult({
    status: 400,
    requestedMode: requestMode(environment),
    effectiveMode: null,
    runtimeStatus: "unavailable",
    provider: null,
    model: null,
    code: "invalid_json",
    message: "The placement request body must be valid JSON.",
    retryable: false,
  });
}
