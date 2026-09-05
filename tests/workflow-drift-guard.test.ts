import { access, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { toolCatalog } from "../src/tools/catalog.js";

const REMOVED_TOOLS = [
  "repo_plan_review",
  "repo_next_action",
  "repo_git_stage",
  "repo_git_unstage",
  "repo_git_commit"
] as const;

const ACTIVE_WORKFLOW_DOCS = [
  "README.md",
  "docs/APPROVAL_TROUBLESHOOTING.md",
  "docs/ARCHITECTURE.md",
  "docs/CAPABILITIES.md",
  "docs/DELEGATION_ARTIFACTS.md",
  "docs/PRODUCT.md",
  "docs/SECURITY.md",
  "docs/TOOL_SURFACE.md",
  "docs/WRITE_WORKFLOWS.md"
] as const;

const PUBLIC_DOCUMENTS = [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "docs/APPROVAL_TROUBLESHOOTING.md",
  "docs/ARCHITECTURE.md",
  "docs/CAPABILITIES.md",
  "docs/CHATGPT_CONNECT.md",
  "docs/CONNECTION_OPTIONS.md",
  "docs/DELEGATION_ARTIFACTS.md",
  "docs/DEPENDENCY_SECURITY.md",
  "docs/ERRORS.md",
  "docs/GLOSSARY.md",
  "docs/MIGRATION.md",
  "docs/PRODUCT.md",
  "docs/QUALITY.md",
  "docs/RELEASE_CHECKLIST.md",
  "docs/SECURITY.md",
  "docs/SETUP.md",
  "docs/TOOL_SURFACE.md",
  "docs/WRITE_WORKFLOWS.md"
] as const;

const REMOVED_SOURCE_FILES = [
  "src/contracts/review.contract.ts",
  "src/services/review-planner.ts",
  "src/contracts/next-action.contract.ts",
  "src/services/next-action-service.ts"
] as const;

describe("canonical workflow drift guards", () => {
  test("locks the intentional 67-tool surface and removed public names", () => {
    expect(toolCatalog).toHaveLength(67);
    const names = toolCatalog.map(({ name }) => name);
    for (const removed of REMOVED_TOOLS) expect(names).not.toContain(removed);
  });

  test("keeps removed planning and alias implementations physically absent", async () => {
    for (const path of REMOVED_SOURCE_FILES) {
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("keeps active workflow documentation on current public tools", async () => {
    for (const path of ACTIVE_WORKFLOW_DOCS) {
      const text = await readFile(path, "utf8");
      for (const removed of REMOVED_TOOLS) expect(text).not.toContain(removed);
      expect(text).not.toContain('"inspect_first"');
      expect(text).not.toContain('"allowed_paths"');
      expect(text).not.toContain('"context_summary"');
      expect(text).not.toContain('"include_prompt"');
    }

    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("## How ChatGPT Works");
    expect(readme).toContain("Understand");
    expect(readme).toContain("Validate");
    expect(readme).toContain("Review");

    const capabilities = await readFile("docs/CAPABILITIES.md", "utf8");
    expect(capabilities).toContain("## What Chat Pro Repository MCP Does Not Do");

    const security = await readFile("docs/SECURITY.md", "utf8");
    expect(security).toContain("## Security Model At A Glance");
    expect(security).toContain("## What Stays Local And What Is Sent To ChatGPT");
    expect(security).toContain("derives its target from the selected configured remote");
    expect(security).not.toContain("typed owner confirmation");

    const writeWorkflows = await readFile("docs/WRITE_WORKFLOWS.md", "utf8");
    expect(writeWorkflows).toMatch(/No typed repository\s+confirmation is required/u);
    expect(writeWorkflows).toMatch(/optional exact\s+assertions/u);
    expect(writeWorkflows).not.toContain("typed owner confirmation");

    const contributing = await readFile("CONTRIBUTING.md", "utf8");
    expect(contributing).toContain("canonical order");
    expect(contributing).not.toContain("exact 65-name canonical order");
    expect(contributing).not.toContain("exact 63-name canonical order");

    const toolSurface = await readFile("docs/TOOL_SURFACE.md", "utf8");
    expect(toolSurface).toContain("## Tool Groups");
    let priorHeading = -1;
    for (const { name } of toolCatalog) {
      const heading = `### \`${name}\``;
      const index = toolSurface.indexOf(heading);
      expect(index).toBeGreaterThan(priorHeading);
      expect(toolSurface.split(heading)).toHaveLength(2);
      priorHeading = index;
    }

    for (const doc of [readme, capabilities, security, toolSurface]) {
      expect(doc).not.toMatch(/\b[A-Z]{3}-\d{2}[A-Z]?(?:-[A-Z0-9]+)?\b/u);
      expect(doc).not.toContain("compatibility barrels");
      expect(doc).not.toContain("Regression tests require");
      expect(doc).not.toContain("This slice");
    }
  });

  test("keeps published documentation free of private planning language", async () => {
    for (const path of PUBLIC_DOCUMENTS) {
      const text = await readFile(path, "utf8");
      expect(text).not.toMatch(/\b[A-Z]{3}-\d{2}[A-Z]?(?:-[A-Z0-9]+)?\b/u);
      expect(text).not.toMatch(/\b(?:post-audit|this slice|next slice|future slice|renovation phase|internal preparation|later profile work|obsolete router|physical removal)\b/iu);
      expect(text).not.toMatch(/\b(?:source-only|sanitized public export|export candidate|release-generation report|projected OSS lockfile)\b/iu);
    }
  });

  test("prevents planning and drift services from becoming competing authority engines", async () => {
    const changePlan = await readFile("src/services/change-plan-service.ts", "utf8");
    expect(changePlan).not.toMatch(/TaskInventoryService|AgentRunsService|WorkSessionService|DecisionLogService/);

    const drift = await readFile("src/services/delegation-drift-service.ts", "utf8");
    expect(drift).not.toMatch(/recommendation|next_action|next_tool_payloads|priority/);

    const instructions = await readFile("src/instructions.ts", "utf8");
    expect(instructions).toContain("The canonical direct-development path is");
    expect(instructions).toContain("Add inventory, memory, patchsets, delegation, semantic review, or granular Git only when needed");
  });
});
