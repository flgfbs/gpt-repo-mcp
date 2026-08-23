import { posix } from "node:path";
import { z } from "zod";
import {
  GITHUB_OPERATION_PHASES,
  GITHUB_PUBLIC_SEMANTICS,
  GitHubBoundaryError,
  sha256Json,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubArtifactNamespace,
  type GitHubOperationRecord,
  type IndependentReviewEvidence,
  type JsonValue,
  type MergeEvidenceProvider,
  type RequiredCheck,
  type ServerOwnedTask,
  type TaskLookup,
  type ValidationEvidence
} from "../github/types.js";
import { storeGitHubEvidence } from "../github/evidence.js";
import {
  CrossProcessLockManager,
  SecureRuntimeFs,
  TaskArtifactStore,
  canonicalJson,
  canonicalSha256,
  hashedDiskKey,
  hasCode,
  type TaskArtifactMetadata,
  type TaskRuntimeService
} from "../task-runtime/index.js";
import type { RootRegistry } from "./root-registry.js";

const MAX_GITHUB_STATE_BYTES = 512 * 1024;
const MAX_GITHUB_OPERATIONS = 10_000;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

const GitHubOperationDiskSchema = z.object({
  schema_version: z.literal(1),
  operationId: z.string().min(8).max(160),
  semantic: z.enum(GITHUB_PUBLIC_SEMANTICS),
  repoId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(128),
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(GITHUB_OPERATION_PHASES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  result: z.json().optional(),
  failureCode: z.string().regex(/^[A-Z0-9_]{1,160}$/).optional(),
  revision: z.number().int().nonnegative(),
  state_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

type GitHubOperationDisk = z.infer<typeof GitHubOperationDiskSchema>;

export class DurableGitHubOperationLedger implements DurableOperationLedger {
  constructor(
    private readonly fs: SecureRuntimeFs,
    private readonly locks: CrossProcessLockManager
  ) {}

  async initialize(): Promise<void> {
    await this.fs.ensureDirectory("github-operations");
  }

  async create(record: GitHubOperationRecord): Promise<{ created: boolean; record: GitHubOperationRecord }> {
    await this.initialize();
    return this.locks.withLock(`github-operation:${record.operationId}`, async () => {
      const existing = await this.read(record.operationId);
      if (existing) return { created: false, record: diskRecord(existing) };
      const stored = await this.write({
        schema_version: 1,
        ...record,
        revision: 0
      }, true);
      return { created: true, record: diskRecord(stored) };
    });
  }

  async transition(input: {
    operationId: string;
    bindingDigest: string;
    expectedPhases: GitHubOperationRecord["phase"][];
    nextPhase: GitHubOperationRecord["phase"];
    updatedAt: string;
    result?: JsonValue;
    failureCode?: string;
  }): Promise<GitHubOperationRecord> {
    return this.locks.withLock(`github-operation:${input.operationId}`, async () => {
      const current = await this.read(input.operationId);
      if (!current) throw new GitHubBoundaryError("OPERATION_NOT_FOUND", "Durable GitHub operation is unavailable.");
      if (current.bindingDigest !== input.bindingDigest || !input.expectedPhases.includes(current.phase)) {
        throw new GitHubBoundaryError("OPERATION_TRANSITION_CONFLICT", "Durable GitHub operation changed before transition.");
      }
      const stored = await this.write({
        ...omitDiskDigest(current),
        phase: input.nextPhase,
        updatedAt: input.updatedAt,
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
        revision: current.revision + 1
      });
      return diskRecord(stored);
    });
  }

  async findBySubject(input: {
    repoId: string;
    taskId: string;
    semantic?: GitHubOperationRecord["semantic"];
    subjectDigest: string;
  }): Promise<GitHubOperationRecord[]> {
    return (await this.listAll()).filter((record) => (
      record.repoId === input.repoId
      && record.taskId === input.taskId
      && record.subjectDigest === input.subjectDigest
      && (input.semantic === undefined || record.semantic === input.semantic)
    )).map(diskRecord);
  }

  async listForTask(input: { repoId: string; taskId: string }): Promise<GitHubOperationRecord[]> {
    return (await this.listAll())
      .filter((record) => record.repoId === input.repoId && record.taskId === input.taskId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.operationId.localeCompare(right.operationId))
      .map(diskRecord);
  }

  private async read(operationId: string): Promise<GitHubOperationDisk | undefined> {
    try {
      const raw = await this.fs.readFile(operationPath(operationId), MAX_GITHUB_STATE_BYTES);
      const parsed = GitHubOperationDiskSchema.parse(JSON.parse(raw.toString("utf8")));
      if (
        canonicalSha256(omitDiskDigest(parsed)) !== parsed.state_sha256
        || operationPath(parsed.operationId) !== operationPath(operationId)
      ) throw githubStateTampered();
      return parsed;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw githubStateTampered();
      throw error;
    }
  }

  private async listAll(): Promise<GitHubOperationDisk[]> {
    await this.initialize();
    const entries = await this.fs.listDirectory("github-operations", MAX_GITHUB_OPERATIONS);
    const records: GitHubOperationDisk[] = [];
    for (const entry of entries) {
      if (entry.kind !== "file" || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw githubStateTampered();
      const raw = await this.fs.readFile(posix.join("github-operations", entry.name), MAX_GITHUB_STATE_BYTES);
      let parsed: GitHubOperationDisk;
      try {
        parsed = GitHubOperationDiskSchema.parse(JSON.parse(raw.toString("utf8")));
      } catch {
        throw githubStateTampered();
      }
      if (
        `${hashedDiskKey("github-operation", parsed.operationId)}.json` !== entry.name
        || canonicalSha256(omitDiskDigest(parsed)) !== parsed.state_sha256
      ) throw githubStateTampered();
      records.push(parsed);
    }
    return records;
  }

  private async write(
    value: Omit<GitHubOperationDisk, "state_sha256">,
    exclusive = false
  ): Promise<GitHubOperationDisk> {
    const parsed = GitHubOperationDiskSchema.parse({
      ...value,
      state_sha256: canonicalSha256(value)
    });
    await this.fs.atomicWrite(operationPath(parsed.operationId), `${canonicalJson(parsed)}\n`, { exclusive });
    return parsed;
  }
}

const ArtifactIndexSchema = z.object({
  schema_version: z.literal(1),
  namespace: z.enum([
    "github-remote-evidence",
    "github-push-evidence",
    "github-pr-evidence",
    "github-merge-gates",
    "github-ci-evidence",
    "github-review-evidence",
    "github-merge-evidence",
    "github-post-merge-evidence"
  ]),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  repo_id: z.string().min(1).max(200),
  task_id: z.string().min(1).max(128),
  artifact_id: z.string().regex(/^artifact_[A-Za-z0-9_-]{16,160}$/),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  state_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

type ArtifactIndex = z.infer<typeof ArtifactIndexSchema>;

export class TaskArtifactGitHubSink implements ContentAddressedArtifactSink {
  constructor(
    private readonly tasks: TaskLookup,
    private readonly artifacts: TaskArtifactStore,
    private readonly fs: SecureRuntimeFs,
    private readonly locks: CrossProcessLockManager
  ) {}

  async putJson(input: {
    namespace: GitHubArtifactNamespace;
    digest: string;
    value: JsonValue;
    mode: 0o600;
  }): Promise<{ artifactId: string }> {
    if (input.mode !== 0o600 || sha256Json(input.value) !== input.digest) {
      throw new GitHubBoundaryError("ARTIFACT_DIGEST_MISMATCH", "GitHub evidence is not bound to its exact canonical digest.");
    }
    const identity = artifactIdentity(input.value);
    const task = await this.tasks.getServerOwnedTask(identity.repoId);
    if (task.taskId !== identity.taskId) throw new GitHubBoundaryError("ARTIFACT_TASK_MISMATCH", "GitHub evidence task identity is not current.");
    return this.locks.withLock(`github-artifact:${input.namespace}:${input.digest}`, async () => {
      const existing = await this.readIndex(input.namespace, input.digest);
      if (existing) {
        if (existing.repo_id !== identity.repoId || existing.task_id !== identity.taskId) throw githubStateTampered();
        return { artifactId: existing.artifact_id };
      }
      const metadata = await this.artifacts.put({
        task_id: task.taskId,
        kind: artifactKind(input.namespace),
        media_type: "application/json",
        logical_path: `github/${input.namespace}/${input.digest}.json`,
        content: `${canonicalJson(input.value)}\n`
      });
      const unsigned = {
        schema_version: 1 as const,
        namespace: input.namespace,
        digest: input.digest,
        repo_id: identity.repoId,
        task_id: identity.taskId,
        artifact_id: metadata.artifact_id,
        content_sha256: metadata.content_sha256
      };
      const index = ArtifactIndexSchema.parse({ ...unsigned, state_sha256: canonicalSha256(unsigned) });
      await this.fs.atomicWrite(artifactIndexPath(input.namespace, input.digest), `${canonicalJson(index)}\n`, { exclusive: true });
      return { artifactId: metadata.artifact_id };
    });
  }

  async getJson(input: { namespace: GitHubArtifactNamespace; digest: string }): Promise<JsonValue | undefined> {
    const index = await this.readIndex(input.namespace, input.digest);
    if (!index) return undefined;
    const loaded = await this.readArtifact(index.task_id, index.artifact_id);
    if (loaded.metadata.content_sha256 !== index.content_sha256 || sha256Json(loaded.value) !== input.digest) {
      throw githubStateTampered();
    }
    return loaded.value;
  }

  async reference(taskId: string, artifactId: string): Promise<TaskArtifactMetadata> {
    const metadata = (await this.artifacts.listMetadata(taskId, { limit: 10_000 }))
      .find((candidate) => candidate.artifact_id === artifactId);
    if (!metadata) throw new GitHubBoundaryError("ARTIFACT_NOT_FOUND", "Task-owned GitHub evidence artifact is unavailable.");
    return metadata;
  }

  async readArtifact(taskId: string, artifactId: string): Promise<{ metadata: TaskArtifactMetadata; value: JsonValue }> {
    const chunks: Buffer[] = [];
    let offset = 0;
    let metadata: TaskArtifactMetadata | undefined;
    while (true) {
      const part = await this.artifacts.read({ task_id: taskId, artifact_id: artifactId, offset, length: 65_536 });
      metadata = part.artifact;
      chunks.push(Buffer.from(part.content_base64, "base64"));
      offset += part.length;
      if (part.eof) break;
      if (offset > MAX_ARTIFACT_BYTES) throw new GitHubBoundaryError("ARTIFACT_TOO_LARGE", "GitHub evidence exceeds the fixed read bound.");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw githubStateTampered();
    }
    return { metadata: metadata!, value: JsonValueSchema.parse(value) };
  }

  private async readIndex(namespace: GitHubArtifactNamespace, digest: string): Promise<ArtifactIndex | undefined> {
    try {
      const raw = await this.fs.readFile(artifactIndexPath(namespace, digest), 64 * 1024);
      const parsed = ArtifactIndexSchema.parse(JSON.parse(raw.toString("utf8")));
      if (
        parsed.namespace !== namespace
        || parsed.digest !== digest
        || canonicalSha256(omitStateDigest(parsed)) !== parsed.state_sha256
      ) throw githubStateTampered();
      return parsed;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw githubStateTampered();
      throw error;
    }
  }
}

export class RegistryTaskLookup implements TaskLookup {
  constructor(
    private readonly registry: RootRegistry,
    private readonly taskRuntime: TaskRuntimeService
  ) {}

  async getServerOwnedTask(repoId: string): Promise<ServerOwnedTask> {
    const binding = this.registry.taskBinding(repoId);
    if (!binding) throw new GitHubBoundaryError("TASK_NOT_REGISTERED", "repo_id is not a server-owned task repository.");
    if (binding.authority !== "ship") throw new GitHubBoundaryError("SHIP_AUTHORITY_REQUIRED", "GitHub lifecycle requires task ship authority.");
    const task = await this.taskRuntime.states.requireTask(binding.task_id);
    if (
      task.repo_id !== repoId
      || task.base_repo_id !== binding.base_repo_id
      || task.server_branch !== binding.branch
      || task.worktree_path !== binding.worktree
      || task.lifecycle !== "OPEN"
      || task.registration_state !== "REGISTERED"
    ) {
      throw new GitHubBoundaryError("TASK_STATE_MISMATCH", "Durable task state does not match the active task registration.");
    }
    const base = this.registry.getBase(binding.base_repo_id);
    if (!base.lifecycle || base.lifecycle.authority !== "ship") {
      throw new GitHubBoundaryError("SHIP_POLICY_REQUIRED", "Owner repository policy does not admit GitHub lifecycle effects.");
    }
    const [owner, name] = base.lifecycle.github_repository.split("/");
    if (!owner || !name) throw new GitHubBoundaryError("INVALID_REPOSITORY", "Owner GitHub repository identity is invalid.");
    return {
      repoId,
      taskId: task.task_id,
      root: task.worktree_path,
      branch: task.server_branch,
      remoteName: base.lifecycle.remote_name,
      expectedRemoteUrl: base.lifecycle.expected_remote_identity,
      repository: { owner, name },
      baseBranch: task.base_branch,
      mergeMethod: base.lifecycle.merge_method,
      requiredChecks: base.lifecycle.required_checks.map(requiredCheck),
      transientCiConclusions: base.lifecycle.transient_ci_conclusions,
      independentReviewRequired: base.lifecycle.independent_review_required
    };
  }
}

export class TaskArtifactMergeEvidenceProvider implements MergeEvidenceProvider {
  constructor(
    private readonly artifacts: TaskArtifactStore,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly githubArtifacts: TaskArtifactGitHubSink
  ) {}

  async getValidationEvidence(task: ServerOwnedTask): Promise<ValidationEvidence> {
    const local = await this.git.inspect(task);
    const candidates = (await this.artifacts.listMetadata(task.taskId, { limit: 10_000 }))
      .filter((artifact) => artifact.kind === "validation_log")
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    for (const candidate of candidates) {
      const loaded = await this.githubArtifacts.readArtifact(task.taskId, candidate.artifact_id);
      const parsed = parseValidationArtifact(loaded.value);
      if (parsed.status === "passed" && parsed.headSha === local.headSha && parsed.treeSha === local.treeSha) {
        return {
          status: "passed",
          headSha: parsed.headSha,
          treeSha: parsed.treeSha,
          validationId: parsed.validationId,
          digest: candidate.content_sha256
        };
      }
    }
    const missing = {
      semantic: "missing-validation-evidence",
      repoId: task.repoId,
      taskId: task.taskId,
      headSha: local.headSha,
      treeSha: local.treeSha
    } as const;
    return {
      status: "missing",
      headSha: local.headSha,
      treeSha: local.treeSha,
      validationId: "missing-validation",
      digest: sha256Json(missing)
    };
  }

  async getIndependentReviewEvidence(task: ServerOwnedTask): Promise<IndependentReviewEvidence> {
    const local = await this.git.inspect(task);
    if (task.independentReviewRequired === false) {
      const notRequired = {
        semantic: "independent-review-not-required",
        repoId: task.repoId,
        taskId: task.taskId,
        headSha: local.headSha,
        treeSha: local.treeSha
      } as const;
      return {
        status: "passed",
        headSha: local.headSha,
        treeSha: local.treeSha,
        reviewId: "independent-review-not-required",
        digest: sha256Json(notRequired),
        materialFindingCount: 0
      };
    }
    const [pullRequests, remote] = await Promise.all([
      this.github.findOpenPullRequests({
        repository: task.repository,
        headBranch: task.branch,
        baseBranch: task.baseBranch
      }),
      this.github.getRef(task.repository, `refs/heads/${task.branch}`)
    ]);
    const pullRequest = pullRequests.length === 1 ? pullRequests[0] : undefined;
    const exact = pullRequest?.headSha === local.headSha
      && pullRequest.headRefName === task.branch
      && remote?.sha === local.headSha
      && remote.treeSha === local.treeSha;
    const status = exact && pullRequest?.reviewDecision === "APPROVED" ? "passed" : pullRequest?.reviewDecision === "CHANGES_REQUESTED" ? "failed" : "missing";
    const value = {
      semantic: "github-independent-review",
      repoId: task.repoId,
      taskId: task.taskId,
      pullRequestNumber: pullRequest?.number ?? null,
      headSha: local.headSha,
      treeSha: local.treeSha,
      reviewDecision: pullRequest?.reviewDecision ?? null,
      status
    } as const;
    const stored = await storeGitHubEvidence(this.githubArtifacts, "github-review-evidence", value);
    return {
      status,
      headSha: local.headSha,
      treeSha: local.treeSha,
      reviewId: pullRequest ? `github-review-${pullRequest.number}-${local.headSha.slice(0, 12)}` : "missing-independent-review",
      digest: stored.digest,
      materialFindingCount: status === "failed" ? 1 : 0
    };
  }
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema)
]));

function operationPath(operationId: string): string {
  return posix.join("github-operations", `${hashedDiskKey("github-operation", operationId)}.json`);
}

function diskRecord(value: GitHubOperationDisk): GitHubOperationRecord {
  return {
    operationId: value.operationId,
    semantic: value.semantic,
    repoId: value.repoId,
    taskId: value.taskId,
    subjectDigest: value.subjectDigest,
    bindingDigest: value.bindingDigest,
    phase: value.phase,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode })
  };
}

function omitDiskDigest(value: GitHubOperationDisk): Omit<GitHubOperationDisk, "state_sha256"> {
  const unsigned = { ...value } as Partial<GitHubOperationDisk>;
  delete unsigned.state_sha256;
  return unsigned as Omit<GitHubOperationDisk, "state_sha256">;
}

function omitStateDigest<T extends { state_sha256: string }>(value: T): Omit<T, "state_sha256"> {
  const unsigned = { ...value } as Partial<T>;
  delete unsigned.state_sha256;
  return unsigned as Omit<T, "state_sha256">;
}

function artifactIndexPath(namespace: GitHubArtifactNamespace, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new GitHubBoundaryError("INVALID_ARTIFACT_DIGEST", "GitHub artifact digest is invalid.");
  return posix.join("github-artifact-index", namespace, `${digest}.json`);
}

function artifactIdentity(value: JsonValue): { repoId: string; taskId: string } {
  if (!isJsonRecord(value) || typeof value.repoId !== "string" || typeof value.taskId !== "string") {
    throw new GitHubBoundaryError("ARTIFACT_TASK_IDENTITY_MISSING", "GitHub evidence lacks its exact task identity.");
  }
  return { repoId: value.repoId, taskId: value.taskId };
}

function artifactKind(namespace: GitHubArtifactNamespace): "remote_observation" | "push_receipt" | "pull_request" | "review_evidence" | "ci_evidence" | "merge_gate_evidence" | "merge_receipt" | "post_merge_evidence" {
  switch (namespace) {
    case "github-remote-evidence": return "remote_observation";
    case "github-push-evidence": return "push_receipt";
    case "github-pr-evidence": return "pull_request";
    case "github-review-evidence": return "review_evidence";
    case "github-ci-evidence": return "ci_evidence";
    case "github-merge-gates": return "merge_gate_evidence";
    case "github-merge-evidence": return "merge_receipt";
    case "github-post-merge-evidence": return "post_merge_evidence";
  }
}

function requiredCheck(value: string | { kind: "check_run"; name: string; app_slug: string } | { kind: "commit_status"; context: string }): RequiredCheck {
  if (typeof value === "string") return { kind: "check_run", name: value, appSlug: "github-actions" };
  return value.kind === "check_run"
    ? { kind: "check_run", name: value.name, appSlug: value.app_slug }
    : { kind: "commit_status", context: value.context };
}

function parseValidationArtifact(value: JsonValue): {
  status: "passed" | "failed";
  headSha: string;
  treeSha: string;
  validationId: string;
} {
  if (
    !isJsonRecord(value)
    || typeof value.resulting_head_sha !== "string"
    || typeof value.resulting_tree_sha !== "string"
    || !isJsonRecord(value.validation)
    || typeof value.validation.validation_id !== "string"
    || (value.validation.status !== "passed" && value.validation.status !== "failed")
  ) throw githubStateTampered();
  return {
    status: value.validation.status,
    headSha: value.resulting_head_sha,
    treeSha: value.resulting_tree_sha,
    validationId: value.validation.validation_id
  };
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function githubStateTampered(): GitHubBoundaryError {
  return new GitHubBoundaryError("GITHUB_RUNTIME_STATE_TAMPERED", "Durable GitHub runtime state is malformed or digest-invalid.");
}
