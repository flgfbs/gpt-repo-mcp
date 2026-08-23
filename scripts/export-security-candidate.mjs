import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main() {
  const outputArgument = parseOutput(process.argv.slice(2));
  const invokedRoot = await realpath(process.cwd());
  const gitRoot = await realpath(await git(invokedRoot, ["rev-parse", "--show-toplevel"]));
  if (gitRoot !== invokedRoot) {
    throw new Error("Run the candidate export from the exact Git repository root.");
  }
  const status = await git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    throw new Error("Security candidate export requires a clean worktree.");
  }

  const outputParent = await realpath(dirname(outputArgument));
  const outputPath = join(outputParent, basename(outputArgument));
  const rootPrefix = gitRoot.endsWith(sep) ? gitRoot : `${gitRoot}${sep}`;
  if (outputPath === gitRoot || outputPath.startsWith(rootPrefix)) {
    throw new Error("Write the derived security candidate report outside the repository.");
  }

  const tracked = (await gitBuffer(gitRoot, ["ls-files", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const files = [];
  for (const path of tracked) {
    const absolute = resolve(gitRoot, path);
    if (isAbsolute(path) || absolute === gitRoot || !absolute.startsWith(rootPrefix)) {
      throw new Error(`Unsafe tracked path: ${path}`);
    }
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Tracked candidate path is not a regular file: ${path}`);
    }
    const bytes = await readFile(absolute);
    files.push({
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }

  const tree = createHash("sha256");
  for (const entry of files) {
    tree.update(entry.path);
    tree.update("\0");
    tree.update(entry.sha256);
    tree.update("\0");
    tree.update(String(entry.bytes));
    tree.update("\n");
  }
  const report = {
    schema_version: 1,
    source_commit: await git(gitRoot, ["rev-parse", "HEAD"]),
    tree_sha256: tree.digest("hex"),
    files
  };

  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(`${JSON.stringify({
    source_commit: report.source_commit,
    tree_sha256: report.tree_sha256,
    file_count: files.length,
    output: outputPath
  })}\n`);
}

function parseOutput(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !isAbsolute(argv[1])) {
    throw new Error("Usage: export-security-candidate.mjs --output <absolute-path>");
  }
  return resolve(argv[1]);
}

async function git(cwd, args) {
  return (await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  })).stdout.trim();
}

async function gitBuffer(cwd, args) {
  return (await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024
  })).stdout;
}

main().catch((error) => {
  process.stderr.write(`Security candidate export failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
