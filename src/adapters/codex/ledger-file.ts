import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export class AuthoritativeLedgerSymlinkError extends Error {
  constructor(
    readonly configuredPath: string,
    readonly resolvedPath: string,
  ) {
    super(
      `The authoritative Codex ledger path ${configuredPath} resolves to ${resolvedPath}; the ledger file and all of its parent directories must not be symlinks.`,
    );
    this.name = "AuthoritativeLedgerSymlinkError";
  }
}

/**
 * Validates that the configured ledger path names the file directly rather
 * than through a file or parent-directory symlink. Returning the configured
 * path (instead of pinning its current realpath target) ensures later atomic
 * replacement at that path is observed by every ledger read.
 */
export async function resolveAuthoritativeLedgerFilePath(
  configuredPath: string,
): Promise<string> {
  const absoluteConfiguredPath = resolve(configuredPath);
  const resolvedPath = await realpath(absoluteConfiguredPath);

  if (resolvedPath !== absoluteConfiguredPath) {
    throw new AuthoritativeLedgerSymlinkError(
      absoluteConfiguredPath,
      resolvedPath,
    );
  }

  return absoluteConfiguredPath;
}
