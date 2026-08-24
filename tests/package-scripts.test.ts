import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PUBLIC_DOCS = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/APPROVAL_TROUBLESHOOTING.md",
  "docs/ARCHITECTURE.md",
  "docs/CAPABILITIES.md",
  "docs/CHATGPT_CONNECT.md",
  "docs/CONNECTION_OPTIONS.md",
  "docs/DELEGATION_ARTIFACTS.md",
  "docs/DEPENDENCY_SECURITY.md",
  "docs/ERRORS.md",
  "docs/GLOSSARY.md",
  "docs/MIGRATION.md",
  "docs/PRODUCT.md",
  "docs/QUALITY.md",
  "docs/RELEASE_CHECKLIST.md",
  "docs/SECURITY.md",
  "docs/SETUP.md",
  "docs/TOOL_SURFACE.md",
  "docs/WRITE_WORKFLOWS.md"
] as const;

describe("package and public documentation", () => {
  test("declares the Chat Pro CLI and loopback startup commands", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      name?: string;
      bin?: Record<string, string>;
      engines?: Record<string, string>;
      keywords?: string[];
      scripts?: Record<string, string>;
    };

    expect(pkg.name).toBe("chat-pro-repository-mcp");
    expect(pkg.bin).toEqual({ "chat-pro-repo": "dist/cli/chat-pro-repo.js" });
    expect(pkg.engines?.node).toBe(">=20");
    expect(pkg.keywords).toEqual(
      expect.arrayContaining(["mcp", "chatgpt", "developer-tools", "repository", "local-first"])
    );
    expect(pkg.scripts?.mcp).toBe("CHAT_PRO_REPOSITORY_MCP_CONFIG=./config.local.json PORT=8789 npm run dev");
    expect(pkg.scripts?.tunnel).toBeUndefined();
    expect(pkg.scripts?.connect).toBeUndefined();
    expect(pkg.scripts?.["connect:cloudflare"]).toBeUndefined();
    expect(pkg.scripts?.["connect:secure"]).toBeUndefined();
    expect(pkg.scripts?.["security:export"]).toBe("node scripts/export-security-candidate.mjs");
    expect(pkg.scripts?.["security:scan"]).toBe("node scripts/oss-security-scan.mjs");
    expect(pkg.scripts?.add).toBe("node dist/cli/chat-pro-repo.js repo add");
    expect(pkg.scripts?.["add-project-root"]).toBe("node dist/cli/chat-pro-repo.js project-root add");
    expect(pkg.scripts?.remove).toBe("node dist/cli/chat-pro-repo.js repo remove");
    expect(pkg.scripts?.["remove-project-root"]).toBe("node dist/cli/chat-pro-repo.js project-root remove");
    expect(pkg.scripts?.list).toBe("node dist/cli/chat-pro-repo.js repo list");
    expect(pkg.scripts?.["list-project-roots"]).toBe("node dist/cli/chat-pro-repo.js project-root list");
    expect(pkg.scripts?.["check:config"]).toBe("node dist/cli/chat-pro-repo.js config validate");
    expect(pkg.scripts?.doctor).toBe("npm run build && node dist/cli/chat-pro-repo.js doctor");
  });

  test("removes obsolete connection scripts, examples, and static mockups", async () => {
    const removed = [
      "scripts/connect-dev.mjs",
      "scripts/connect-cloudflare.mjs",
      "scripts/connect-secure.mjs",
      "scripts/connector-runtime.mjs",
      "scripts/platform-command.mjs",
      ".env.example",
      "docs/assets/README.md",
      "docs/assets/chatgpt-server-url.png",
      "docs/assets/chatgpt-server-url.svg",
      "docs/assets/chatgpt-tunnel-id.png",
      "docs/assets/chatgpt-tunnel-id.svg"
    ];

    for (const path of removed) {
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("documents Secure MCP Tunnel only and uses no machine-specific owner path", async () => {
    for (const path of PUBLIC_DOCS) {
      const text = await readFile(path, "utf8");
      expect(text).not.toMatch(/ngrok|cloudflare|npm run connect|connect:secure|chatgpt-server-url|127\.0\.0\.1:8787/iu);
      expect(text).not.toContain("/Users/");
      expect(text).not.toMatch(/\bGPT Repo MCP\b/u);
    }

    const connection = await readFile("docs/CHATGPT_CONNECT.md", "utf8");
    expect(connection).toContain("OpenAI Secure MCP Tunnel");
    expect(connection).toContain("http://127.0.0.1:8789/mcp");
    expect(connection).toContain("Confirm that exactly 63 tools are listed.");
  });

  test("documents installation, registration, operations, and uninstall", async () => {
    const readme = await readFile("README.md", "utf8");
    const setup = await readFile("docs/SETUP.md", "utf8");

    for (const text of [readme, setup]) {
      expect(text).toContain("npm ci");
      expect(text).toContain("cp config.example.json config.local.json");
      expect(text).toContain("npm run add -- /path/to/your/repo --mode <mode>");
      expect(text).toContain("npm run add-project-root -- /path/to/projects");
      expect(text).toContain("explicit `read`, `write`, or `ship`");
      expect(text).toContain("npm run doctor");
      expect(text).toContain("curl http://127.0.0.1:8789/health");
    }

    expect(setup).toContain("## Rollback And Uninstall");
    expect(setup).toContain("npm run remove -- <repo_id>");
    expect(setup).toContain("No MCP tool can register a root or change its mode.");
  });

  test("documents the non-bypassable authority and merge boundaries", async () => {
    const readme = await readFile("README.md", "utf8");
    const security = await readFile("docs/SECURITY.md", "utf8");
    const workflows = await readFile("docs/WRITE_WORKFLOWS.md", "utf8");

    expect(readme).toContain("Allow all actions does not broaden server authority.");
    expect(readme).toContain("`ship` task authority is required for push and pull-request mutation.");
    expect(security).toContain("No tool reads credential stores");
    expect(workflows).toContain("chat-pro-repo approve-merge --gate-id <opaque-id>");
    expect(workflows).toContain("mode-0600");
    expect(workflows).toContain("one exact, unexpired, one-time owner approval");
    expect(workflows).toContain("does not authorize release");
  });

  test("preserves exact upstream attribution in NOTICE", async () => {
    const notice = await readFile("NOTICE", "utf8");
    expect(notice).toContain("gpt-repo-mcp");
    expect(notice).toContain("https://github.com/CAHN91/gpt-repo-mcp.git");
    expect(notice).toContain("986f2135f00959f8e0d214ed8d173a7054f4cea1");
    expect(notice).toContain("4cff6c18f013eba5bcc66eabc5a7a43d4fcd7d6b");
    expect(notice).toContain("MIT License");
  });

  test("public checker admits NOTICE attribution but rejects brand leakage elsewhere", async () => {
    const scriptPath = resolve("scripts/check-public.mjs");
    const allowed = await mkdtemp(join(tmpdir(), "chat-pro-public-notice-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: allowed });
    await writeFile(join(allowed, "NOTICE"), "Upstream copyright Promptiva AB\n");
    await execFileAsync("git", ["add", "NOTICE"], { cwd: allowed });
    await expect(execFileAsync(process.execPath, [scriptPath], { cwd: allowed })).resolves.toMatchObject({
      stdout: expect.stringContaining("Public hygiene check passed.")
    });

    const rejected = await mkdtemp(join(tmpdir(), "chat-pro-public-readme-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: rejected });
    await writeFile(join(rejected, "README.md"), "Built by Promptiva AB\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: rejected });
    await expect(execFileAsync(process.execPath, [scriptPath], { cwd: rejected })).rejects.toMatchObject({
      stderr: expect.stringContaining("README.md: blocked public-release marker found: Promptiva")
    });
  });

  test("uses public-safe local artifact ignores", async () => {
    const gitignore = await readFile(".gitignore", "utf8");
    const npmignore = await readFile(".npmignore", "utf8");

    expect(gitignore).toContain("# Local Chat Pro Repository MCP artifacts");
    expect(gitignore).toContain("config.local.json");
    expect(gitignore).not.toContain("!.env.example");
    expect(npmignore).not.toContain("!.env.example");
  });
});
