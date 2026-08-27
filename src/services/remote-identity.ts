import { isAbsolute, normalize, resolve } from "node:path";
import { RepoReaderError } from "../runtime/errors.js";

export function normalizeRemoteIdentity(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.includes("\0")) {
    throw new RepoReaderError("VALIDATION_ERROR", "Remote identity is empty or invalid.");
  }

  if (isAbsolute(candidate)) {
    return `file:${normalize(resolve(candidate))}`;
  }

  if (candidate.startsWith("file://")) {
    const url = new URL(candidate);
    if (url.hostname && url.hostname !== "localhost") {
      throw new RepoReaderError("VALIDATION_ERROR", "Non-local file remotes are not supported.");
    }
    return `file:${normalize(decodeURIComponent(url.pathname))}`;
  }

  if (candidate.startsWith("file:")) {
    const path = candidate.slice("file:".length);
    if (!isAbsolute(path)) {
      throw new RepoReaderError("VALIDATION_ERROR", "Canonical file remote identity must contain an absolute path.");
    }
    return `file:${normalize(path)}`;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const rawPath = candidate.slice(candidate.indexOf("://") + 3).replace(/^[^/]+/, "").split(/[?#]/, 1)[0] ?? "";
    if (decodeURIComponent(rawPath).split("/").includes("..")) {
      throw new RepoReaderError("VALIDATION_ERROR", "Remote identity path contains traversal.");
    }
    const url = new URL(candidate);
    if (!url.hostname) {
      throw new RepoReaderError("VALIDATION_ERROR", "Remote URL has no host.");
    }
    if (!new Set(["http:", "https:", "ssh:", "git:"]).has(url.protocol)) {
      throw new RepoReaderError("VALIDATION_ERROR", "Remote URL protocol is not supported.");
    }
    return hostPathIdentity(url.hostname, url.port, url.pathname);
  }

  const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(candidate);
  if (scp) {
    return hostPathIdentity(scp[1]!, "", scp[2]!);
  }

  if (/^[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+(?:\.git)?$/.test(candidate)) {
    const slash = candidate.indexOf("/");
    return hostPathIdentity(candidate.slice(0, slash), "", candidate.slice(slash + 1));
  }

  throw new RepoReaderError("VALIDATION_ERROR", "Remote identity format is not supported.");
}

export function githubRepositoryFromIdentity(identity: string): string | undefined {
  const normalized = normalizeRemoteIdentity(identity);
  if (!normalized.toLowerCase().startsWith("github.com/")) return undefined;
  const repository = normalized.slice("github.com/".length);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : undefined;
}

function hostPathIdentity(hostname: string, port: string, rawPath: string): string {
  const host = hostname.toLowerCase();
  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const hostLooksNetworked = host === "localhost" || host.includes(".") || /^\[[0-9a-f:]+\]$/i.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (!hostLooksNetworked || !path || path.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new RepoReaderError("VALIDATION_ERROR", "Remote identity path is invalid.");
  }
  return `${host}${port ? `:${port}` : ""}/${path}`;
}
