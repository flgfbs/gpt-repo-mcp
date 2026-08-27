import { describe, expect, it } from "vitest";
import { GitHubOperationController } from "../src/github/operation-controller.js";
import { GitHubBoundaryError } from "../src/github/types.js";
import { FixedClock, MemoryOperationLedger } from "./fixtures/github-lifecycle-fixtures.js";

describe("GitHubOperationController", () => {
  it("returns the stored disposition for an exact duplicate and conflicts on binding drift", async () => {
    const ledger = new MemoryOperationLedger();
    const controller = new GitHubOperationController(ledger, new FixedClock());
    const input = {
      operationId: "operation-0001",
      semantic: "repo_write_push" as const,
      repoId: "repo-1",
      taskId: "task-1",
      subject: { branch: "task/change" },
      binding: { head: "1111111111111111111111111111111111111111" }
    };
    const first = await controller.admit(input);
    expect(first.disposition).toBe("EXECUTE");

    const duplicate = await controller.admit(input);
    expect(duplicate).toMatchObject({ disposition: "STORED", record: { phase: "ADMITTED" } });

    await expect(controller.admit({ ...input, binding: { head: "2222222222222222222222222222222222222222" } }))
      .rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });
  });

  it("makes UNKNOWN_AFTER_CONTACT terminal and never readmits it for replay", async () => {
    const controller = new GitHubOperationController(new MemoryOperationLedger(), new FixedClock());
    const admitted = await controller.admit({
      operationId: "operation-unknown",
      semantic: "repo_write_merge",
      repoId: "repo-1",
      taskId: "task-1",
      subject: { manifestId: "gate" },
      binding: { digest: "a".repeat(64) }
    });
    if (admitted.disposition !== "EXECUTE") throw new Error("unexpected stored admission");
    let record = await controller.transition(admitted.record, "EXTERNAL_PRECONTACT");
    record = await controller.transition(record, "EXTERNAL_CONTACTED");
    record = await controller.transition(record, "UNKNOWN_AFTER_CONTACT");

    await expect(controller.transition(record, "EXTERNAL_PRECONTACT"))
      .rejects.toBeInstanceOf(GitHubBoundaryError);
    const duplicate = await controller.admit({
      operationId: "operation-unknown",
      semantic: "repo_write_merge",
      repoId: "repo-1",
      taskId: "task-1",
      subject: { manifestId: "gate" },
      binding: { digest: "a".repeat(64) }
    });
    expect(duplicate).toMatchObject({ disposition: "STORED", record: { phase: "UNKNOWN_AFTER_CONTACT" } });
  });
});
