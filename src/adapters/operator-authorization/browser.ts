"use client";

const OPERATOR_BEARER_MIN_BYTES = 32;
const OPERATOR_BEARER_MAX_BYTES = 16 * 1_024;

export type OperatorCredentialProvider = () => string | null;

export class OperatorCredentialUnavailableError extends Error {
  constructor() {
    super("Transient operator authority is not available in browser memory.");
    this.name = "OperatorCredentialUnavailableError";
  }
}

let memoryOnlyCredential: string | null = null;

function validCredential(value: string | null): value is string {
  if (!value || /[\s,]/u.test(value)) return false;
  const byteLength = new TextEncoder().encode(value).byteLength;
  return (
    byteLength >= OPERATOR_BEARER_MIN_BYTES &&
    byteLength <= OPERATOR_BEARER_MAX_BYTES
  );
}

/** Replaces the process-memory-only operator credential; it is never persisted. */
export function setMemoryOnlyOperatorCredential(credential: string): void {
  if (!validCredential(credential)) {
    throw new OperatorCredentialUnavailableError();
  }
  memoryOnlyCredential = credential;
}

export function clearMemoryOnlyOperatorCredential(): void {
  memoryOnlyCredential = null;
}

export const memoryOnlyOperatorCredentialProvider: OperatorCredentialProvider =
  () => memoryOnlyCredential;

export function operatorAuthorizationHeaders(
  provider: OperatorCredentialProvider = memoryOnlyOperatorCredentialProvider,
  headers: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const credential = provider();
  if (!validCredential(credential)) {
    throw new OperatorCredentialUnavailableError();
  }
  return { ...headers, authorization: `Bearer ${credential}` };
}
