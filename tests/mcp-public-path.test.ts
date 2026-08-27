import { describe, expect, test } from "vitest";
import {
  buildMcpRoutePatterns,
  isAuthorizedMcpPath,
  sanitizeMcpRouteForAudit
} from "../src/runtime/mcp-routes.js";

describe("loopback MCP routing", () => {
  test("exposes only the fixed /mcp route", () => {
    expect(buildMcpRoutePatterns()).toEqual(["/mcp"]);
    expect(isAuthorizedMcpPath("/mcp")).toBe(true);
    expect(isAuthorizedMcpPath("/t/anything/mcp")).toBe(false);
  });

  test("normalizes route labels without retaining caller-controlled path text", () => {
    expect(sanitizeMcpRouteForAudit("/mcp")).toBe("/mcp");
    expect(sanitizeMcpRouteForAudit("/unexpected/private/value")).toBe("/mcp");
  });
});
