import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyAudit,
  classifyEmailOccurrences,
  classifyLicenseRecords,
  installedLicenseRecords
} from "../scripts/oss-security-scan.mjs";

describe("OSS security scan policy", () => {
  test("reports unclassified email locations without returning addresses", () => {
    const privateFixture = ["private", "@", "personal.invalid"].join("");
    const result = classifyEmailOccurrences([
      {
        address: "person@example.com",
        location: { source: "candidate", path: "README.md", line: 1 }
      },
      {
        address: privateFixture,
        location: { source: "commit_metadata", commit: "a".repeat(40), role: "author" }
      }
    ], {
      allowed_domains: ["example.com"],
      allowed_addresses: [],
      reviewed_public_history_locations: []
    });

    expect(result).toEqual({
      occurrence_count: 2,
      allowed_count: 1,
      reviewed_history_count: 0,
      unclassified: [
        { source: "commit_metadata", commit: "a".repeat(40), role: "author" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain(privateFixture);
  });

  test("allows only exact reviewed public-history metadata locations", () => {
    const privateFixture = ["private", "@", "personal.invalid"].join("");
    const reviewedCommit = "a".repeat(40);
    const result = classifyEmailOccurrences([
      {
        address: privateFixture,
        location: {
          source: "commit_metadata",
          commit: reviewedCommit,
          role: "author"
        }
      },
      {
        address: privateFixture,
        location: {
          source: "commit_metadata",
          commit: reviewedCommit,
          role: "committer"
        }
      }
    ], {
      allowed_domains: [],
      allowed_addresses: [],
      reviewed_public_history_locations: [
        {
          commit: reviewedCommit,
          roles: ["author"],
          context: "reviewed fixture"
        }
      ]
    });

    expect(result).toEqual({
      occurrence_count: 2,
      allowed_count: 1,
      reviewed_history_count: 1,
      unclassified: [
        {
          source: "commit_metadata",
          commit: reviewedCommit,
          role: "committer"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain(privateFixture);
  });

  test("classifies every installed package license", () => {
    expect(classifyLicenseRecords([
      { name: "allowed", version: "1.0.0", license: "MIT" },
      { name: "review", version: "2.0.0", license: "Custom" }
    ], ["MIT"])).toMatchObject({
      package_count: 2,
      license_counts: { Custom: 1, MIT: 1 },
      unapproved: [{ name: "review", version: "2.0.0", license: "Custom" }]
    });
  });

  test("ignores package-manager caches while inventorying installed licenses", async () => {
    const root = await mkdtemp(join(tmpdir(), "security-license-inventory-"));
    try {
      await mkdir(join(root, "node_modules", ".vite", "deps"), { recursive: true });
      await mkdir(join(root, "node_modules", "fixture-package"), { recursive: true });
      await writeFile(join(root, "node_modules", "fixture-package", "package.json"), JSON.stringify({
        name: "fixture-package",
        version: "1.0.0",
        license: "MIT"
      }));
      await expect(installedLicenseRecords(root)).resolves.toEqual([{
        name: "fixture-package",
        version: "1.0.0",
        license: "MIT"
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("separates production, known development, and unknown advisories", () => {
    const result = classifyAudit({
      vulnerabilities: {
        "known-dev": { severity: "high", isDirect: false, fixAvailable: true },
        "unknown-dev": { severity: "low", isDirect: false, fixAvailable: false }
      }
    }, {
      vulnerabilities: {}
    }, {
      known_development_advisories: [
        { package: "known-dev", severity: "high", review_by: "2099-01-01" }
      ]
    }, new Date("2026-07-30T00:00:00Z"));

    expect(result.production.total).toBe(0);
    expect(result.development.total).toBe(2);
    expect(result.unknown_development).toEqual([
      { package: "unknown-dev", severity: "low", direct: false, fix_available: false }
    ]);
    expect(result.expired_development).toEqual([]);
  });
});
