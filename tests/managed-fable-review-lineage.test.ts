import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import type { RepoRunFableReviewInput } from "../src/contracts/fable-review.contract.js";
import {
  FakeFableLauncher,
  commitTaskChange,
  initialInput,
  managedTaskFixture,
  type TaskFixture
} from "./fixtures/fable-review-fixture.js";

const fixtures: TaskFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.parent, { recursive: true, force: true })));
});

describe("managed Fable focused-rereview lineage", () => {
  test("preserves a retained REVISE lineage on one changed-target focused successor", async () => {
    const fixture = await trackedFixture();
    const firstHead = await commitTaskChange(
      fixture.taskRoot,
      "reviewed.ts",
      "export const value = 1;\n"
    );
    const launcher = new FakeFableLauncher(["REVISE", "PASS"]);
    const service = fixture.service(launcher);
    const initial = await service.run(initialInput(
      fixture,
      firstHead,
      "operation-fable-initial-revise"
    ));
    expect(initial).toMatchObject({
      review_state: "review_completed",
      provider_contact: "YES",
      review_result: { review_status: "REVISE" },
      lineage: { kind: "initial" }
    });

    const correctedHead = await commitTaskChange(
      fixture.taskRoot,
      "reviewed.ts",
      "export const value = 2;\n"
    );
    const focused: RepoRunFableReviewInput = {
      operation_id: "operation-fable-focused-pass",
      repo_id: fixture.taskRepoId,
      task_id: fixture.taskId,
      expected_base_commit_sha: fixture.baseCommit,
      expected_base_tree_sha: fixture.baseTree,
      expected_head_sha: correctedHead.head,
      expected_tree_sha: correctedHead.tree,
      review_kind: "focused_rereview",
      scope: { kind: "focused_paths", paths: ["reviewed.ts"] },
      prior_review_artifact_id: initial.artifact!.artifact_id
    };
    const rereview = await service.run(focused);
    expect(rereview).toMatchObject({
      review_state: "review_completed",
      provider_contact: "YES",
      review_result: { review_status: "PASS" },
      lineage: {
        kind: "focused_rereview",
        prior_review_artifact_id: initial.artifact!.artifact_id
      }
    });
    expect(rereview.lineage!.lineage_id).toBe(initial.lineage!.lineage_id);
    expect(rereview.lineage!.epoch_id).not.toBe(initial.lineage!.epoch_id);
    expect(launcher.invocationCount).toBe(2);
    expect(launcher.requests[0]?.operation).toMatchObject({
      kind: "INITIAL",
      route: "PRIMARY",
      prior_attempt_id: "NONE"
    });
    expect(launcher.requests[1]?.operation).toMatchObject({
      kind: "FOCUSED_REREVIEW",
      route: "PRIMARY",
      prior_attempt_id: initial.receipt!.attempt_id,
      causal_repair: {
        basis: "CAUSAL_REPAIR",
        evidence_digest: `sha256:${initial.receipt!.receipt_sha256}`
      }
    });

    const replay = await service.run({
      ...focused,
      operation_id: "operation-fable-focused-replay"
    });
    expect(replay).toMatchObject({
      review_state: "failed_precontact",
      provider_contact: "NO",
      outcome_code: "STOP_MANAGED_REVIEW_REPLAY_BLOCKED"
    });
    expect(launcher.invocationCount).toBe(2);
  });

  test("rejects a focused successor when only an unrelated path changed", async () => {
    const fixture = await trackedFixture();
    const firstHead = await commitTaskChange(
      fixture.taskRoot,
      "reviewed.ts",
      "export const value = 1;\n"
    );
    const launcher = new FakeFableLauncher(["REVISE"]);
    const service = fixture.service(launcher);
    const initial = await service.run(initialInput(
      fixture,
      firstHead,
      "operation-fable-unrelated-initial"
    ));
    const unrelatedHead = await commitTaskChange(
      fixture.taskRoot,
      "unrelated.ts",
      "export const unrelated = true;\n"
    );
    const rejected = await service.run({
      operation_id: "operation-fable-unrelated-focused",
      repo_id: fixture.taskRepoId,
      task_id: fixture.taskId,
      expected_base_commit_sha: fixture.baseCommit,
      expected_base_tree_sha: fixture.baseTree,
      expected_head_sha: unrelatedHead.head,
      expected_tree_sha: unrelatedHead.tree,
      review_kind: "focused_rereview",
      scope: { kind: "focused_paths", paths: ["reviewed.ts"] },
      prior_review_artifact_id: initial.artifact!.artifact_id
    });
    expect(rejected).toMatchObject({
      review_state: "failed_precontact",
      provider_contact: "NO",
      outcome_code: "STOP_MANAGED_FOCUSED_SCOPE_UNCHANGED"
    });
    expect(launcher.invocationCount).toBe(1);
  });

  test("rejects an unchanged target or a retained PASS as a focused predecessor before contact", async () => {
    const fixture = await trackedFixture();
    const firstHead = await commitTaskChange(
      fixture.taskRoot,
      "reviewed.ts",
      "export const value = 1;\n"
    );
    const launcher = new FakeFableLauncher(["PASS"]);
    const service = fixture.service(launcher);
    const initial = await service.run(initialInput(
      fixture,
      firstHead,
      "operation-fable-initial-pass"
    ));
    const focused: RepoRunFableReviewInput = {
      operation_id: "operation-fable-ineligible-focused",
      repo_id: fixture.taskRepoId,
      task_id: fixture.taskId,
      expected_base_commit_sha: fixture.baseCommit,
      expected_base_tree_sha: fixture.baseTree,
      expected_head_sha: firstHead.head,
      expected_tree_sha: firstHead.tree,
      review_kind: "focused_rereview",
      scope: { kind: "focused_paths", paths: ["reviewed.ts"] },
      prior_review_artifact_id: initial.artifact!.artifact_id
    };
    const rejected = await service.run(focused);
    expect(rejected).toMatchObject({
      review_state: "failed_precontact",
      provider_contact: "NO",
      outcome_code: "STOP_MANAGED_PRIOR_REVIEW_NOT_ELIGIBLE"
    });
    expect(launcher.invocationCount).toBe(1);
  });
});

async function trackedFixture(): Promise<TaskFixture> {
  const fixture = await managedTaskFixture();
  fixtures.push(fixture);
  return fixture;
}
