import { describe, expect, it } from "vitest";
import { ProductionGitHubAdapter } from "../src/github/github-adapter.js";
import {
  installedGhEnvironment,
  type GhInvocation,
  type GhJsonRunner,
  type GhRunResult
} from "../src/github/gh-json-runner.js";
import { ProductionExactGitBoundary, type FixedGitRunner, type GitProcessResult } from "../src/services/git-remote-service.js";
import { FIXED_TASK, HEAD_SHA } from "./fixtures/github-lifecycle-fixtures.js";

class RecordingGhRunner implements GhJsonRunner {
  readonly invocations: GhInvocation[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async run(invocation: GhInvocation): Promise<GhRunResult> {
    this.invocations.push(structuredClone(invocation));
    const output = this.outputs.shift();
    return {
      exitCode: 0,
      spawned: true,
      timedOut: false,
      stdout: output === undefined ? "" : JSON.stringify(output),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }
}

class RecordingGitRunner implements FixedGitRunner {
  readonly calls: { cwd: string; args: readonly string[] }[] = [];

  async run(cwd: string, args: readonly string[]): Promise<GitProcessResult> {
    this.calls.push({ cwd, args: [...args] });
    return {
      exitCode: 0,
      spawned: true,
      timedOut: false,
      stdout: "",
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }
}

describe("fixed GitHub and git boundaries", () => {
  it("delegates auth to installed gh without reading token environment variables", () => {
    const source: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/safe/home" };
    Object.defineProperty(source, "GH_TOKEN", {
      enumerable: true,
      get: () => { throw new Error("GH_TOKEN was inspected"); }
    });
    Object.defineProperty(source, "GITHUB_TOKEN", {
      enumerable: true,
      get: () => { throw new Error("GITHUB_TOKEN was inspected"); }
    });

    expect(installedGhEnvironment(source)).toEqual({
      PATH: "/usr/bin",
      HOME: "/safe/home",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PAGER: "cat",
      PAGER: "cat",
      NO_COLOR: "1",
      CLICOLOR: "0",
      LC_ALL: "C"
    });
  });

  it("creates a Draft PR only through fixed gh api argv and a JSON stdin body", async () => {
    const runner = new RecordingGhRunner([{
      node_id: "PR_node_1",
      number: 7,
      html_url: "https://github.com/example/project/pull/7",
      state: "open",
      draft: true,
      title: "Change",
      body: "Body",
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      updated_at: "2026-08-23T00:00:00.000Z",
      mergeable: true,
      mergeable_state: "clean",
      head: { ref: "task/change", sha: HEAD_SHA },
      base: { ref: "main", sha: "3333333333333333333333333333333333333333" }
    }]);
    const adapter = new ProductionGitHubAdapter(runner);

    const result = await adapter.createDraftPullRequest({
      repository: FIXED_TASK.repository,
      title: "Change",
      body: "Body",
      headBranch: FIXED_TASK.branch,
      baseBranch: FIXED_TASK.baseBranch
    });

    expect(result.isDraft).toBe(true);
    expect(runner.invocations).toEqual([{
      args: [
        "api",
        "--hostname", "github.com",
        "--method", "POST",
        "--input", "-",
        "repos/example/project/pulls"
      ],
      stdinJson: {
        title: "Change",
        body: "Body",
        head: "example:task/change",
        base: "main",
        draft: true,
        maintainer_can_modify: false
      }
    }]);
  });

  it("rejects host absolute paths before invoking gh", async () => {
    const runner = new RecordingGhRunner([]);
    const adapter = new ProductionGitHubAdapter(runner);

    await expect(adapter.createDraftPullRequest({
      repository: FIXED_TASK.repository,
      title: "Change",
      body: "Local evidence: /Users/example/private.log",
      headBranch: FIXED_TASK.branch,
      baseBranch: FIXED_TASK.baseBranch
    })).rejects.toMatchObject({ code: "ABSOLUTE_PATH_IN_EXTERNAL_TEXT" });
    expect(runner.invocations).toHaveLength(0);
  });

  it("uses a fixed GraphQL document rather than accepting a caller document", async () => {
    const runner = new RecordingGhRunner([{
      data: {
        repository: {
          id: "R_repo_node",
          nameWithOwner: "example/project",
          ref: { name: "task/change", target: { oid: HEAD_SHA, tree: { oid: "2222222222222222222222222222222222222222" } } }
        }
      }
    }]);
    const adapter = new ProductionGitHubAdapter(runner);

    await adapter.getRef(FIXED_TASK.repository, "refs/heads/task/change");

    expect(runner.invocations[0]?.args).toEqual([
      "api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"
    ]);
    expect(runner.invocations[0]?.stdinJson).toMatchObject({
      variables: { owner: "example", name: "project", qualifiedName: "refs/heads/task/change" }
    });
    expect((runner.invocations[0]?.stdinJson as { query: string }).query).toContain("query RepositoryRef");
  });

  it("pushes one exact task ref with force, delete, tags, hooks, and submodules disabled", async () => {
    const runner = new RecordingGitRunner();
    const boundary = new ProductionExactGitBoundary(runner);

    await boundary.pushExact({
      task: FIXED_TASK,
      expectedHeadSha: HEAD_SHA,
      expectedRemoteUrl: "https://github.com/example/project.git"
    });

    expect(runner.calls).toEqual([{
      cwd: FIXED_TASK.root,
      args: [
        "push",
        "--porcelain",
        "--no-force",
        "--no-force-with-lease",
        "--no-force-if-includes",
        "--no-delete",
        "--no-prune",
        "--no-follow-tags",
        "--no-signed",
        "--recurse-submodules=no",
        "--no-verify",
        "https://github.com/example/project.git",
        `${HEAD_SHA}:refs/heads/task/change`
      ]
    }]);
  });
});
