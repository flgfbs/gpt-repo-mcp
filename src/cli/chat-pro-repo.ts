#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_RUNTIME_ROOT } from "../config/schema.js";
import { loadConfig, readConfigDocument, resolveConfigPath } from "../config/store.js";
import { validateConfigDocument } from "../config/validation.js";
import { OwnerCliError, type OwnerCliIo } from "./cli-types.js";
import { runOwnerDoctor, type OwnerDoctorChecks } from "./owner-doctor.js";
import {
  approveMerge,
  inspectApproval,
  type OwnerApprovalCliStore
} from "./owner-approval.js";
import {
  addRepository,
  listRepositories,
  removeRepository
} from "./repository-config.js";
import {
  DurableOwnerTaskStateReader,
  type OwnerTaskStateReader
} from "./task-state-reader.js";

const FIXED_HOST = "127.0.0.1";
const FIXED_PORT = 8789;

const USAGE = [
  "Usage:",
  "  chat-pro-repo config validate [--config <path>]",
  "  chat-pro-repo repo add <path> [--mode read|write|ship] [policy options] [--config <path>]",
  "  chat-pro-repo repo list [--config <path>]",
  "  chat-pro-repo repo remove <repo_id> [--config <path>]",
  "  chat-pro-repo task list [--limit <1-10000>] [--config <path>]",
  "  chat-pro-repo task inspect <task_id> [--config <path>]",
  "  chat-pro-repo approve-merge --gate-id <opaque-id> [--config <path>]",
  "  chat-pro-repo approval inspect --approval-id <opaque-id> --gate-id <opaque-id> [--config <path>]",
  "  chat-pro-repo doctor [--config <path>]",
  "  chat-pro-repo server start [--config <path>]",
  "",
  "Repository policy options:",
  "  --id <repo_id> --name <display_name> --remote-name <name>",
  "  --expected-remote-identity <canonical-identity> --base <branch> (repeatable)",
  "  --worktree-root <absolute-path> --github-repository <owner/name>",
  "  --merge-method merge|squash|rebase --required-check <name> (repeatable)",
  "  --max-concurrent-tasks <1-64> --allow-dirty-base",
  "  --keep-worktree --keep-local-branch --allow-nonterminal-cleanup"
].join("\n");

export type OwnerCliDependencies = {
  approvals?: OwnerApprovalCliStore;
  createTaskReader?: (runtimeRoot: string) => OwnerTaskStateReader;
  doctorChecks?: Partial<OwnerDoctorChecks>;
  startServer?: (input: { configPath: string; host: "127.0.0.1"; port: 8789 }) => Promise<void>;
  now?: () => Date;
};

export async function runChatProRepoCli(
  argv: string[],
  io: OwnerCliIo = defaultIo(),
  dependencies: OwnerCliDependencies = {}
): Promise<number> {
  try {
    const { args, configOverride } = parseGlobalArgs(argv);
    if (args.length === 0) throw new OwnerCliError("USAGE", USAGE);
    if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
      io.stdout(USAGE);
      return 0;
    }
    const configPath = resolveConfigPath({ cliConfigPath: configOverride, env: io.env, cwd: io.cwd });
    const taskReaderFactory = dependencies.createTaskReader
      ?? ((runtimeRoot: string) => new DurableOwnerTaskStateReader(runtimeRoot));

    if (args[0] === "config" && args[1] === "validate" && args.length === 2) {
      return await validateConfig(configPath, io);
    }
    if (args[0] === "repo" && args[1] === "add") {
      return await addRepository(args.slice(2), configPath, io);
    }
    if (args[0] === "repo" && args[1] === "list" && args.length === 2) {
      return await listRepositories(configPath, io);
    }
    if (args[0] === "repo" && args[1] === "remove") {
      return await removeRepository(args.slice(2), configPath, io, taskReaderFactory);
    }
    if (args[0] === "task" && args[1] === "list") {
      const limit = parseTaskListArgs(args.slice(2));
      const config = await loadConfig(configPath);
      const tasks = await taskReaderFactory(config.runtime_root ?? DEFAULT_RUNTIME_ROOT).listTasks(limit);
      if (tasks.length === 0) {
        io.stdout("No durable tasks found.");
        return 0;
      }
      io.stdout("task_id\trepo_id\tbase_repo_id\tauthority\tlifecycle\thead\ttree\tupdated_at");
      for (const task of tasks) {
        io.stdout([
          task.task_id,
          task.repo_id,
          task.base_repo_id,
          task.authority,
          task.lifecycle,
          task.worktree_head ?? "-",
          task.worktree_tree ?? "-",
          task.updated_at
        ].join("\t"));
      }
      return 0;
    }
    if (args[0] === "task" && args[1] === "inspect" && args.length === 3) {
      const config = await loadConfig(configPath);
      const state = await taskReaderFactory(config.runtime_root ?? DEFAULT_RUNTIME_ROOT).inspectTask(args[2]!);
      io.stdout(JSON.stringify(state, null, 2));
      return 0;
    }
    if (args[0] === "approve-merge") {
      const gateId = parseSingleOption(args.slice(1), "--gate-id");
      return await approveMerge(gateId, requireApprovalStore(dependencies), io, dependencies.now);
    }
    if (args[0] === "approval" && args[1] === "inspect") {
      const options = parseApprovalInspectArgs(args.slice(2));
      return await inspectApproval(options, requireApprovalStore(dependencies), io);
    }
    if (args[0] === "doctor" && args.length === 1) {
      return await runOwnerDoctor(configPath, io, dependencies.doctorChecks);
    }
    if (args[0] === "server" && args[1] === "start" && args.length === 2) {
      await requireValidConfig(configPath);
      io.stdout(`starting=http://${FIXED_HOST}:${FIXED_PORT}/mcp`);
      await (dependencies.startServer ?? startServer)({ configPath, host: FIXED_HOST, port: FIXED_PORT });
      return 0;
    }
    throw new OwnerCliError("USAGE", `Unknown command.\n${USAGE}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof OwnerCliError ? error.code : "CLI_FAILED";
    io.stderr(`Error [${code}]: ${message}`);
    return 1;
  }
}

async function validateConfig(configPath: string, io: OwnerCliIo): Promise<number> {
  const result = await validateConfigDocument(await readConfigDocument(configPath));
  if (result.issues.length > 0) {
    io.stderr(`FAIL ${result.issues.length} configuration issue(s).`);
    for (const issue of result.issues) io.stderr(`- [${issue.code}] ${issue.message}`);
    return 1;
  }
  io.stdout(`PASS ${result.config?.repos.length ?? 0} repository(s) validated.`);
  for (const warning of result.warnings) io.stdout(`WARN [${warning.code}] ${warning.message}`);
  return 0;
}

async function requireValidConfig(configPath: string): Promise<void> {
  const validation = await validateConfigDocument(await readConfigDocument(configPath));
  if (validation.issues.length > 0) {
    throw new OwnerCliError(
      "CONFIG_INVALID",
      `Server start refused: ${validation.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`
    );
  }
}

function parseGlobalArgs(argv: string[]): { args: string[]; configOverride?: string } {
  const args: string[] = [];
  let configOverride: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new OwnerCliError("USAGE", "Missing value for --config.");
      if (configOverride) throw new OwnerCliError("USAGE", "--config may be specified only once.");
      configOverride = value;
      index += 1;
    } else if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value || configOverride) throw new OwnerCliError("USAGE", "--config requires exactly one value.");
      configOverride = value;
    } else {
      args.push(arg);
    }
  }
  return { args, configOverride };
}

function parseTaskListArgs(args: string[]): number {
  if (args.length === 0) return 1_000;
  const value = parseSingleOption(args, "--limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new OwnerCliError("INVALID_LIMIT", "--limit must be an integer from 1 to 10000.");
  }
  return parsed;
}

function parseApprovalInspectArgs(args: string[]): { approvalId: string; gateId: string } {
  const values = parseNamedOptions(args, new Set(["--approval-id", "--gate-id"]));
  const approvalId = values.get("--approval-id");
  const gateId = values.get("--gate-id");
  if (!approvalId || !gateId) {
    throw new OwnerCliError("USAGE", "Usage: chat-pro-repo approval inspect --approval-id <opaque-id> --gate-id <opaque-id>");
  }
  return { approvalId, gateId };
}

function parseSingleOption(args: string[], name: string): string {
  const values = parseNamedOptions(args, new Set([name]));
  const value = values.get(name);
  if (!value) throw new OwnerCliError("USAGE", `Missing ${name}.`);
  return value;
}

function parseNamedOptions(args: string[], allowed: Set<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new OwnerCliError("USAGE", "Invalid or duplicate command option.");
    }
    values.set(name, value);
  }
  return values;
}

function requireApprovalStore(dependencies: OwnerCliDependencies): OwnerApprovalCliStore {
  if (!dependencies.approvals) {
    throw new OwnerCliError(
      "APPROVAL_STORE_UNAVAILABLE",
      "Owner approval lifecycle adapter is not configured; no approval was created or inspected."
    );
  }
  return dependencies.approvals;
}

async function startServer(input: { configPath: string; host: "127.0.0.1"; port: 8789 }): Promise<void> {
  process.env.CHAT_PRO_REPOSITORY_MCP_CONFIG = input.configPath;
  process.env.CHAT_PRO_REPOSITORY_MCP_HOST = input.host;
  process.env.PORT = String(input.port);
  await import("../server.js");
}

function defaultIo(): OwnerCliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    confirm: async (prompt) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await readline.question(prompt)).trim();
      } finally {
        readline.close();
      }
    }
  };
}

const currentModule = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === currentModule) {
  process.exitCode = await runChatProRepoCli(process.argv.slice(2));
}
