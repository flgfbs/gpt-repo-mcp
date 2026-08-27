import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  GitHubBoundaryError,
  assertSafeBranch,
  assertSha,
  repositorySlug,
  sha256,
  type Clock,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubOperationRecord,
  type GitHubRefSnapshot,
  type LocalGitSnapshot,
  type ServerOwnedTask,
  type TaskLookup
} from "../github/types.js";
import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import { GitHubOperationController } from "../github/operation-controller.js";
import { normalizeRemoteIdentity } from "./remote-identity.js";
import { assertWritablePublicationTarget } from "./publication-target-guard.js";

export type GitProcessResult = {
  exitCode?: number;
  spawned: boolean;
  timedOut: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export interface FixedGitRunner {
  run(cwd: string, args: readonly string[]): Promise<GitProcessResult>;
}

export class InstalledGitRunner implements FixedGitRunner {
  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly timeoutMs = 30_000,
    private readonly maxOutputBytes = 512 * 1024
  ) {}

  async run(cwd: string, args: readonly string[]): Promise<GitProcessResult> {
    return await new Promise((resolve) => {
      const child = spawn("git", [...args], {
        cwd,
        env: gitEnvironment(this.environment),
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let spawned = false;
      let timedOut = false;
      let settled = false;

      child.once("spawn", () => { spawned = true; });
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = this.maxOutputBytes - stdoutBytes;
        if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(chunk.length, Math.max(remaining, 0));
        if (chunk.length > Math.max(remaining, 0)) {
          stdoutTruncated = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = this.maxOutputBytes - stderrBytes;
        stderrBytes += Math.min(chunk.length, Math.max(remaining, 0));
        if (chunk.length > Math.max(remaining, 0)) {
          stderrTruncated = true;
          child.kill("SIGKILL");
        }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutMs);
      const finish = (exitCode?: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ...(exitCode !== undefined ? { exitCode } : {}),
          spawned,
          timedOut,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stdoutTruncated,
          stderrTruncated
        });
      };
      child.once("error", () => finish());
      child.once("close", (code) => finish(code ?? undefined));
    });
  }
}

export class ProductionExactGitBoundary implements ExactGitBoundary {
  constructor(private readonly runner: FixedGitRunner) {}

  async inspect(task: ServerOwnedTask): Promise<LocalGitSnapshot> {
    assertTaskRoot(task.root);
    assertSafeBranch(task.branch);
    assertRemoteName(task.remoteName);
    const branch = (await this.mustRun(task.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    assertSafeBranch(branch);
    const [headSha, treeSha, status, pushUrls, upstream] = await Promise.all([
      this.mustRun(task.root, ["rev-parse", "HEAD"]),
      this.mustRun(task.root, ["rev-parse", "HEAD^{tree}"]),
      this.mustRun(task.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.mustRun(task.root, ["remote", "get-url", "--push", "--all", task.remoteName]),
      this.mustRun(task.root, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`])
    ]);
    return {
      branch,
      headSha: assertSha(headSha.trim(), "local head sha"),
      treeSha: assertSha(treeSha.trim(), "local tree sha"),
      clean: status.length === 0,
      pushUrls: pushUrls.split("\n").map((value) => value.trim()).filter(Boolean),
      ...(upstream.trim() ? { upstream: assertSafeUpstream(upstream.trim()) } : {})
    };
  }

  async isAncestor(task: ServerOwnedTask, ancestorSha: string, descendantSha: string): Promise<boolean> {
    assertTaskRoot(task.root);
    assertSha(ancestorSha, "ancestor sha");
    assertSha(descendantSha, "descendant sha");
    const result = await this.runner.run(task.root, ["merge-base", "--is-ancestor", ancestorSha, descendantSha]);
    assertBoundedGitResult(result, false);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitHubBoundaryError("GIT_ANCESTRY_FAILED", "Git could not prove task branch ancestry.");
  }

  async pushExact(input: { task: ServerOwnedTask; expectedHeadSha: string; expectedRemoteUrl: string }): Promise<void> {
    assertTaskRoot(input.task.root);
    const sha = assertSha(input.expectedHeadSha, "push head sha");
    const branch = assertSafeBranch(input.task.branch);
    assertSafeGitHubRemoteUrl(input.expectedRemoteUrl, input.task.expectedRemoteIdentity, input.task.repository);
    const result = await this.runner.run(input.task.root, [
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
      input.expectedRemoteUrl,
      `${sha}:refs/heads/${branch}`
    ]);
    assertBoundedGitResult(result, true);
    if (result.exitCode !== 0) {
      throw new GitHubBoundaryError(
        "GIT_PUSH_FAILED",
        "The exact non-force task-branch push did not report success.",
        result.spawned ? "UNKNOWN" : "NONE",
        result.timedOut
      );
    }
  }

  private async mustRun(root: string, args: readonly string[]): Promise<string> {
    const result = await this.runner.run(root, args);
    assertBoundedGitResult(result, false);
    if (result.exitCode !== 0) {
      throw new GitHubBoundaryError("GIT_INSPECTION_FAILED", "Git inspection failed without exposing process output.");
    }
    return result.stdout;
  }
}

export type ExecutedRemoteStatusResult = {
  disposition: "EXECUTED";
  operation: GitHubOperationRecord;
  ok: true;
  semantic: "repo_remote_status";
  operation_id: string;
  repoId: string;
  taskId: string;
  branch: string;
  localHeadSha: string;
  localTreeSha: string;
  clean: boolean;
  remoteHeadSha?: string;
  remoteTreeSha?: string;
  aligned: boolean;
  relationship: "absent" | "equal" | "ahead" | "behind" | "diverged";
  defaultBranch: GitHubRefSnapshot;
  provider: {
    transport: "gh_cli";
    host: "github.com";
    authentication: "inherited_not_inspected";
    viewerPermission: string;
    repositoryId: string;
  };
  evidence: StoredGitHubEvidence;
};

export type RemoteStatusResult = ExecutedRemoteStatusResult | {
  disposition: "STORED";
  operation: GitHubOperationRecord;
};

export type PushResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      pushed: boolean;
      remoteHeadSha: string;
      evidence: StoredGitHubEvidence;
    }
  | {
      disposition: "STORED";
      operation: GitHubOperationRecord;
    };

export class GitRemoteService {
  private readonly operations: GitHubOperationController;

  constructor(
    private readonly tasks: TaskLookup,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly artifacts: ContentAddressedArtifactSink,
    ledger: DurableOperationLedger,
    clock: Clock
  ) {
    this.operations = new GitHubOperationController(ledger, clock);
  }

  async remoteStatus(input: {
    operation_id: string;
    repo_id: string;
    task_id: string;
    expected_head_sha: string;
    expected_tree_sha: string;
  }): Promise<RemoteStatusResult> {
    const task = await this.tasks.getServerOwnedTask(input.repo_id);
    if (task.taskId !== input.task_id) throw new GitHubBoundaryError("TASK_ID_MISMATCH", "task_id does not match the server-owned task.");
    const expectedHeadSha = assertSha(input.expected_head_sha, "expected remote-status head sha");
    const expectedTreeSha = assertSha(input.expected_tree_sha, "expected remote-status tree sha");
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_remote_status",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { branch: task.branch },
      binding: { expectedHeadSha, expectedTreeSha }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    let local: LocalGitSnapshot;
    try {
      local = await this.git.inspect(task);
      assertLocalTaskBinding(task, local);
      if (local.headSha !== expectedHeadSha) throw new GitHubBoundaryError("HEAD_DRIFT", "Task HEAD no longer matches expected_head_sha.");
      if (local.treeSha !== expectedTreeSha) throw new GitHubBoundaryError("TREE_DRIFT", "Task tree no longer matches expected_tree_sha.");
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_PRECONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      const repository = await this.github.getRepository(task.repository);
      assertRepositoryIdentity(task, repository.nameWithOwner);
      const [remote, defaultBranch] = await Promise.all([
        this.github.getRef(task.repository, `refs/heads/${task.branch}`),
        this.github.getRef(task.repository, `refs/heads/${repository.defaultBranch}`)
      ]);
      if (!defaultBranch) throw new GitHubBoundaryError("DEFAULT_BRANCH_MISSING", "GitHub default branch ref is missing.");
      const aligned = remote?.sha === local.headSha && remote.treeSha === local.treeSha;
      const relationship = await remoteRelationship(this.git, this.github, task, remote, local.headSha);
      const evidence = await storeGitHubEvidence(this.artifacts, "github-remote-evidence", {
        semantic: "repo_remote_status",
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        localHeadSha: local.headSha,
        localTreeSha: local.treeSha,
        remoteHeadSha: remote?.sha ?? null,
        remoteTreeSha: remote?.treeSha ?? null,
        taskBranchName: task.branch,
        defaultBranchName: repository.defaultBranch,
        localUpstream: local.upstream ?? null,
        remoteName: task.remoteName,
        normalizedRemoteIdentity: task.expectedRemoteIdentity,
        configuredRepositoryIdentity: repository.nameWithOwner,
        defaultBranchHeadSha: defaultBranch.sha,
        defaultBranchTreeSha: defaultBranch.treeSha,
        aligned,
        relationship,
        repositoryId: repository.id
      });
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          remoteHeadSha: remote?.sha ?? null,
          remoteTreeSha: remote?.treeSha ?? null,
          aligned,
          relationship,
          artifactId: evidence.artifactId,
          artifactDigest: evidence.digest
        }
      });
      return {
        disposition: "EXECUTED",
        operation,
        ok: true,
        semantic: "repo_remote_status",
        operation_id: input.operation_id,
        repoId: task.repoId,
        taskId: task.taskId,
        branch: task.branch,
        localHeadSha: local.headSha,
        localTreeSha: local.treeSha,
        clean: local.clean,
        ...(remote ? { remoteHeadSha: remote.sha } : {}),
        ...(remote ? { remoteTreeSha: remote.treeSha } : {}),
        aligned,
        relationship,
        defaultBranch,
        provider: {
          transport: "gh_cli",
          host: "github.com",
          authentication: "inherited_not_inspected",
          viewerPermission: repository.viewerPermission,
          repositoryId: repository.id
        },
        evidence
      };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
  }

  async writePush(input: {
    operation_id: string;
    repo_id: string;
    task_id: string;
    expected_head_sha: string;
    expected_tree_sha: string;
  }): Promise<PushResult> {
    const task = await this.tasks.getServerOwnedTask(input.repo_id);
    if (task.taskId !== input.task_id) throw new GitHubBoundaryError("TASK_ID_MISMATCH", "task_id does not match the server-owned task.");
    const expectedHeadSha = assertSha(input.expected_head_sha, "expected push head sha");
    const expectedTreeSha = assertSha(input.expected_tree_sha, "expected push tree sha");
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_write_push",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { branch: task.branch },
      binding: {
        branch: task.branch,
        expectedHeadSha,
        expectedTreeSha,
        remoteIdentityDigest: shaForRemoteIdentity(task.expectedRemoteIdentity)
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;

    let local: LocalGitSnapshot;
    let remoteBefore: GitHubRefSnapshot | undefined;
    try {
      local = await this.git.inspect(task);
      assertLocalTaskBinding(task, local);
      if (!local.clean) throw new GitHubBoundaryError("WORKTREE_NOT_CLEAN", "Task worktree must be clean before push.");
      if (local.headSha !== expectedHeadSha) throw new GitHubBoundaryError("HEAD_DRIFT", "Task HEAD no longer matches expected_head_sha.");
      if (local.treeSha !== expectedTreeSha) throw new GitHubBoundaryError("TREE_DRIFT", "Task tree no longer matches expected_tree_sha.");
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_PRECONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      const repository = await this.github.getRepository(task.repository);
      assertWritablePublicationTarget(task, repository);
      remoteBefore = await this.github.getRef(task.repository, `refs/heads/${task.branch}`);
      if (remoteBefore?.sha === expectedHeadSha && remoteBefore.treeSha !== expectedTreeSha) {
        throw new GitHubBoundaryError("REMOTE_TREE_MISMATCH", "Remote task branch tree does not match the exact local tree.");
      }
      if (remoteBefore && remoteBefore.sha !== expectedHeadSha) {
        const ancestor = await this.git.isAncestor(task, remoteBefore.sha, expectedHeadSha);
        if (!ancestor) throw new GitHubBoundaryError("NON_FAST_FORWARD_BLOCKED", "Remote task branch is not an ancestor of the exact local head.");
      }
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
    if (remoteBefore?.sha === expectedHeadSha) {
      try {
        const evidence = await this.storePushEvidence(task, remoteBefore, remoteBefore, expectedHeadSha, false);
        operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
          result: {
            pushed: false,
            remoteHeadSha: expectedHeadSha,
            artifactId: evidence.artifactId,
            artifactDigest: evidence.digest
          }
        });
        return { disposition: "EXECUTED", operation, pushed: false, remoteHeadSha: expectedHeadSha, evidence };
      } catch (error) {
        operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
        throw operationError(error, operation);
      }
    }

    try {
      await this.git.pushExact({ task, expectedHeadSha, expectedRemoteUrl: local.pushUrls[0]! });
    } catch {
      return await this.reconcilePushFailure(task, operation, remoteBefore, expectedHeadSha, expectedTreeSha);
    }

    let remoteAfter: GitHubRefSnapshot;
    try {
      const observed = await this.github.getRef(task.repository, `refs/heads/${task.branch}`);
      remoteAfter = observed!;
      if (remoteAfter?.sha !== expectedHeadSha || remoteAfter.treeSha !== local.treeSha) {
        operation = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
          result: { expectedHeadSha, observedHeadSha: remoteAfter?.sha ?? null },
          failureCode: "PUSH_READBACK_MISMATCH"
        });
        throw operationError(new GitHubBoundaryError("PUSH_READBACK_MISMATCH", "Push readback did not match the exact expected head.", "UNKNOWN"), operation);
      }
    } catch (error) {
      if (operation.phase === "UNKNOWN_AFTER_CONTACT") throw error;
      operation = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
        failureCode: errorCode(error)
      });
      throw operationError(error, operation);
    }
    try {
      const evidence = await this.storePushEvidence(task, remoteBefore, remoteAfter, expectedHeadSha, true);
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          pushed: true,
          remoteHeadSha: expectedHeadSha,
          artifactId: evidence.artifactId,
          artifactDigest: evidence.digest
        }
      });
      return { disposition: "EXECUTED", operation, pushed: true, remoteHeadSha: expectedHeadSha, evidence };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
        result: { pushed: true, remoteHeadSha: expectedHeadSha },
        failureCode: "PUSH_EVIDENCE_STORE_FAILED"
      });
      throw operationError(error, operation);
    }
  }

  private async reconcilePushFailure(
    task: ServerOwnedTask,
    operation: GitHubOperationRecord,
    remoteBefore: GitHubRefSnapshot | undefined,
    expectedHeadSha: string,
    expectedTreeSha: string
  ): Promise<PushResult> {
    try {
      const remoteAfter = await this.github.getRef(task.repository, `refs/heads/${task.branch}`);
      if (remoteAfter?.sha === expectedHeadSha && remoteAfter.treeSha === expectedTreeSha) {
        try {
          const evidence = await this.storePushEvidence(task, remoteBefore, remoteAfter, expectedHeadSha, true);
          const complete = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
            result: {
              pushed: true,
              remoteHeadSha: expectedHeadSha,
              reconciled: true,
              artifactId: evidence.artifactId,
              artifactDigest: evidence.digest
            }
          });
          return { disposition: "EXECUTED", operation: complete, pushed: true, remoteHeadSha: expectedHeadSha, evidence };
        } catch (error) {
          const failed = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
            result: { pushed: true, remoteHeadSha: expectedHeadSha, reconciled: true },
            failureCode: "PUSH_EVIDENCE_STORE_FAILED"
          });
          throw operationError(error, failed);
        }
      }
      if (remoteAfter?.sha === remoteBefore?.sha || (!remoteAfter && !remoteBefore)) {
        const failed = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
          failureCode: "PUSH_KNOWN_NO_EFFECT"
        });
        throw operationError(new GitHubBoundaryError("PUSH_KNOWN_NO_EFFECT", "Push produced no remote ref change.", "KNOWN"), failed);
      }
      const unknown = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
        result: { expectedHeadSha, observedHeadSha: remoteAfter?.sha ?? null },
        failureCode: "PUSH_REMOTE_DRIFT"
      });
      throw operationError(new GitHubBoundaryError("PUSH_REMOTE_DRIFT", "Push effect is not safely replayable.", "UNKNOWN"), unknown);
    } catch (error) {
      if (isOperationError(error)) throw error;
      const unknown = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
        failureCode: "PUSH_READBACK_UNAVAILABLE"
      });
      throw operationError(error, unknown);
    }
  }

  private async storePushEvidence(
    task: ServerOwnedTask,
    before: GitHubRefSnapshot | undefined,
    after: GitHubRefSnapshot | undefined,
    expectedHeadSha: string,
    pushed: boolean
  ): Promise<StoredGitHubEvidence> {
    return await storeGitHubEvidence(this.artifacts, "github-push-evidence", {
      semantic: "repo_write_push",
      repoId: task.repoId,
      taskId: task.taskId,
      taskBranch: task.branch,
      expectedHeadSha,
      remoteBefore: before?.sha ?? null,
      remoteBeforeTree: before?.treeSha ?? null,
      remoteAfter: after?.sha ?? null,
      remoteAfterTree: after?.treeSha ?? null,
      pushed,
      fastForwardOnly: true,
      forceUsed: false,
      branchRetained: true
    });
  }
}

type OperationBoundError = GitHubBoundaryError & { operation: GitHubOperationRecord };

function operationError(error: unknown, operation: GitHubOperationRecord): OperationBoundError {
  const base = error instanceof GitHubBoundaryError
    ? error
    : new GitHubBoundaryError("GITHUB_OPERATION_FAILED", "GitHub operation failed without exposing process output.");
  return Object.assign(base, { operation });
}

function isOperationError(error: unknown): error is OperationBoundError {
  return error instanceof GitHubBoundaryError && "operation" in error;
}

function errorCode(error: unknown): string {
  return error instanceof GitHubBoundaryError ? error.code : "GITHUB_OPERATION_FAILED";
}

function assertLocalTaskBinding(task: ServerOwnedTask, local: LocalGitSnapshot): void {
  if (local.branch !== task.branch) throw new GitHubBoundaryError("TASK_BRANCH_DRIFT", "Current branch is not the server-owned task branch.");
  if (local.pushUrls.length !== 1) {
    throw new GitHubBoundaryError("REMOTE_IDENTITY_MISMATCH", "Configured push URL does not match the exact task binding.");
  }
  assertSafeGitHubRemoteUrl(local.pushUrls[0]!, task.expectedRemoteIdentity, task.repository);
}

function assertRepositoryIdentity(task: ServerOwnedTask, actual: string): void {
  if (actual.toLowerCase() !== repositorySlug(task.repository).toLowerCase()) {
    throw new GitHubBoundaryError("GITHUB_REPOSITORY_MISMATCH", "GitHub repository identity does not match the task binding.");
  }
}

function assertSafeGitHubRemoteUrl(
  value: string,
  expectedIdentity: string,
  repository: ServerOwnedTask["repository"]
): void {
  const expected = `github.com/${repositorySlug(repository)}`;
  if (
    expectedIdentity.toLowerCase() !== expected.toLowerCase()
    || normalizeRemoteIdentity(value).toLowerCase() !== expected.toLowerCase()
  ) {
    throw new GitHubBoundaryError("REMOTE_IDENTITY_MISMATCH", "Task remote does not match the owner-registered canonical identity.");
  }
  if (/^(?:git@)?github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitHubBoundaryError("REMOTE_URL_INVALID", "Task remote URL is invalid.");
  }
  const safeHttps = parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  const safeSsh = parsed.protocol === "ssh:" && (parsed.username === "" || parsed.username === "git") && parsed.password === "";
  if (
    (!safeHttps && !safeSsh)
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new GitHubBoundaryError("REMOTE_URL_UNSAFE", "Task remote URL must be a credential-free GitHub HTTPS or SSH URL.");
  }
}

function assertSafeUpstream(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/.test(value) || value.includes("..") || value.includes("//")) {
    throw new GitHubBoundaryError("UPSTREAM_REF_INVALID", "Local upstream is not a safe ref name.");
  }
  return value;
}

function assertRemoteName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new GitHubBoundaryError("REMOTE_NAME_INVALID", "Configured remote name is invalid.");
  }
}

function assertTaskRoot(value: string): void {
  if (!isAbsolute(value) || value === "/" || value.includes("\0")) {
    throw new GitHubBoundaryError("TASK_ROOT_INVALID", "Task root must be a non-root absolute path.");
  }
}

function assertBoundedGitResult(result: GitProcessResult, external: boolean): void {
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new GitHubBoundaryError("GIT_OUTPUT_TRUNCATED", "Git output exceeded the fixed boundary.", external && result.spawned ? "UNKNOWN" : "NONE");
  }
  if (result.timedOut) {
    throw new GitHubBoundaryError("GIT_TIMEOUT", "Git exceeded the fixed timeout.", external && result.spawned ? "UNKNOWN" : "NONE", true);
  }
}

function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "",
    ...(source.HOME ? { HOME: source.HOME } : {}),
    ...(source.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: source.XDG_CONFIG_HOME } : {}),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    LC_ALL: "C"
  };
}

function shaForRemoteIdentity(value: string): string {
  return sha256(value);
}

async function remoteRelationship(
  git: ExactGitBoundary,
  github: GitHubAdapter,
  task: ServerOwnedTask,
  remote: GitHubRefSnapshot | undefined,
  localHeadSha: string
): Promise<"absent" | "equal" | "ahead" | "behind" | "diverged"> {
  if (!remote) return "absent";
  if (remote.sha === localHeadSha) return "equal";
  try {
    if (await git.isAncestor(task, remote.sha, localHeadSha)) return "ahead";
    if (await git.isAncestor(task, localHeadSha, remote.sha)) return "behind";
    return "diverged";
  } catch (error) {
    if (!(error instanceof GitHubBoundaryError) || error.code !== "GIT_ANCESTRY_FAILED") throw error;
  }
  const comparison = await github.compare(task.repository, remote.sha, localHeadSha);
  if (comparison.status === "ahead") return "ahead";
  if (comparison.status === "behind") return "behind";
  if (comparison.status === "identical") return "equal";
  return "diverged";
}
