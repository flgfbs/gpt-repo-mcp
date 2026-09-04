import { rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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

describe("managed exact-head Fable review service", () => {
  test("rejects stale bindings, dirty worktrees, and preflight failures before contact", async () => {
    const fixture = await trackedFixture();
    const committed = await commitTaskChange(fixture.taskRoot, "reviewed.ts", "export const value = 1;\n");
    const launcher = new FakeFableLauncher(["PASS"]);
    const service = fixture.service(launcher);

    const stale = await service.run(initialInput(fixture, committed, "operation-fable-stale", {
      expected_head_sha: "0".repeat(40)
    }));
    expect(stale).toMatchObject({ review_state: "failed_precontact", provider_contact: "NO" });
    expect(launcher.invocationCount).toBe(0);

    const staleTree = await service.run(initialInput(fixture, committed, "operation-fable-stale-tree", {
      expected_tree_sha: "0".repeat(40)
    }));
    expect(staleTree).toMatchObject({ review_state: "failed_precontact", provider_contact: "NO" });
    expect(launcher.invocationCount).toBe(0);

    const dirtyPath = join(fixture.taskRoot, "dirty-untracked.txt");
    await writeFile(dirtyPath, "dirty\n");
    const dirty = await service.run(initialInput(fixture, committed, "operation-fable-dirty"));
    expect(dirty).toMatchObject({ review_state: "failed_precontact", provider_contact: "NO" });
    expect(launcher.invocationCount).toBe(0);
    await unlink(dirtyPath);

    const preflightFailure = new FakeFableLauncher(["PASS"], "STOP_MANAGED_LAUNCHER_DESCRIBE_FAILED");
    const failed = await fixture.service(preflightFailure)
      .run(initialInput(fixture, committed, "operation-fable-preflight"));
    expect(failed).toMatchObject({
      review_state: "failed_precontact",
      provider_contact: "NO",
      effect_disposition: "NO_EXTERNAL_EFFECT",
      outcome_code: "STOP_MANAGED_LAUNCHER_DESCRIBE_FAILED"
    });
    expect(preflightFailure.invocationCount).toBe(0);
  });

  test("permits one successful contact, emits sanitized evidence, and rejects duplicate or replay", async () => {
    const fixture = await trackedFixture();
    const committed = await commitTaskChange(fixture.taskRoot, "reviewed.ts", "export const value = 1;\n");
    const launcher = new FakeFableLauncher(["PASS"]);
    const service = fixture.service(launcher);
    const input = initialInput(fixture, committed, "operation-fable-success");

    const result = await service.run(input);
    expect(result).toMatchObject({
      review_state: "review_completed",
      provider_contact: "YES",
      effect_disposition: "VALID_REVIEW_RESULT",
      model_class: "FABLE",
      reasoning: "MAX",
      outcome_code: "PASS",
      retry_authorized: false,
      fallback_authorized: false,
      reroute_authorized: false,
      continuation_authorized: false,
      artifact: { kind: "review_evidence" }
    });
    expect(launcher.invocationCount).toBe(1);
    const encoded = JSON.stringify(result);
    for (const forbidden of [
      "sensitive-response-marker",
      "sensitive-model-marker",
      "sensitive-route-marker",
      "sensitive-location-marker",
      "opaque_state",
      "packet_bytes",
      "request_path",
      "resolved_models"
    ]) expect(encoded).not.toContain(forbidden);

    const artifact = await fixture.bundle.artifacts.read({
      task_id: fixture.taskId,
      artifact_id: result.artifact!.artifact_id,
      offset: 0,
      length: 65_536
    });
    const artifactText = Buffer.from(artifact.content_base64, "base64").toString("utf8");
    expect(JSON.parse(artifactText)).toMatchObject({
      review_state: "review_completed",
      provider_contact: "YES",
      outcome_code: "PASS"
    });
    expect(artifactText).not.toContain("sensitive-response-marker");

    await expect(service.run(input)).rejects.toMatchObject({ code: "TASK_OPERATION_CONFLICT" });
    const replay = await service.run(initialInput(fixture, committed, "operation-fable-replay"));
    expect(replay).toMatchObject({
      review_state: "failed_precontact",
      provider_contact: "NO",
      outcome_code: "STOP_MANAGED_REVIEW_REPLAY_BLOCKED"
    });
    expect(launcher.invocationCount).toBe(1);
  });

  test("preserves contacted-incomplete and unknown effects and blocks fictitious fresh initials", async () => {
    for (const mode of ["PARTIAL", "THROW"] as const) {
      const fixture = await trackedFixture();
      const committed = await commitTaskChange(
        fixture.taskRoot,
        `${mode.toLowerCase()}.ts`,
        `export const mode = "${mode}";\n`
      );
      const launcher = new FakeFableLauncher([mode]);
      const service = fixture.service(launcher);
      const result = await service.run(initialInput(
        fixture,
        committed,
        `operation-fable-${mode.toLowerCase()}`
      ));
      expect(result.provider_contact).toBe(mode === "PARTIAL" ? "YES" : "UNKNOWN");
      expect(result.review_state).toBe(mode === "PARTIAL" ? "contacted_incomplete" : "unknown_effect");
      expect(launcher.invocationCount).toBe(1);

      const replay = await service.run(initialInput(
        fixture,
        committed,
        `operation-fable-${mode.toLowerCase()}-replay`
      ));
      expect(replay).toMatchObject({
        review_state: "failed_precontact",
        provider_contact: "NO",
        outcome_code: "STOP_MANAGED_REVIEW_REPLAY_BLOCKED"
      });
      expect(launcher.invocationCount).toBe(1);
    }
  });
});

async function trackedFixture(): Promise<TaskFixture> {
  const fixture = await managedTaskFixture();
  fixtures.push(fixture);
  return fixture;
}
