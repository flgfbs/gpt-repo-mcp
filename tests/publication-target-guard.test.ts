import { describe, expect, it } from "vitest";
import type { RepositorySnapshot } from "../src/github/types.js";
import { assertWritablePublicationTarget } from "../src/services/publication-target-guard.js";
import { FIXED_TASK } from "./fixtures/github-lifecycle-fixtures.js";

const repository = (overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot => ({
  id: "R_publication_target",
  nameWithOwner: "example/project",
  defaultBranch: "main",
  archived: false,
  viewerPermission: "ADMIN",
  mergeMethods: { merge: true, squash: true, rebase: true },
  ...overrides
});

describe("publication target guard", () => {
  it.each(["WRITE", "MAINTAIN", "ADMIN"])("admits %s permission on the exact target", (viewerPermission) => {
    expect(() => assertWritablePublicationTarget(FIXED_TASK, repository({ viewerPermission }))).not.toThrow();
  });

  it.each(["", "READ", "TRIAGE"])("rejects non-writable permission %j", (viewerPermission) => {
    expect(() => assertWritablePublicationTarget(FIXED_TASK, repository({ viewerPermission }))).toThrowError(
      expect.objectContaining({ code: "PUBLICATION_TARGET_NOT_WRITABLE" })
    );
  });

  it("rejects archived and mismatched repositories", () => {
    expect(() => assertWritablePublicationTarget(FIXED_TASK, repository({ archived: true }))).toThrowError(
      expect.objectContaining({ code: "PUBLICATION_TARGET_ARCHIVED" })
    );
    expect(() => assertWritablePublicationTarget(FIXED_TASK, repository({ nameWithOwner: "other/project" }))).toThrowError(
      expect.objectContaining({ code: "PUBLICATION_TARGET_BINDING_MISMATCH" })
    );
    expect(() => assertWritablePublicationTarget(
      { ...FIXED_TASK, expectedRemoteIdentity: "github.com/other/project" },
      repository()
    )).toThrowError(expect.objectContaining({ code: "PUBLICATION_TARGET_BINDING_MISMATCH" }));
  });
});
