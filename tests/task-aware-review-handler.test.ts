import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test } from "vitest";
import { createMcpServer } from "../src/register.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { codexRunPaths } from "../src/services/codex-run-paths.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { GitService } from "../src/services/git-service.js";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { writeQueuedV3Run, writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const RUN_ID = "2026-09-05T000000Z-task-review-handler";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task-aware review handler", { timeout: 30_000 }, () => {
  test("records a strict review through the durable guard and prevents replay", async () => {
    await withFixture(async ({ call, payload, review, root }) => {
      const written = await call(payload);
      expect(written.isError).toBeUndefined();
      expect(written.structuredContent).toMatchObject({
        ok: true,
        dry_run: false,
        product_verdict: "not_applicable",
        review_state_sha256: payload.expected_review_state_sha256
      });
      expect((await review()).review_attestation).toMatchObject({ status: "valid" });
      const path = join(root, codexRunPaths(RUN_ID).reviewPath);
      const bytes = await readFile(path, "utf8");
      expect(await call(payload)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "TASK_OPERATION_ALREADY_COMPLETED" } }
      });
      expect(await readFile(path, "utf8")).toBe(bytes);
    });
  });

  test.each(["operation_id", "expected_head_sha", "expected_tree_sha"])(
    "rejects a missing %s before recording review",
    async (field) => {
      await withFixture(async ({ call, payload, review }) => {
        const missing = { ...payload };
        delete missing[field];
        expect(await call(missing)).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "TASK_STATE_MISMATCH" } }
        });
        expect((await review()).review_attestation.status).toBe("missing");
      });
    }
  );

  test.each(["expected_head_sha", "expected_tree_sha"])(
    "rejects a wrong %s without recording review",
    async (field) => {
      await withFixture(async ({ call, payload, review }) => {
        expect(await call({ ...payload, [field]: "0".repeat(40) })).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "TASK_OPERATION_BLOCKED" } }
        });
        expect((await review()).review_attestation.status).toBe("missing");
      });
    }
  );

  test("rejects a previously current task binding after HEAD advances", async () => {
    await withFixture(async ({ call, payload, review, root }) => {
      await writeFile(join(root, "README.md"), "# Advanced fixture\n");
      await git(root, "add", "--", "README.md");
      await git(root, "commit", "-m", "Advance fixture head");
      expect(await call(payload)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "TASK_OPERATION_BLOCKED" } }
      });
      expect((await review()).review_attestation.status).toBe("missing");
    });
  });

  test("rejects stale review state even when task HEAD and tree still match", async () => {
    await withFixture(async ({ call, payload, review, root }) => {
      await writeFile(join(root, "src/app.ts"), "export const reviewed = 'drifted';\n");
      expect(await call(payload)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "CODEX_REVIEW_STATE_MISMATCH" } }
      });
      expect((await review()).review_attestation.status).toBe("missing");
    });
  });
});

async function withFixture(run: (fixture: {
  root: string;
  payload: Record<string, unknown>;
  call: (payload: Record<string, unknown>) => ReturnType<Client["callTool"]>;
  review: () => ReturnType<CodexResultService["review"]>;
}) => Promise<void>): Promise<void> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "task-review-handler-")));
  roots.push(parent);
  const base = join(parent, "base");
  await mkdir(join(base, "src"), { recursive: true });
  await git(base, "init", "-b", "main");
  await git(base, "config", "user.name", "Review Handler Test");
  await git(base, "config", "user.email", "review-handler@example.invalid");
  await writeFile(join(base, "README.md"), "# Review handler fixture\n");
  await writeFile(join(base, "src/app.ts"), "export const reviewed = false;\n");
  await git(base, "add", "--", "README.md", "src/app.ts");
  await git(base, "commit", "-m", "Initial review fixture");
  const head = await git(base, "rev-parse", "HEAD");
  const tree = await git(base, "rev-parse", "HEAD^{tree}");
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "base", display_name: "Base", root: base,
      writes: { enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] },
      lifecycle: {
        kind: "local", authority: "ship", allowed_base_branches: ["main"],
        worktree_root: join(parent, "worktrees")
      }
    }],
    limits: {}, runtime_root: join(parent, "runtime")
  });
  const bundle = await createLifecycleRuntimeBundle(registry);
  const opened = await bundle.lifecycle.taskOpen({
    operation_id: "open-review-fixture", repo_id: "base", task_id: "review-fixture",
    base_branch: "main", base_commit_sha: head, base_tree_sha: tree,
    authority: "ship", goal: "Exercise state-bound task review recording.", branch_slug: "review-fixture"
  });
  const repoId = opened.task.repo_id;
  const root = registry.get(repoId).root;
  const gitService = new GitService(root);
  await writeQueuedV3Run(root, RUN_ID, {
    repo_id: repoId, validation: null,
    baseline: { head_sha: head, worktree_fingerprint: await gitService.worktreeFingerprint(), initial_changed_paths: [] }
  });
  await writeFile(join(root, "src/app.ts"), "export const reviewed = true;\n");
  await writeV3Result(root, RUN_ID, { changed_files: ["src/app.ts"] });
  const review = () => new CodexResultService(new PathSandbox(root), new GitReviewService(root), root)
    .review({ repo_id: repoId, run_id: RUN_ID });
  const before = await review();
  expect(before.technical_readiness.status).toBe("passed");
  if (before.review_state.status !== "available") throw new Error("Expected available review state.");
  const server = createMcpServer({ registry, taskMutations: bundle.taskMutations });
  const client = new Client({ name: "task-review-handler-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run({
      root, review,
      call: (payload) => client.callTool({ name: "repo_write_codex_review", arguments: payload }),
      payload: {
        repo_id: repoId, run_id: RUN_ID, operation_id: "record-review-fixture",
        expected_head_sha: head, expected_tree_sha: tree,
        expected_review_state_sha256: before.review_state.state_sha256,
        product_verdict: "not_applicable", rationale: "The technical-only fixture satisfies its bound criteria."
      }
    });
  } finally {
    await client.close();
    await server.close();
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root, env: { PATH: process.env.PATH ?? "" }, maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
