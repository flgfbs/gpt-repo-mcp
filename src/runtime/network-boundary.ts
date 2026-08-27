const DEFAULT_SERVER_HOST = "127.0.0.1";

export function resolveServerHost(env: NodeJS.ProcessEnv): string {
  const host = env.CHAT_PRO_REPOSITORY_MCP_HOST?.trim() || DEFAULT_SERVER_HOST;
  if (!isLoopbackHostname(host)) {
    throw new Error(`Refusing non-loopback MCP bind on ${host}. Chat Pro Repository MCP is loopback-only.`);
  }
  return host;
}

export function isAllowedBrowserOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(`http://${hostHeader ?? ""}`);
    return originUrl.protocol === "http:"
      && isLoopbackHostname(originUrl.hostname)
      && isLoopbackHostname(requestUrl.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
