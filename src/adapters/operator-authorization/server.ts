import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

const OPERATOR_BEARER_MIN_BYTES = 32;
const OPERATOR_BEARER_MAX_BYTES = 16 * 1_024;

export type OperatorAuthorizationErrorCode =
  | "operator_auth_unavailable"
  | "operator_unauthorized"
  | "operator_cross_origin";

export class OperatorAuthorizationError extends Error {
  constructor(readonly code: OperatorAuthorizationErrorCode) {
    super(
      code === "operator_auth_unavailable"
        ? "The operator authorization boundary is unavailable."
        : code === "operator_cross_origin"
          ? "The operator request was not made from the configured same origin."
          : "Valid transient operator authority is required.",
    );
    this.name = "OperatorAuthorizationError";
  }
}

export interface OperatorAuthorizationOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PublicOperatorAuthorizationFailure {
  readonly status: 401 | 403 | 503;
  readonly body: {
    readonly error: {
      readonly code: OperatorAuthorizationErrorCode;
      readonly message: string;
    };
  };
  readonly headers: Readonly<Record<string, string>>;
}

function configuredOrigin(value: string | undefined): string {
  if (!value) throw new OperatorAuthorizationError("operator_auth_unavailable");
  try {
    const url = new URL(value);
    const loopbackHost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.protocol === "http:" && !loopbackHost) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("not an origin");
    }
    return url.origin;
  } catch (cause) {
    if (cause instanceof OperatorAuthorizationError) throw cause;
    throw new OperatorAuthorizationError("operator_auth_unavailable");
  }
}

function configuredSecret(value: string | undefined): string {
  const byteLength = value ? Buffer.byteLength(value, "utf8") : 0;
  if (
    !value ||
    /[\s,]/u.test(value) ||
    byteLength < OPERATOR_BEARER_MIN_BYTES ||
    byteLength > OPERATOR_BEARER_MAX_BYTES
  ) {
    throw new OperatorAuthorizationError("operator_auth_unavailable");
  }
  return value;
}

function presentedBearer(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > OPERATOR_BEARER_MAX_BYTES + 16) {
    return null;
  }
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  const bearer = match?.[1] ?? null;
  return bearer && Buffer.byteLength(bearer, "utf8") <= OPERATOR_BEARER_MAX_BYTES
    ? bearer
    : null;
}

function secretsEqual(presented: string, configured: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const configuredDigest = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(presentedDigest, configuredDigest);
}

/**
 * Enforces the browser operator boundary before a privileged route reads a body,
 * inspects private status, executes candidate code, or mutates an external ref.
 * The credential is accepted only as an Authorization header. Browser Fetch
 * Metadata and Origin are checked independently so the bearer is not a CSRF
 * substitute and a cross-origin caller fails before privileged work begins.
 */
export function requireOperatorAuthorization(
  request: Request,
  options: OperatorAuthorizationOptions = {},
): void {
  const env = options.env ?? process.env;
  const expectedOrigin = configuredOrigin(env.ODEU_OPERATOR_ALLOWED_ORIGIN);
  const expectedSecret = configuredSecret(env.ODEU_OPERATOR_BEARER_SECRET);

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw new OperatorAuthorizationError("operator_cross_origin");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(
    request.method.toUpperCase(),
  );
  if (
    requestOrigin !== expectedOrigin ||
    fetchSite !== "same-origin" ||
    (origin !== null && origin !== expectedOrigin) ||
    (unsafeMethod && origin !== expectedOrigin)
  ) {
    throw new OperatorAuthorizationError("operator_cross_origin");
  }

  const bearer = presentedBearer(request);
  if (!bearer || !secretsEqual(bearer, expectedSecret)) {
    throw new OperatorAuthorizationError("operator_unauthorized");
  }
}

export function publicOperatorAuthorizationFailure(
  error: OperatorAuthorizationError,
): PublicOperatorAuthorizationFailure {
  const status =
    error.code === "operator_auth_unavailable"
      ? 503
      : error.code === "operator_cross_origin"
        ? 403
        : 401;
  return {
    status,
    body: {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    headers: {
      "cache-control": "no-store",
      ...(status === 401
        ? { "www-authenticate": 'Bearer realm="odeu-operator"' }
        : {}),
    },
  };
}

export function operatorAuthorizationFailureResponse(
  error: OperatorAuthorizationError,
): Response {
  const failure = publicOperatorAuthorizationFailure(error);
  return Response.json(failure.body, {
    status: failure.status,
    headers: failure.headers,
  });
}
