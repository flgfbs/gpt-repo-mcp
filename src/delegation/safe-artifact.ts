import { constants } from "node:fs";
import { chmod, lstat, open, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteJson, isAlreadyExistsError, isNotFoundError } from "../runtime/fs-helpers.js";

// Shared boundary for repository-owned delegation artifacts.
export async function readSafeRunArtifact(root: string, path: string, maxBytes: number): Promise<string | undefined> {
  const absolute = join(root, path);
  try {
    const [rootReal, targetReal, stat] = await Promise.all([realpath(root), realpath(absolute), lstat(absolute)]);
    if (!isWithin(rootReal, targetReal) || !stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw artifactError(path);
    }
    return await readFile(targetReal, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function assertSafeRunDirectory(root: string, path: string): Promise<void> {
  const absolute = join(root, path);
  const [rootReal, targetReal, stat] = await Promise.all([realpath(root), realpath(absolute), lstat(absolute)]);
  if (!isWithin(rootReal, targetReal) || !stat.isDirectory() || stat.isSymbolicLink()) throw artifactError(path);
}

export async function writeSafeRunJson(root: string, path: string, value: unknown): Promise<void> {
  await assertSafeRunDirectory(root, path.split("/").slice(0, -1).join("/"));
  const absolute = join(root, path);
  try {
    const [rootReal, targetReal, stat] = await Promise.all([realpath(root), realpath(absolute), lstat(absolute)]);
    if (!isWithin(rootReal, targetReal) || !stat.isFile() || stat.isSymbolicLink()) throw artifactError(path);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  await atomicWriteJson(absolute, value);
}

export async function writeExclusiveSafeRunJson(root: string, path: string, value: unknown): Promise<boolean> {
  const parentPath = path.split("/").slice(0, -1).join("/");
  await assertSafeRunDirectory(root, parentPath);
  const parentAbsolute = join(root, parentPath);
  const absolute = join(root, path);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await open(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(absolute, 0o600);
    await fsyncDirectory(parentAbsolute);
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) return false;
    // A post-create failure intentionally leaves evidence in place. Readers
    // reject incomplete or digest-mismatched bytes, preventing blind replay.
    throw error;
  }
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP") && !hasCode(error, "EISDIR")) throw error;
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function artifactError(path: string): RepoReaderError {
  return new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Runner artifact is missing, oversized, or unsafe.", {
    diagnostics: { path }
  });
}
