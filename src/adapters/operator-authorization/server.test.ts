import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  OperatorAuthorizationError,
  publicOperatorAuthorizationFailure,
  requireOperatorAuthorization,
} from "./server";

const SECRET = "operator-test-secret-that-is-long-enough";
const ENV = {
  ODEU_OPERATOR_ALLOWED_ORIGIN: "https://odeu.example",
  ODEU_OPERATOR_BEARER_SECRET: SECRET,
};

function request(input: {
  readonly origin?: string | null;
  readonly site?: string | null;
  readonly token?: string | null;
  readonly method?: string;
  readonly url?: string;
} = {}): Request {
  const headers = new Headers();
  if (input.origin !== null) {
    headers.set("origin", input.origin ?? "https://odeu.example");
  }
  if (input.site !== null) {
    headers.set("sec-fetch-site", input.site ?? "same-origin");
  }
  if (input.token !== null) {
    headers.set("authorization", `Bearer ${input.token ?? SECRET}`);
  }
  return new Request(input.url ?? "https://odeu.example/api/privileged", {
    method: input.method ?? "POST",
    headers,
  });
}

describe("transient operator authorization", () => {
  it("accepts only the configured bearer from the exact browser origin", () => {
    expect(() => requireOperatorAuthorization(request(), { env: ENV })).not.toThrow();
  });

  it.each([
    ["missing bearer", request({ token: null }), "operator_unauthorized"],
    ["wrong bearer", request({ token: `${SECRET}-wrong` }), "operator_unauthorized"],
    ["cross-site metadata", request({ site: "cross-site" }), "operator_cross_origin"],
    ["missing metadata", request({ site: null }), "operator_cross_origin"],
    ["wrong Origin", request({ origin: "https://attacker.example" }), "operator_cross_origin"],
    ["missing POST Origin", request({ origin: null }), "operator_cross_origin"],
    [
      "wrong request origin",
      request({ url: "https://internal.example/api/privileged" }),
      "operator_cross_origin",
    ],
  ])("rejects %s", (_label, observed, code) => {
    expect(() =>
      requireOperatorAuthorization(observed as Request, { env: ENV }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("allows a same-origin credentialed status GET without an Origin header", () => {
    expect(() =>
      requireOperatorAuthorization(
        request({ method: "GET", origin: null }),
        { env: ENV },
      ),
    ).not.toThrow();
  });

  it("fails closed when operator configuration is absent and never reflects secrets", () => {
    let failure;
    try {
      requireOperatorAuthorization(request(), { env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorAuthorizationError);
      failure = publicOperatorAuthorizationFailure(
        error as OperatorAuthorizationError,
      );
    }
    expect(failure).toMatchObject({
      status: 503,
      body: { error: { code: "operator_auth_unavailable" } },
    });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  it("treats an unusable bearer grammar as unavailable configuration", () => {
    expect(() =>
      requireOperatorAuthorization(request(), {
        env: { ...ENV, ODEU_OPERATOR_BEARER_SECRET: `${SECRET} invalid` },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "operator_auth_unavailable" }),
    );
  });

  it("requires HTTPS except for an exact loopback origin", () => {
    expect(() =>
      requireOperatorAuthorization(
        request({
          origin: "http://odeu.example",
          url: "http://odeu.example/api/privileged",
        }),
        {
          env: {
            ...ENV,
            ODEU_OPERATOR_ALLOWED_ORIGIN: "http://odeu.example",
          },
        },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "operator_auth_unavailable" }),
    );
    expect(() =>
      requireOperatorAuthorization(
        request({ origin: "http://localhost", url: "http://localhost/api" }),
        {
          env: {
            ...ENV,
            ODEU_OPERATOR_ALLOWED_ORIGIN: "http://localhost",
          },
        },
      ),
    ).not.toThrow();
  });
});
