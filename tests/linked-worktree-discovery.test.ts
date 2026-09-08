import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import { createMcpServer } from "../src/register.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automatic linked worktrees", () => {
  test("rejects a nested worktree that would bypass an existing repository boundary", async () => {
    const fixture = await createFixture();
    await addWorktree(fixture, "owner/nested");
    const registry = await registryFor(fixture);
    await registry.refreshDiscovery();
    expect(registry.list().map((repo) => repo.root)).toEqual([fixture.owner]);
  });

  test("rejects a worktree that contains another explicitly registered repository", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "outer");
    const inner = join(linked, "inner");
    await initializeRepo(inner);
    const registry = await RootRegistry.fromConfig({ repos: [
      { repo_id: "owner", display_name: "Owner", root: fixture.owner },
      { repo_id: "inner", display_name: "Inner", root: inner }
    ] });
    await registry.refreshDiscovery();
    expect(registry.list().map((repo) => repo.root)).toEqual([fixture.owner, inner]);
  });

  test("typoed ids do not rescan and repeated unknown worktree ids share a short refresh interval", async () => {
    const registry = await RootRegistry.fromConfig({ repos: [] });
    const refresh = vi.spyOn(registry, "refreshDiscovery");
    await registry.refreshForRepo("typo");
    expect(refresh).not.toHaveBeenCalled();
    await registry.refreshForRepo(`owner--worktree-missing-${"a".repeat(20)}`);
    await registry.refreshForRepo(`owner--worktree-missing-${"b".repeat(20)}`);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("checks the opened metadata object with nonblocking no-follow flags and closes rejected handles", async () => {
    const fixture = await createFixture();
    await addWorktree(fixture, "linked");
    const registry = await registryFor(fixture);
    const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    let closed = false;
    const opening = vi.mocked(filesystem.open).mockImplementationOnce(async (path, flags, mode) => {
      expect(Number(flags) & constants.O_NOFOLLOW).not.toBe(0);
      expect(Number(flags) & constants.O_NONBLOCK).not.toBe(0);
      const handle = await originalOpen(path, flags, mode);
      const metadata = await handle.stat();
      // Model a regular path being swapped to a special file at open time.
      vi.spyOn(handle, "stat").mockResolvedValue(Object.assign(metadata, { isFile: () => false }));
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { closed = true; await originalClose(); });
      return handle;
    });
    await registry.refreshDiscovery();
    expect(opening).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  test("a new project collision reports a warning while unaffected explicit repositories and worktrees remain available", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "linked");
    const projects = join(fixture.root, "projects");
    const child = join(projects, "child");
    await initializeRepo(child);
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "owner", display_name: "Owner", root: fixture.owner }],
      project_roots: [{ project_root_id: "projects", root: projects }]
    });
    await registry.refreshDiscovery();
    expect(registry.getBase("child").root).toBe(child);
    await initializeRepo(join(projects, "owner"));
    await registry.refreshDiscovery();
    expect(registry.list().map((repo) => repo.root)).toEqual([fixture.owner, linked]);
    expect(() => registry.get("child")).toThrow("Unknown repo_id");
    expect(registry.discoveryWarnings()).toContain("project projects: PROJECT_REPO_ID_COLLISION");
  });

  test("a missing project source does not prevent unrelated worktree revalidation", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "linked");
    const projects = join(fixture.root, "projects");
    await mkdir(projects);
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "owner", display_name: "Owner", root: fixture.owner }],
      project_roots: [{ project_root_id: "projects", root: projects }]
    });
    await registry.refreshDiscovery();
    const id = registry.list().find((repo) => repo.root === linked)!.repo_id;
    await rm(projects, { recursive: true });
    await registry.refreshForRepo(id);
    expect(registry.get(id).root).toBe(linked);
    await registry.refreshDiscovery();
    expect(registry.discoveryWarnings()).toContain("project projects: DISCOVERY_SOURCE_UNAVAILABLE");
    expect(registry.get(id).root).toBe(linked);
  });

  test("finds externally created worktrees after startup without changing configuration or inheriting writes", async () => {
    const fixture = await createFixture();
    const config = { repos: [{ repo_id: "owner", display_name: "Owner", root: fixture.owner, writes: { enabled: true } }], limits: {} };
    const before = JSON.stringify(config);
    const registry = await RootRegistry.fromConfig(config);
    await registry.refreshDiscovery();
    expect(registry.list()).toHaveLength(1);
    const linked = await addWorktree(fixture, "outside/projects/checkout");
    await registry.refreshDiscovery();
    const repo = registry.list().find((item) => item.root === linked)!;
    expect(repo).toBeDefined();
    expect(registry.get(repo.repo_id)).toMatchObject({ writes: { enabled: false }, operations: { enabled: false } });
    expect(registry.get(repo.repo_id).lifecycle).toBeUndefined();
    expect(() => registry.getBase(repo.repo_id)).toThrow("not an owner-registered base");
    expect(JSON.stringify(config)).toBe(before);
    await registry.refreshDiscovery();
    expect(registry.list().find((item) => item.root === linked)?.repo_id).toBe(repo.repo_id);
  });

  test("preserves explicit overrides and does not duplicate the same canonical worktree", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "linked");
    const registry = await RootRegistry.fromConfig({ repos: [
      { repo_id: "owner", display_name: "Owner", root: fixture.owner },
      { repo_id: "chosen", display_name: "Chosen", root: linked, writes: { enabled: true } }
    ] });
    await registry.refreshDiscovery();
    expect(registry.list()).toHaveLength(2);
    expect(registry.getBase("chosen").writes.enabled).toBe(true);
  });

  test("keeps same-name, detached, spaced, and unicode checkouts distinct", async () => {
    const fixture = await createFixture();
    const linked = await Promise.all([
      addWorktree(fixture, "one/same-name"),
      addWorktree(fixture, "two/same-name"),
      addWorktree(fixture, "three/日本語 checkout")
    ]);
    const registry = await registryFor(fixture);
    await registry.refreshDiscovery();
    const discovered = registry.list().filter((repo) => linked.includes(repo.root));
    expect(discovered).toHaveLength(3);
    expect(new Set(discovered.map((repo) => repo.repo_id)).size).toBe(3);
  });

  test("removes deleted worktrees and their formerly usable ids without a restart", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "linked");
    const registry = await registryFor(fixture);
    await registry.refreshDiscovery();
    const id = registry.list().find((repo) => repo.root === linked)!.repo_id;
    await git(fixture.owner, ["worktree", "remove", linked]);
    await registry.refreshForRepo(id);
    expect(() => registry.get(id)).toThrow("Unknown repo_id");
  });

  test("drops prunable entries without pruning Git metadata", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "linked");
    const registry = await registryFor(fixture);
    await registry.refreshDiscovery();
    await rm(linked, { recursive: true });
    const before = await git(fixture.owner, ["worktree", "list", "--porcelain"]);
    await registry.refreshDiscovery();
    expect(registry.list()).toHaveLength(1);
    expect(await git(fixture.owner, ["worktree", "list", "--porcelain"])).toBe(before);
  });

  test("rejects a worktree path replaced by a symlink", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "linked");
    const registry = await registryFor(fixture);
    await registry.refreshDiscovery();
    await rename(linked, `${linked}-moved`);
    await symlink(`${linked}-moved`, linked);
    await registry.refreshDiscovery();
    expect(registry.list()).toHaveLength(1);
  });

  test("rejects a .git file rebound to an unrelated repository", async () => {
    const fixture = await createFixture();
    const linked = await addWorktree(fixture, "linked");
    const unrelated = join(fixture.root, "unrelated");
    await initializeRepo(unrelated);
    const registry = await registryFor(fixture);
    await registry.refreshDiscovery();
    await writeFile(join(linked, ".git"), `gitdir: ${unrelated}/.git\n`);
    await registry.refreshDiscovery();
    expect(registry.list()).toHaveLength(1);
  });

  test("rejects forged same-owner indirection without a reciprocal worktree binding", async () => {
    const fixture = await createFixture();
    const first = await addWorktree(fixture, "first");
    const second = await addWorktree(fixture, "second");
    await writeFile(join(second, ".git"), await readFile(join(first, ".git")));
    const registry = await registryFor(fixture);
    await registry.refreshDiscovery();
    expect(registry.list().map((repo) => repo.root)).toEqual([fixture.owner, first]);
  });

  test("preserves server-owned task identity and authority across refreshes", async () => {
    const fixture = await createFixture();
    const taskRoot = join(fixture.root, "tasks");
    await mkdir(taskRoot);
    const linked = await addWorktree(fixture, "tasks/linked");
    const registry = await RootRegistry.fromConfig({ repos: [{
      repo_id: "owner", display_name: "Owner", root: fixture.owner,
      writes: { enabled: true },
      lifecycle: { kind: "local", authority: "write", allowed_base_branches: ["main"], worktree_root: taskRoot }
    }] });
    await registry.refreshDiscovery();
    expect(registry.list()).toHaveLength(2);
    await registry.registerTaskRepo({ task_id: "task", task_repo_id: "task-repo", base_repo_id: "owner", authority: "implement", branch: "main", worktree: linked });
    await registry.refreshDiscovery();
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("task-repo")).toMatchObject({ root: linked, writes: { enabled: true }, task: { task_id: "task" } });
    expect(registry.listTaskRepos()).toHaveLength(1);
  });

  test("discovers new project children and their worktrees while retaining directory exclusions", async () => {
    const fixture = await createFixture();
    const projects = join(fixture.root, "projects");
    await mkdir(projects);
    const registry = await RootRegistry.fromConfig({ project_roots: [{ project_root_id: "projects", root: projects, exclude_directories: ["excluded"] }] });
    const owner = join(projects, "new-owner");
    await initializeRepo(owner);
    const linked = await addWorktree({ ...fixture, owner }, "external/linked");
    await addWorktree({ ...fixture, owner }, "projects/Excluded");
    await registry.refreshDiscovery();
    expect(registry.list().map((repo) => repo.root)).toEqual([owner, linked]);
  });

  test("MCP lists, reads, and rejects a stale worktree id over the same connection", async () => {
    const fixture = await createFixture();
    const registry = await registryFor(fixture);
    const server = createMcpServer({ registry });
    const client = new Client({ name: "worktree-discovery-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({ name: "repo_list_roots", arguments: {} });
      const linked = await addWorktree(fixture, "after-connect");
      const listed = await client.callTool({ name: "repo_list_roots", arguments: {} });
      const entries = (listed.structuredContent as { repos: Array<{ repo_id: string; root: string }> }).repos;
      const id = entries.find((repo) => repo.root === linked)!.repo_id;
      const read = await client.callTool({ name: "repo_fetch_file", arguments: { repo_id: id, path: "README.md" } });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).toContain("Fixture content");
      const denied = await client.callTool({ name: "repo_write_file", arguments: { repo_id: id, path: "README.md", content: "changed" } });
      expect(denied.isError).toBe(true);
      expect(await readFile(join(linked, "README.md"), "utf8")).toBe("Fixture content\n");
      await git(fixture.owner, ["worktree", "remove", linked]);
      const stale = await client.callTool({ name: "repo_fetch_file", arguments: { repo_id: id, path: "README.md" } });
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale)).toContain("UNKNOWN_REPO");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "linked-discovery-")));
  roots.push(root);
  const owner = join(root, "owner");
  await initializeRepo(owner);
  return { root, owner };
}

async function initializeRepo(root: string) {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--quiet", "-b", "main"]);
  await writeFile(join(root, "README.md"), "Fixture content\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial fixture"]);
}

async function addWorktree(fixture: { root: string; owner: string }, path: string) {
  const target = join(fixture.root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await git(fixture.owner, ["worktree", "add", "--quiet", "--detach", target, "HEAD"]);
  return target;
}

async function registryFor(fixture: { owner: string }) {
  return RootRegistry.fromConfig({ repos: [{ repo_id: "owner", display_name: "Owner", root: fixture.owner }] });
}

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout;
}
