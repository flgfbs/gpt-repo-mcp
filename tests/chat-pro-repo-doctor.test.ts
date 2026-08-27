import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runChatProRepoCli } from "../src/cli/chat-pro-repo.js";
import type { OwnerCliIo } from "../src/cli/cli-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("chat-pro-repo doctor", () => {
  test("checks private local state, fixed executables, and port 8789 without auth inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-pro-doctor-"));
    roots.push(root);
    const configPath = join(root, "config.local.json");
    await writeFile(configPath, `${JSON.stringify({
      repos: [],
      limits: {},
      runtime_root: join(root, "runtime-not-created")
    })}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
    const executableVersion = vi.fn(async (executable: string, args: string[]) => `${executable} ${args.join(" ")}`);
    const isPortAvailable = vi.fn(async () => true);
    const output = await runCli(root, configPath, {
      executableVersion,
      isPortAvailable
    });

    expect(output.code).toBe(0);
    expect(output.stdout).toContain("PASS configuration validated: 0 repository(s)");
    expect(output.stdout).toContain("PASS private configuration file: config.local.json");
    expect(output.stdout).toContain("INFO runtime root is absent");
    expect(output.stdout).toContain("PASS git available");
    expect(output.stdout).toContain("PASS gh available");
    expect(output.stdout).toContain("PASS loopback port 8789 is available");
    expect(output.stdout).toContain("INFO GitHub authentication was not inspected");
    expect(executableVersion.mock.calls).toEqual([
      ["git", ["--version"]],
      ["gh", ["--version"]]
    ]);
    expect(isPortAvailable).toHaveBeenCalledWith("127.0.0.1", 8789);
  });

  test("fails closed for a non-private configuration file", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-pro-doctor-"));
    roots.push(root);
    const configPath = join(root, "config.local.json");
    await writeFile(configPath, `${JSON.stringify({ repos: [], limits: {}, runtime_root: join(root, "runtime") })}\n`);
    await chmod(configPath, 0o644);
    const output = await runCli(root, configPath, {
      executableVersion: async () => "available",
      isPortAvailable: async () => true
    });

    expect(output.code).toBe(1);
    expect(output.stdout).toContain("FAIL configuration file must be an owner-only mode-0600 regular file");
  });
});

async function runCli(
  cwd: string,
  configPath: string,
  doctorChecks: {
    executableVersion: (executable: string, args: string[]) => Promise<string | undefined>;
    isPortAvailable: (host: string, port: number) => Promise<boolean>;
  }
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: OwnerCliIo = {
    cwd,
    env: {},
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
  const code = await runChatProRepoCli(["doctor", "--config", configPath], io, { doctorChecks });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
