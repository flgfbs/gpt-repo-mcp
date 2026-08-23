import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskRuntimeError } from "./errors.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type ManagedDirectoryEntry = {
  name: string;
  kind: "file" | "directory" | "symlink" | "unsupported";
};

export class SecureRuntimeFs {
  readonly root: string;

  constructor(runtimeRoot: string) {
    if (!isAbsolute(runtimeRoot)) {
      throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "RUNTIME_ROOT must be absolute.");
    }
    this.root = resolve(runtimeRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    await assertPrivateDirectory(this.root);
  }

  absolutePath(relativePath: string): string {
    const safe = validateManagedRelativePath(relativePath);
    const absolute = resolve(this.root, safe);
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (absolute !== this.root && !absolute.startsWith(prefix)) {
      throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "Managed path escapes RUNTIME_ROOT.");
    }
    return absolute;
  }

  async ensureDirectory(relativePath: string): Promise<string> {
    await this.initialize();
    const safe = validateManagedRelativePath(relativePath);
    if (safe === ".") return this.root;
    let current = this.root;
    for (const segment of safe.split("/")) {
      current = join(current, segment);
      try {
        await mkdir(current, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      await assertPrivateDirectory(current);
    }
    return current;
  }

  async assertDirectory(relativePath: string): Promise<string> {
    await this.initialize();
    const safe = validateManagedRelativePath(relativePath);
    if (safe === ".") return this.root;
    let current = this.root;
    for (const segment of safe.split("/")) {
      current = join(current, segment);
      await assertPrivateDirectory(current);
    }
    return current;
  }

  async atomicWrite(relativePath: string, content: Buffer | string, options: { exclusive?: boolean } = {}): Promise<void> {
    const safe = validateManagedRelativePath(relativePath);
    if (safe === ".") throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "A runtime file path is required.");
    const parent = posix.dirname(safe);
    const parentAbsolute = await this.ensureDirectory(parent);
    const target = this.absolutePath(safe);
    await assertExistingTargetSafeOrAbsent(target);
    const temporary = join(parentAbsolute, `.tmp-${process.pid}-${randomUUID()}`);
    let createdTarget = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporary, FILE_MODE);
      if (options.exclusive) {
        await link(temporary, target);
        createdTarget = true;
        await unlink(temporary);
      } else {
        await rename(temporary, target);
        createdTarget = true;
      }
      await chmod(target, FILE_MODE);
      await fsyncDirectory(parentAbsolute);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (createdTarget) await fsyncDirectory(parentAbsolute).catch(() => undefined);
      throw error;
    }
  }

  async readFile(relativePath: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "maxBytes must be a non-negative safe integer.");
    }
    const safe = validateManagedRelativePath(relativePath);
    const parent = posix.dirname(safe);
    await this.assertDirectory(parent);
    const absolute = this.absolutePath(safe);
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(absolute, flags);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw unsafeFile(relativePath);
      if (metadata.size > maxBytes) {
        throw new TaskRuntimeError("RUNTIME_SIZE_LIMIT", "Runtime file exceeds the bounded read limit.", {
          path: relativePath,
          max_bytes: maxBytes,
          size: metadata.size
        });
      }
      return await handle.readFile();
    } catch (error) {
      if (hasCode(error, "ELOOP")) throw unsafeFile(relativePath);
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async listDirectory(relativePath: string, maxEntries: number): Promise<ManagedDirectoryEntry[]> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
      throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "maxEntries must be an integer between 1 and 10000.");
    }
    const absolute = await this.assertDirectory(relativePath);
    const entries: ManagedDirectoryEntry[] = [];
    const directory = await opendir(absolute);
    for await (const entry of directory) {
      if (entries.length >= maxEntries) {
        throw new TaskRuntimeError("RUNTIME_SIZE_LIMIT", "Runtime directory exceeds the bounded entry limit.", {
          path: relativePath,
          max_entries: maxEntries
        });
      }
      entries.push({
        name: entry.name,
        kind: entry.isFile()
          ? "file"
          : entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : "unsupported"
      });
    }
    return entries;
  }

  async removeDirectory(relativePath: string): Promise<void> {
    const safe = validateManagedRelativePath(relativePath);
    if (safe === ".") throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "RUNTIME_ROOT cannot be removed.");
    const absolute = this.absolutePath(safe);
    const metadata = await lstat(absolute);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unsafeFile(relativePath);
    await rm(absolute, { recursive: true, force: false });
  }

  async removeFile(relativePath: string): Promise<void> {
    const safe = validateManagedRelativePath(relativePath);
    if (safe === ".") throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "A runtime file path is required.");
    const parent = posix.dirname(safe);
    const parentAbsolute = await this.assertDirectory(parent);
    const absolute = this.absolutePath(safe);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw unsafeFile(relativePath);
    await unlink(absolute);
    await fsyncDirectory(parentAbsolute);
  }

}

export function validateManagedRelativePath(value: string): string {
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "Managed paths must be portable relative paths.");
  }
  const normalized = posix.normalize(value || ".");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "Managed path traversal is not allowed.");
  }
  return normalized.replace(/^\.\//, "");
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "Runtime directories must be real directories, not symlinks.", { path });
  }
  if ((metadata.mode & 0o777) !== DIRECTORY_MODE) await chmod(path, DIRECTORY_MODE);
}

async function assertExistingTargetSafeOrAbsent(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw unsafeFile(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
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

function unsafeFile(path: string): TaskRuntimeError {
  return new TaskRuntimeError("RUNTIME_FILE_UNSAFE", "Runtime files must be private regular files, not symlinks.", { path });
}

export function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
