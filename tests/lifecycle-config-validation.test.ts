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
      expected_remote_identity: `file:${fixture.remote}`,
      allowed_base_branches: ["main"]
    });
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

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000
  });
}
