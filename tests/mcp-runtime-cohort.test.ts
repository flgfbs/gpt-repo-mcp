import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("fixed MCP runtime cohort controller passes provider-free filesystem and restart regressions", () => {
  const result = spawnSync("python3", ["-B", "tests/test_mcp_runtime_cohort.py"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 280_000, maxBuffer: 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/Ran \d+ tests/);
  expect(result.stderr).toContain("OK");
}, 290_000);
