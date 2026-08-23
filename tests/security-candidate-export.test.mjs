import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/export-security-candidate.mjs");
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("security candidate export", () => {
  test("exports a clean exact-HEAD tracked tree to a private external report", async () => {
    const fixture = await gitFixture();
    const output = join(fixture.parent, "candidate.json");
    await execFileAsync(process.execPath, [scriptPath, "--output", output], { cwd: fixture.root });
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report).toMatchObject({
      schema_version: 1,
      source_commit: fixture.commit,
      tree_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      files: [{ path: "README.md", bytes: 10, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]
    });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  test("rejects a dirty candidate before creating a report", async () => {
    const fixture = await gitFixture();
    const output = join(fixture.parent, "dirty-candidate.json");
    await writeFile(join(fixture.root, "untracked.txt"), "dirty\n");
    await expect(execFileAsync(process.execPath, [scriptPath, "--output", output], { cwd: fixture.root }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("requires a clean worktree") });
  });
});

async function gitFixture() {
  const parent = await mkdtemp(join(tmpdir(), "security-candidate-export-"));
  roots.push(parent);
  const root = join(parent, "candidate");
  await execFileAsync("git", ["init", "-b", "main", root]);
  await execFileAsync("git", ["config", "user.name", "Security Export Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "security@example.com"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "Initial fixture"], { cwd: root });
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { parent, root, commit };
}
