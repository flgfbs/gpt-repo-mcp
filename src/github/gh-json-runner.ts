import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { canonicalJson, GitHubBoundaryError, type JsonValue } from "./types.js";

export type GhInvocation = {
  args: readonly string[];
  stdinJson?: JsonValue;
};

export type GhRunResult = {
  exitCode?: number;
  signal?: NodeJS.Signals;
  spawned: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export interface GhJsonRunner {
  run(invocation: GhInvocation): Promise<GhRunResult>;
}

export class InstalledGhJsonRunner implements GhJsonRunner {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    private readonly cwd: string,
    baseEnvironment: NodeJS.ProcessEnv,
    private readonly timeoutMs = 30_000,
    private readonly maxOutputBytes = 2 * 1024 * 1024
  ) {
    if (!isAbsolute(cwd)) {
      throw new GitHubBoundaryError("GH_CWD_NOT_ABSOLUTE", "The gh working directory must be absolute.");
    }
    this.environment = installedGhEnvironment(baseEnvironment);
  }

  async run(invocation: GhInvocation): Promise<GhRunResult> {
    return await new Promise((resolve) => {
      const child = spawn("gh", [...invocation.args], {
        cwd: this.cwd,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let spawned = false;
      let timedOut = false;
      let settled = false;

      const append = (chunks: Buffer[], chunk: Buffer, current: number): number => {
        const remaining = this.maxOutputBytes - current;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        return current + Math.min(chunk.length, Math.max(remaining, 0));
      };

      child.once("spawn", () => { spawned = true; });
      child.stdout.on("data", (chunk: Buffer) => {
        const before = stdoutBytes;
        stdoutBytes = append(stdout, chunk, stdoutBytes);
        if (chunk.length > this.maxOutputBytes - before) {
          stdoutTruncated = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const before = stderrBytes;
        stderrBytes = append(stderr, chunk, stderrBytes);
        if (chunk.length > this.maxOutputBytes - before) {
          stderrTruncated = true;
          child.kill("SIGKILL");
        }
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutMs);

      const finish = (result: Pick<GhRunResult, "exitCode" | "signal">): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          ...result,
          spawned,
          timedOut,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutTruncated,
          stderrTruncated
        });
      };

      child.once("error", () => finish({}));
      child.once("close", (code, signal) => finish({
        ...(typeof code === "number" ? { exitCode: code } : {}),
        ...(signal ? { signal } : {})
      }));

      if (invocation.stdinJson === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(canonicalJson(invocation.stdinJson), "utf8");
      }
    });
  }
}

export function installedGhEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copiedKeys = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR"
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of copiedKeys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
    LC_ALL: "C"
  };
}
