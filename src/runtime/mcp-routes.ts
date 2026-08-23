export function buildMcpRoutePatterns(): string[] {
  return ["/mcp"];
}

export function sanitizeMcpRouteForAudit(path: string): "/mcp" {
  void path;
  return "/mcp";
}

export function isAuthorizedMcpPath(path: string): boolean {
  return path === "/mcp";
}
