import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { hashedDiskKey } from "./canonical-json.js";
import { TaskRuntimeError } from "./errors.js";
import { hasCode, SecureRuntimeFs } from "./secure-runtime-fs.js";

const LockOwnerSchema = z.object({
  schema_version: z.literal(1),
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  hostname: z.string().min(1).max(255),
  acquired_at: z.string().datetime()
}).strict();

type LockOwner = z.infer<typeof LockOwnerSchema>;

export type CrossProcessLockOptions = {
  timeoutMs?: number;
  pollMs?: number;
  staleMs?: number;
  now?: () => Date;
};

export class CrossProcessLockManager {
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly staleMs: number;
  private readonly now: () => Date;

  constructor(private readonly fs: SecureRuntimeFs, options: CrossProcessLockOptions = {}) {
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 1, 60_000, "timeoutMs");
    this.pollMs = boundedInteger(options.pollMs ?? 25, 1, 1_000, "pollMs");
    this.staleMs = boundedInteger(options.staleMs ?? 30_000, 1_000, 86_400_000, "staleMs");
    this.now = options.now ?? (() => new Date());
  }

  async withLock<T>(lockId: string, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(lockId);
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async acquire(lockId: string): Promise<() => Promise<void>> {
    await this.fs.ensureDirectory("locks");
    const lockName = `${hashedDiskKey("lock", lockId)}.lock`;
    const relative = posix.join("locks", lockName);
    const absolute = this.fs.absolutePath(relative);
    const deadline = Date.now() + this.timeoutMs;
    const owner: LockOwner = {
      schema_version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      acquired_at: this.now().toISOString()
    };

    while (true) {
      try {
        await mkdir(absolute, { mode: 0o700 });
        await this.fs.atomicWrite(posix.join(relative, "owner.json"), `${JSON.stringify(owner)}\n`, { exclusive: true });
        return async () => this.release(relative, owner.token);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          await rm(absolute, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }

      if (await this.reclaimIfDefinitelyStale(relative)) continue;
      if (Date.now() >= deadline) {
        throw new TaskRuntimeError("LOCK_TIMEOUT", "Timed out waiting for the bounded cross-process task lock.", {
          lock_key: hashedDiskKey("lock", lockId),
          timeout_ms: this.timeoutMs
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.pollMs, Math.max(1, deadline - Date.now()))));
    }
  }

  private async release(relative: string, token: string): Promise<void> {
    const owner = await this.readOwner(relative);
    if (!owner || owner.token !== token) {
      throw new TaskRuntimeError("RUNTIME_FILE_UNSAFE", "Task lock ownership changed before release.");
    }
    await this.fs.removeDirectory(relative);
  }

  private async reclaimIfDefinitelyStale(relative: string): Promise<boolean> {
    const absolute = this.fs.absolutePath(relative);
    let stale = false;
    const owner = await this.readOwner(relative);
    if (owner) {
      const age = this.now().getTime() - new Date(owner.acquired_at).getTime();
      stale = age >= this.staleMs && owner.hostname === hostname() && !isProcessAlive(owner.pid);
    } else {
      try {
        const metadata = await lstat(absolute);
        stale = metadata.isDirectory() && !metadata.isSymbolicLink() && this.now().getTime() - metadata.mtimeMs >= this.staleMs;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return true;
        throw error;
      }
    }
    if (!stale) return false;

    const tombstoneRelative = posix.join("locks", `.stale-${hashedDiskKey("stale-lock", `${relative}:${randomUUID()}`)}`);
    try {
      await rename(absolute, this.fs.absolutePath(tombstoneRelative));
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "EEXIST")) return true;
      throw error;
    }
    await rm(this.fs.absolutePath(tombstoneRelative), { recursive: true, force: true });
    return true;
  }

  private async readOwner(relative: string): Promise<LockOwner | undefined> {
    try {
      const raw = await this.fs.readFile(posix.join(relative, "owner.json"), 8 * 1024);
      return LockOwnerSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      if (hasCode(error, "ENOENT") || error instanceof SyntaxError || error instanceof z.ZodError) return undefined;
      throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TaskRuntimeError("TASK_RUNTIME_INVALID", `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
