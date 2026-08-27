import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ParsedRepoReaderConfig } from "../config/schema.js";
import { readConfigDocument } from "../config/store.js";
import { validateConfigDocument } from "../config/validation.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import type { OwnerCliIo } from "./cli-types.js";

const execFileAsync = promisify(execFile);

export type OwnerDoctorChecks = {
  executableVersion: (executable: string, args: string[]) => Promise<string | undefined>;
  isPortAvailable: (host: string, port: number) => Promise<boolean>;
  inspectPrivatePath: (path: string, kind: "file" | "directory") => Promise<"private" | "missing" | "unsafe">;
  executableIsUsable: (path: string) => Promise<boolean>;
};

export async function runOwnerDoctor(
  configPath: string,
  io: OwnerCliIo,
  overrides: Partial<OwnerDoctorChecks> = {}
): Promise<number> {
  const checks = { ...defaultDoctorChecks(), ...overrides };
  let failed = false;
  const pass = (message: string) => io.stdout(`PASS ${message}`);
  const info = (message: string) => io.stdout(`INFO ${message}`);
  const fail = (message: string) => {
    failed = true;
    io.stdout(`FAIL ${message}`);
  };

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (nodeMajor >= 20) pass(`Node.js ${process.versions.node}`);
  else fail("Node.js 20 or newer is required");

  let config: ParsedRepoReaderConfig | undefined;
  try {
    const document = await readConfigDocument(configPath);
    const validation = await validateConfigDocument(document);
    if (validation.issues.length > 0 || !validation.config) {
      fail(`configuration invalid: ${validation.issues.length} issue(s)`);
      for (const issue of validation.issues) io.stdout(`FAIL [${issue.code}] ${issue.message}`);
    } else {
      config = validation.config;
      pass(`configuration validated: ${config.repos.length} repository(s)`);
    }
  } catch (error) {
    fail(isNotFoundError(error) ? "configuration file is missing" : "configuration file is unreadable");
  }

  const configPrivacy = await checks.inspectPrivatePath(configPath, "file");
  if (configPrivacy === "private") pass(`private configuration file: ${basename(configPath)}`);
  else if (configPrivacy === "missing") fail("configuration privacy unavailable because the file is missing");
  else fail("configuration file must be an owner-only mode-0600 regular file");

  const runtimeRoot = config?.runtime_root;
  if (runtimeRoot) {
    const runtimePrivacy = await checks.inspectPrivatePath(runtimeRoot, "directory");
    if (runtimePrivacy === "private") pass("runtime root is owner-only mode 0700");
    else if (runtimePrivacy === "missing") info("runtime root is absent; no durable runtime state exists yet");
    else fail("runtime root must be an owner-only mode-0700 real directory");
  }

  for (const [name, executable, args] of [
    ["git", "git", ["--version"]],
    ["gh", "gh", ["--version"]]
  ] as const) {
    const version = await checks.executableVersion(executable, [...args]);
    if (version) pass(`${name} available: ${firstLine(version)}`);
    else fail(`${name} executable is unavailable`);
  }

  const profileExecutables = configuredExecutables(config);
  for (const executable of profileExecutables) {
    if (await checks.executableIsUsable(executable)) pass(`validation executable available: ${basename(executable)}`);
    else fail(`validation executable is unavailable or not executable: ${basename(executable)}`);
  }

  if (await checks.isPortAvailable("127.0.0.1", 8789)) pass("loopback port 8789 is available");
  else fail("loopback port 8789 is already in use");
  info("GitHub authentication was not inspected");
  return failed ? 1 : 0;
}

function defaultDoctorChecks(): OwnerDoctorChecks {
  return {
    executableVersion: async (executable, args) => {
      try {
        const result = await execFileAsync(executable, args, {
          env: { PATH: process.env.PATH ?? "" },
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8"
        });
        return `${result.stdout}${result.stderr}`.trim();
      } catch {
        return undefined;
      }
    },
    isPortAvailable,
    inspectPrivatePath,
    executableIsUsable: async (path) => {
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() && !metadata.isSymbolicLink()) return false;
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
  };
}

async function inspectPrivatePath(path: string, kind: "file" | "directory"): Promise<"private" | "missing" | "unsafe"> {
  try {
    const metadata = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const kindMatches = kind === "file"
      ? metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600
      : metadata.isDirectory() && (metadata.mode & 0o777) === 0o700;
    return kindMatches && !metadata.isSymbolicLink() && (uid === undefined || metadata.uid === uid)
      ? "private"
      : "unsafe";
  } catch (error) {
    if (isNotFoundError(error)) return "missing";
    return "unsafe";
  }
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function configuredExecutables(config: ParsedRepoReaderConfig | undefined): string[] {
  if (!config) return [];
  const executables = new Set<string>();
  for (const repo of config.repos) {
    for (const profile of Object.values(repo.operations.validation_profiles ?? {})) {
      if (profile?.runner === "exec") executables.add(profile.executable);
    }
  }
  return [...executables].sort();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.slice(0, 200) ?? "unknown version";
}
