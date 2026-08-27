import { describe, expect, test } from "vitest";
import { CodexRunFinalizerChangedFileSchema } from "../src/contracts/codex-run-finalizer.contract.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";

describe("exact-run finalizer policy", () => {
  test("is disabled by default even when generic operations are enabled", () => {
    const policy = new OperationsPolicy({
      enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      validation_enabled: true
    });

    expect(() => policy.assertCodexRunFinalizeAllowed()).toThrowError(
      expect.objectContaining({ code: "CODEX_RUN_FINALIZE_DISABLED" })
    );
  });

  test("rejects repository paths containing control characters", () => {
    for (const path of ["src/value.py\nother", "src/value.py\r", "src/\u0001value.py", "src/\u007fvalue.py", "src/\u0085value.py"]) {
      expect(CodexRunFinalizerChangedFileSchema.safeParse({
        path,
        sha256: "a".repeat(64)
      }).success).toBe(false);
    }
  });

  test("can be enabled without enabling generic repository operations", () => {
    const policy = new OperationsPolicy({
      enabled: false,
      git_stage_enabled: false,
      git_commit_enabled: false,
      validation_enabled: false,
      cleanup_enabled: false,
      codex_run_finalize_enabled: true
    });

    expect(() => policy.assertCodexRunFinalizeAllowed()).not.toThrow();
    expect(policy.config).toMatchObject({
      enabled: false,
      git_stage_enabled: false,
      git_commit_enabled: false,
      validation_enabled: false,
      cleanup_enabled: false,
      codex_run_finalize_enabled: true
    });
  });
});
