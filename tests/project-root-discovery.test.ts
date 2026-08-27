import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import { validateConfigDocument } from "../src/config/validation.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("project root discovery", () => {
  test("discovers direct Git repositories read-only and preserves an explicit owner override", async () => {
    const fixture = await projectFixture();
    const alpha = await initializeRepository(join(fixture.projects, "alpha"));
    const beta = await initializeRepository(join(fixture.projects, "beta"));
    await mkdir(join(fixture.projects, "notes"));
    await mkdir(join(fixture.projects, "group"));
    await initializeRepository(join(fixture.projects, "group", "nested"));
    await initializeRepository(join(fixture.projects, "Excluded"));
    await symlink(beta, join(fixture.projects, "linked-beta"));

    const registry = await RootRegistry.fromConfig({
      repos: [{
        repo_id: "alpha",
        display_name: "Alpha Explicit",
        root: alpha,
        writes: { enabled: true, allowed_globs: ["src/**"] }
      }],
      project_roots: [{
        project_root_id: "projects",
        root: fixture.projects,
        exclude_directories: ["excluded"]
      }],
      limits: {}
    });

    expect(registry.list()).toEqual([
      { repo_id: "alpha", display_name: "Alpha Explicit", root: await realpath(alpha) },
      { repo_id: "beta", display_name: "beta", root: await realpath(beta) }
    ]);
    expect(registry.getBase("alpha").writes.enabled).toBe(true);
    expect(registry.getBase("beta").writes.enabled).toBe(false);
    expect(registry.getBase("beta").operations.enabled).toBe(false);
  });

  test("fails closed on ambiguous discovered ids", async () => {
    const fixture = await projectFixture();
    await initializeRepository(join(fixture.projects, "same-name"));
    await initializeRepository(join(fixture.projects, "same_name"));

    const validation = await validateConfigDocument({
      repos: [],
      project_roots: [{ project_root_id: "projects", root: fixture.projects }],
      limits: {}
    });

    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECT_REPO_ID_COLLISION" })
    ]));
  });

  test("rejects a project root inside an explicit repository while allowing explicit child overrides", async () => {
    const fixture = await projectFixture();
    const owner = await initializeRepository(fixture.root);
    await initializeRepository(join(fixture.projects, "child"));

    const validation = await validateConfigDocument({
      repos: [{
        repo_id: "owner",
        display_name: "Owner",
        root: owner,
        writes: { enabled: true }
      }],
      project_roots: [{ project_root_id: "projects", root: fixture.projects }],
      limits: {}
    });

    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECT_ROOT_INSIDE_EXPLICIT_REPO" })
    ]));
  });

  test("skips Git indirection files used by linked worktrees and submodules", async () => {
    const fixture = await projectFixture();
    const alpha = await initializeRepository(join(fixture.projects, "alpha"));
    const linked = join(fixture.projects, "linked-worktree");
    await mkdir(linked);
    await writeFile(join(linked, ".git"), "gitdir: /outside/project-root\n");

    const registry = await RootRegistry.fromConfig({
      repos: [],
      project_roots: [{ project_root_id: "projects", root: fixture.projects }],
      limits: {}
    });

    expect(registry.list()).toEqual([
      { repo_id: "alpha", display_name: "alpha", root: await realpath(alpha) }
    ]);
  });

  test("does not treat a dot-dot-prefixed direct directory name as traversal", async () => {
    const fixture = await projectFixture();
    const alpha = await initializeRepository(join(fixture.projects, "alpha"));
    await mkdir(join(fixture.projects, "..cache"));

    const registry = await RootRegistry.fromConfig({
      repos: [],
      project_roots: [{ project_root_id: "projects", root: fixture.projects }],
      limits: {}
    });

    expect(registry.list()).toEqual([
      { repo_id: "alpha", display_name: "alpha", root: await realpath(alpha) }
    ]);
  });

  test("rejects a dot-dot-prefixed project root nested inside an explicit repository", async () => {
    const fixture = await projectFixture();
    const owner = await initializeRepository(fixture.root);
    const dotProjects = join(fixture.root, "..projects");
    await mkdir(dotProjects);

    const validation = await validateConfigDocument({
      repos: [{ repo_id: "owner", display_name: "Owner", root: owner }],
      project_roots: [{ project_root_id: "dot-projects", root: dotProjects }],
      limits: {}
    });

    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECT_ROOT_INSIDE_EXPLICIT_REPO" })
    ]));
  });

  test("reports an overlong generated repository id as a coded discovery issue", async () => {
    const fixture = await projectFixture();
    await initializeRepository(join(fixture.projects, "long-repository-name"));

    const validation = await validateConfigDocument({
      repos: [],
      project_roots: [{
        project_root_id: "projects",
        root: fixture.projects,
        repo_id_prefix: "p".repeat(200)
      }],
      limits: {}
    });

    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECT_REPO_ID_TOO_LONG" })
    ]));
  });
});

async function projectFixture(): Promise<{ root: string; projects: string }> {
  const root = await mkdtemp(join(tmpdir(), "project-root-discovery-"));
  roots.push(root);
  const projects = join(root, "Projects");
  await mkdir(projects);
  return { root, projects };
}

async function initializeRepository(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "README.md"), `# ${root}\n`);
  return root;
}
