import { constants } from "node:fs";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export async function atomicWriteFile(path: string, content: Buffer | string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    await fsyncDirectory(parent);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Publishing with link preserves create-only semantics while ensuring a
    // concurrent reader can observe only the complete, synchronized bytes.
    await link(tempPath, path);
    await rm(tempPath, { force: true });
    await fsyncDirectory(parent);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isNotFoundError(error: unknown): boolean {
  return hasFsErrorCode(error, "ENOENT");
}

export function isAlreadyExistsError(error: unknown): boolean {
  return hasFsErrorCode(error, "EEXIST");
}

function hasFsErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === code
  );
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (
      !hasFsErrorCode(error, "EINVAL")
      && !hasFsErrorCode(error, "ENOTSUP")
      && !hasFsErrorCode(error, "EISDIR")
    ) throw error;
  } finally {
    await handle.close();
  }
}
