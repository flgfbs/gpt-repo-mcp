import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerApprovalStore } from "../src/github/owner-approval-store.js";
import { FixedClock } from "./fixtures/github-lifecycle-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("OwnerApprovalStore", () => {
  it("creates mode-0600 expiring approval and atomically claims it once", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-owner-approval-"));
    roots.push(root);
    const clock = new FixedClock();
    const store = new OwnerApprovalStore(
      { getRuntimeRoot: async () => root },
      clock,
      { createOpaqueId: () => "ABCDEFGHIJKLMNOPQRSTUVWX" },
      60_000
    );
    const digest = "a".repeat(64);
    const gateId = `merge_manifest_${digest}`;

    const created = await store.create({ gateId, gateSha256: digest });
    const approvalPath = `${root}/owner-merge-approvals/${created.approvalId}.json`;
    expect((await stat(approvalPath)).mode & 0o777).toBe(0o600);
    expect(await store.inspect({ approvalId: created.approvalId, gateId, gateSha256: digest }))
      .toMatchObject({ consumed: false, gateId, gateSha256: digest });

    const claimed = await store.claim({
      approvalId: created.approvalId,
      gateId,
      gateSha256: digest,
      operationId: "merge-operation-1"
    });
    expect(claimed).toMatchObject({ consumed: true, consumedByOperationId: "merge-operation-1" });
    const claimPath = `${root}/owner-merge-approvals/${created.approvalId}.claim`;
    expect((await stat(claimPath)).mode & 0o777).toBe(0o600);

    await expect(store.claim({
      approvalId: created.approvalId,
      gateId,
      gateSha256: digest,
      operationId: "merge-operation-2"
    })).rejects.toMatchObject({ code: "APPROVAL_CONSUMED" });
  });

  it("rejects an expired approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-owner-expiry-"));
    roots.push(root);
    const clock = new FixedClock();
    const store = new OwnerApprovalStore(
      { getRuntimeRoot: async () => root },
      clock,
      { createOpaqueId: () => "ZYXWVUTSRQPONMLKJIHGFEDC" },
      1_000
    );
    const digest = "b".repeat(64);
    const gateId = `merge_manifest_${digest}`;
    const created = await store.create({ gateId, gateSha256: digest });
    clock.advance(1_001);

    await expect(store.inspect({ approvalId: created.approvalId, gateId, gateSha256: digest }))
      .rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  });
});
