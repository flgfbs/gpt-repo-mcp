import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FableReviewClaimStore } from "../src/services/fable-review-claim-store.js";
import { hashedDiskKey, sha256Hex } from "../src/task-runtime/canonical-json.js";
import { SecureRuntimeFs } from "../src/task-runtime/secure-runtime-fs.js";

const roots: string[] = [];
const TASK_ID = "task-fable-claim";
const ADMISSION_KEY = "initial:fable_lineage_fixture";
const TARGET = {
  base_commit_sha: "1".repeat(40),
  base_tree_sha: "2".repeat(40),
  head_sha: "3".repeat(40),
  tree_sha: "4".repeat(40)
};

const commonClaim = {
  task_id: TASK_ID,
  admission_key: ADMISSION_KEY,
  epoch_id: `fable_epoch_${"5".repeat(32)}`,
  packet_sha256: "6".repeat(64),
  target: TARGET,
  launcher_sha256: "7".repeat(64),
  router_sha256: "8".repeat(64),
  recorded_at: "2026-09-04T00:00:00.000Z"
};

const commonOutcome = {
  task_id: TASK_ID,
  admission_key: ADMISSION_KEY,
  epoch_id: commonClaim.epoch_id,
  recorded_at: "2026-09-04T00:00:01.000Z"
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Fable review append-only claims", () => {
  test("does not overwrite an existing claim or outcome and preserves exact bytes", async () => {
    const fixture = await claimFixture();
    const operationId = "operation-claim-no-overwrite";
    await fixture.store.writeClaim({ ...commonClaim, operation_id: operationId });
    await fixture.store.writeOutcome({
      ...commonOutcome,
      operation_id: operationId,
      provider_contact: "NO",
      effect_disposition: "NO_EXTERNAL_EFFECT",
      outcome_code: "STOP_PREFLIGHT"
    });
    const paths = recordPaths(operationId);
    const claimBefore = await fixture.fs.readFile(paths.claim, 64 * 1024);
    const outcomeBefore = await fixture.fs.readFile(paths.outcome, 64 * 1024);

    await expect(fixture.store.writeClaim({ ...commonClaim, operation_id: operationId }))
      .rejects.toMatchObject({ code: "EEXIST" });
    await expect(fixture.store.writeOutcome({
      ...commonOutcome,
      operation_id: operationId,
      provider_contact: "YES",
      effect_disposition: "VALID_REVIEW_RESULT",
      outcome_code: "PASS"
    })).rejects.toMatchObject({ code: "EEXIST" });

    expect(await fixture.fs.readFile(paths.claim, 64 * 1024)).toEqual(claimBefore);
    expect(await fixture.fs.readFile(paths.outcome, 64 * 1024)).toEqual(outcomeBefore);
    await expect(fixture.store.assertAdmissible(TASK_ID, ADMISSION_KEY)).resolves.toBeUndefined();
  });

  test("blocks replay after contacted or unknown effect evidence", async () => {
    for (const [suffix, providerContact, effectDisposition] of [
      ["contacted", "YES", "VALID_REVIEW_RESULT"],
      ["unknown", "UNKNOWN", "UNKNOWN_EXTERNAL_EFFECT"]
    ] as const) {
      const fixture = await claimFixture();
      const operationId = `operation-claim-${suffix}`;
      await fixture.store.writeClaim({ ...commonClaim, operation_id: operationId });
      await fixture.store.writeOutcome({
        ...commonOutcome,
        operation_id: operationId,
        provider_contact: providerContact,
        effect_disposition: effectDisposition,
        outcome_code: providerContact === "YES" ? "PASS" : "STOP_UNKNOWN"
      });
      await expect(fixture.store.assertAdmissible(TASK_ID, ADMISSION_KEY))
        .rejects.toThrow("STOP_MANAGED_REVIEW_REPLAY_BLOCKED");
    }
  });

  test("fails closed on an orphaned claim whose external effect is unresolved", async () => {
    const fixture = await claimFixture();
    await fixture.store.writeClaim({
      ...commonClaim,
      operation_id: "operation-claim-orphan"
    });
    await expect(fixture.store.assertAdmissible(TASK_ID, ADMISSION_KEY))
      .rejects.toThrow("STOP_MANAGED_PRIOR_CLAIM_UNRESOLVED");
  });
});

async function claimFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fable-claim-store-")));
  roots.push(root);
  const fs = new SecureRuntimeFs(root);
  await fs.initialize();
  return { fs, store: new FableReviewClaimStore(fs) };
}

function recordPaths(operationId: string) {
  const taskKey = hashedDiskKey("fable-review-task", TASK_ID);
  const admissionHash = sha256Hex(ADMISSION_KEY);
  const operationHash = hashedDiskKey("fable-review-operation", operationId);
  const root = posix.join("fable-reviews", taskKey, admissionHash);
  return {
    claim: posix.join(root, "claims", `${operationHash}.json`),
    outcome: posix.join(root, "outcomes", `${operationHash}.json`)
  };
}
