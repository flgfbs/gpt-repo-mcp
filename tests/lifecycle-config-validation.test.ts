import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { validateConfigDocument } from "../src/config/validation.js";

const execFileAsync = promisify(execFile);

describe("lifecycle repository config validation", () => {
  test("binds the exact Git root, local branch, remote identity, and worktree root", async () => {
    const fixture = await lifecycleFixture();
    const result = await validateConfigDocument(documentFor(fixture));

    expect(result.issues).toEqual([]);
    expect(result.config?.repos[0]?.lifecycle).toMatchObject({
      kind: "github",
      expected_remote_identity: `file:${fixture.remote}`,
      allowed_base_branches: ["main"]
    });
  });

  test("accepts a local-only lifecycle without any configured remote", async () => {
    const fixture = await lifecycleFixture();
    await runGit(fixture.repo, ["remote", "remove", "origin"]);

    const result = await validateConfigDocument(localDocumentFor(fixture));

    expect(result.issues).toEqual([]);
    expect(result.config?.repos[0]?.lifecycle).toMatchObject({
      kind: "local",
      authority: "ship",
      allowed_base_branches: ["main"],
      worktree_root: fixture.worktrees
    });
  });

  test("rejects GitHub-only fields under a local lifecycle policy", async () => {
    const fixture = await lifecycleFixture();
    const document = localDocumentFor(fixture);
    Object.assign(document.repos[0]!.lifecycle, { remote_name: "origin" });

    const result = await validateConfigDocument(document);

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        message: expect.stringContaining("Local lifecycle policy cannot configure remote_name")
      })
    ]));
  });

  test("rejects a remote identity mismatch", async () => {
    const fixture = await lifecycleFixture();
    const document = documentFor(fixture);
    document.repos[0]!.lifecycle.expected_remote_identity = `file:${join(fixture.sandbox, "different.git")}`;

    const result = await validateConfigDocument(document);

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REMOTE_IDENTITY_MISMATCH" })
    ]));
  });

  test("rejects a worktree root that overlaps the owner repository", async () => {
    const fixture = await lifecycleFixture();
    const document = documentFor(fixture);
    document.repos[0]!.lifecycle.worktree_root = fixture.repo;

    const result = await validateConfigDocument(document);

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "WORKTREE_ROOT_OVERLAP" })
    ]));
  });

  test("rejects worktree roots that overlap another registered repository", async () => {
    const first = await lifecycleFixture();
    const second = await lifecycleFixture();
    const document = documentFor(first);
    const secondRepo = documentFor(second).repos[0]!;
    secondRepo.repo_id = "fixture-two";
    document.repos[0]!.lifecycle.worktree_root = second.repo;
    document.repos.push(secondRepo);

    const result = await validateConfigDocument(document);

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "WORKTREE_ROOT_CROSSES_REPOSITORY" })
    ]));
  });

  test("rejects overlapping worktree roots across repositories", async () => {
    const first = await lifecycleFixture();
    const second = await lifecycleFixture();
    const nestedWorktrees = join(first.worktrees, "nested");
    await mkdir(nestedWorktrees);
    const document = documentFor(first);
    const secondRepo = documentFor(second).repos[0]!;
    secondRepo.repo_id = "fixture-two";
    secondRepo.lifecycle.worktree_root = nestedWorktrees;
    document.repos.push(secondRepo);

    const result = await validateConfigDocument(document);

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "WORKTREE_ROOTS_OVERLAP" })
    ]));
  });
});

type LifecycleFixture = {
  sandbox: string;
  repo: string;
  remote: string;
  worktrees: string;
};

async function lifecycleFixture(): Promise<LifecycleFixture> {
  const sandbox = await mkdtemp(join(tmpdir(), "chat-pro-lifecycle-config-"));
  const repo = join(sandbox, "repo");
  const remote = join(sandbox, "remote.git");
  const worktrees = join(sandbox, "worktrees");
  await mkdir(repo);
  await mkdir(worktrees);
  await runGit(sandbox, ["init", "--bare", remote]);
  await runGit(repo, ["init", "--initial-branch=main"]);
  await runGit(repo, ["config", "user.name", "Fixture"]);
  await runGit(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await runGit(repo, ["add", "README.md"]);
  await runGit(repo, ["commit", "-m", "fixture"]);
  await runGit(repo, ["remote", "add", "origin", remote]);
  return { sandbox, repo, remote, worktrees };
}

function documentFor(fixture: LifecycleFixture) {
  return {
    repos: [{
      repo_id: "fixture",
      display_name: "Fixture",
      root: fixture.repo,
      lifecycle: {
        authority: "ship" as const,
        remote_name: "origin",
        expected_remote_identity: `file:${fixture.remote}`,
        allowed_base_branches: ["main"],
        worktree_root: fixture.worktrees,
        github_repository: "fixture/repository",
        merge_method: "squash" as const
      }
    }],
    limits: {}
  };
}

function localDocumentFor(fixture: LifecycleFixture) {
  return {
    repos: [{
      repo_id: "fixture-local",
      display_name: "Local Fixture",
      root: fixture.repo,
      lifecycle: {
        kind: "local" as const,
        authority: "ship" as const,
        allowed_base_branches: ["main"],
        worktree_root: fixture.worktrees
      }
    }],
    limits: {}
  };
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000
  });
}
