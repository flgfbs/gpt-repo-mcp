import { describe, expect, test } from "vitest";
import { githubRepositoryFromIdentity, normalizeRemoteIdentity } from "../src/services/remote-identity.js";

describe("remote identity", () => {
  test.each([
    ["https://user:secret@github.com/Owner/Repo.git?token=hidden#x", "github.com/Owner/Repo"],
    ["git@github.com:Owner/Repo.git", "github.com/Owner/Repo"],
    ["ssh://git@github.com/Owner/Repo.git", "github.com/Owner/Repo"],
    ["github.com/Owner/Repo", "github.com/Owner/Repo"]
  ])("normalizes credential-safe repository identity", (input, expected) => {
    expect(normalizeRemoteIdentity(input)).toBe(expected);
  });

  test("normalizes absolute local bare remotes", () => {
    expect(normalizeRemoteIdentity("/tmp/example.git")).toBe("file:/tmp/example.git");
  });

  test("extracts GitHub owner and repository without credentials", () => {
    expect(githubRepositoryFromIdentity("git@github.com:Owner/Repo.git")).toBe("Owner/Repo");
    expect(githubRepositoryFromIdentity("file:/tmp/example.git")).toBeUndefined();
  });

  test.each(["", "relative/path", "https://github.com/../escape.git", "ftp://github.com/a/b"])(
    "rejects unsupported or ambiguous identity %s",
    (input) => expect(() => normalizeRemoteIdentity(input)).toThrow()
  );
});
