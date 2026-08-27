import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { OperationsPolicy } from "../src/services/operations-policy.js";
import { ValidationService } from "../src/services/validation-service.js";

describe("repository-owned exec validation profile", () => {
  test("runs one fixed executable and binds its SHA-256 identity", async () => {
    const root = await fixtureRoot();
    const service = new ValidationService(root, policy({
      runner: "exec",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('validated')"]
    }));

    const result = await service.validate({ repo_id: "fixture", profile: "smoke" });

    expect(result.status).toBe("passed");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.executable_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.commands[0]?.stdout_tail).toBe("validated");
  });

  test("rejects shell executable profiles before process invocation", async () => {
    const root = await fixtureRoot();
    const service = new ValidationService(root, policy({
      runner: "exec",
      executable: "/bin/sh",
      args: ["-c", "exit 0"]
    }));

    await expect(service.validate({ repo_id: "fixture", profile: "smoke" }))
      .rejects.toMatchObject({ code: "VALIDATION_PROFILE_UNAVAILABLE" });
  });

  test("rejects credential-bearing configured environment names", async () => {
    const root = await fixtureRoot();
    const service = new ValidationService(root, policy({
      runner: "exec",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: { API_TOKEN: "not-a-real-secret" }
    }));

    await expect(service.validate({ repo_id: "fixture", profile: "smoke" }))
      .rejects.toMatchObject({ code: "VALIDATION_PROFILE_UNAVAILABLE" });
  });
});

function policy(profile: {
  runner: "exec";
  executable: string;
  args: string[];
  env?: Record<string, string>;
}): OperationsPolicy {
  return new OperationsPolicy({
    enabled: true,
    validation_enabled: true,
    validation_profiles: { smoke: profile }
  });
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chat-pro-validation-profile-"));
  await writeFile(join(root, "package.json"), "{}\n");
  return root;
}
