import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const START_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

const tempRoot = await mkdtemp(join(tmpdir(), "gpt-repo-dist-smoke-"));
const configPath = join(tempRoot, "config.json");
const port = await reserveAvailablePort();
let child;
let client;

try {
  await writeFile(configPath, JSON.stringify({
    repos: [],
    limits: {},
    runtime_root: join(tempRoot, "runtime")
  }), "utf8");
  child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHAT_PRO_REPOSITORY_MCP_CONFIG: configPath,
      CHAT_PRO_REPOSITORY_MCP_HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output = appendBounded(output, chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    output = appendBounded(output, chunk.toString());
  });

  await waitForHealth(child, port, () => output);
  client = new Client({ name: "chat-pro-repository-mcp-dist-smoke", version: "1.0.0" }, {
    capabilities: {}
  });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  const capabilities = client.getServerCapabilities();
  if (!capabilities?.tools || Object.hasOwn(capabilities, "resources")) {
    throw new Error("Built server must advertise tools without a repository resource-discovery surface.");
  }
  const listed = await client.listTools();
  if (listed.tools.length !== 65 || new Set(listed.tools.map(({ name }) => name)).size !== 65) {
    throw new Error(`Built server exposed ${listed.tools.length} tools instead of 65 unique tools.`);
  }
  if (!listed.tools.every(({ annotations }) =>
    typeof annotations?.readOnlyHint === "boolean" &&
    typeof annotations?.destructiveHint === "boolean" &&
    typeof annotations?.idempotentHint === "boolean" &&
    typeof annotations?.openWorldHint === "boolean"
  )) {
    throw new Error("Built server omitted truthful read/write annotations from one or more tools.");
  }
  if (!listed.tools.some(({ annotations }) => annotations?.readOnlyHint === true) ||
      !listed.tools.some(({ annotations }) => annotations?.readOnlyHint === false)) {
    throw new Error("Built server did not expose both read-only and mutating tool annotations.");
  }
  process.stdout.write("Built server passed health, MCP initialize, 65-tool discovery, annotations, and resource-purity smoke checks.\n");
} finally {
  if (client) {
    await client.close().catch(() => undefined);
  }
  await stopChild(child);
  await rm(tempRoot, { recursive: true, force: true });
}

async function reserveAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local port for the dist smoke test.");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForHealth(childProcess, port, readOutput) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      throw new Error(`Built server exited before becoming healthy.\n${readOutput()}`.trim());
    }
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/health`, {
        signal: globalThis.AbortSignal.timeout(500)
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true && body?.name === "chat-pro-repository-mcp") {
          return;
        }
      }
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Built server did not become healthy within ${START_TIMEOUT_MS}ms.\n${readOutput()}`.trim());
}

async function stopChild(childProcess) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }
  childProcess.kill("SIGTERM");
  const stopped = await Promise.race([
    once(childProcess, "exit").then(() => true),
    new Promise((resolve) => globalThis.setTimeout(() => resolve(false), 1_500))
  ]);
  if (!stopped && childProcess.exitCode === null && childProcess.signalCode === null) {
    childProcess.kill("SIGKILL");
    await once(childProcess, "exit");
  }
}

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length > 8_000 ? combined.slice(-8_000) : combined;
}
