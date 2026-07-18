import { afterEach, describe, expect, it } from "vitest";

import {
  OperatorCredentialUnavailableError,
  clearMemoryOnlyOperatorCredential,
  operatorAuthorizationHeaders,
  setMemoryOnlyOperatorCredential,
} from "./browser";

const SECRET = "operator-browser-secret-that-is-long-enough";

describe("memory-only operator credential", () => {
  afterEach(() => clearMemoryOnlyOperatorCredential());

  it("materializes the credential only as an Authorization header", () => {
    setMemoryOnlyOperatorCredential(SECRET);
    expect(operatorAuthorizationHeaders(undefined, { accept: "application/json" })).toEqual({
      accept: "application/json",
      authorization: `Bearer ${SECRET}`,
    });
  });

  it("fails closed when no valid credential is present", () => {
    expect(() => operatorAuthorizationHeaders()).toThrow(
      OperatorCredentialUnavailableError,
    );
    expect(() => setMemoryOnlyOperatorCredential("too-short")).toThrow(
      OperatorCredentialUnavailableError,
    );
  });
});
