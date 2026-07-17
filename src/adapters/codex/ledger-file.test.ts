import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthoritativeLedgerSymlinkError,
  resolveAuthoritativeLedgerFilePath,
} from "./ledger-file";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "odeu-ledger-path-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("authoritative Codex ledger path", () => {
  it("returns the configured path so an atomic replacement remains observable", async () => {
    const directory = await makeTemporaryDirectory();
    const ledgerPath = join(directory, "worldstate.json");
    const replacementPath = join(directory, "worldstate.next.json");
    await writeFile(ledgerPath, "old ledger", "utf8");

    const validatedPath = await resolveAuthoritativeLedgerFilePath(ledgerPath);
    await writeFile(replacementPath, "new ledger", "utf8");
    await rename(replacementPath, ledgerPath);

    expect(validatedPath).toBe(ledgerPath);
    await expect(readFile(validatedPath, "utf8")).resolves.toBe("new ledger");
  });

  it("rejects a symlinked ledger file", async () => {
    const directory = await makeTemporaryDirectory();
    const targetPath = join(directory, "worldstate.target.json");
    const configuredPath = join(directory, "worldstate.json");
    await writeFile(targetPath, "ledger", "utf8");
    await symlink(targetPath, configuredPath, "file");

    await expect(
      resolveAuthoritativeLedgerFilePath(configuredPath),
    ).rejects.toMatchObject({
      name: "AuthoritativeLedgerSymlinkError",
      configuredPath,
      resolvedPath: targetPath,
    });
    await expect(
      resolveAuthoritativeLedgerFilePath(configuredPath),
    ).rejects.toBeInstanceOf(AuthoritativeLedgerSymlinkError);
  });

  it("rejects a ledger reached through a symlinked parent directory", async () => {
    const directory = await makeTemporaryDirectory();
    const ledgerDirectory = join(directory, "ledger-storage");
    const configuredDirectory = join(directory, "configured-storage");
    const resolvedPath = join(ledgerDirectory, "worldstate.json");
    const configuredPath = join(configuredDirectory, "worldstate.json");
    await mkdir(ledgerDirectory);
    await writeFile(resolvedPath, "ledger", "utf8");
    await symlink(ledgerDirectory, configuredDirectory, "dir");

    await expect(
      resolveAuthoritativeLedgerFilePath(configuredPath),
    ).rejects.toMatchObject({
      name: "AuthoritativeLedgerSymlinkError",
      configuredPath,
      resolvedPath,
    });
  });
});
