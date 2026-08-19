export interface AllowlistSource {
  baseUrl?: string;
  allowedHosts?: string[];
}

export interface RegistryIndex {
  sources?: AllowlistSource[];
}

const IPV6_RE = /:/;
const LOCALHOST_RE = /(^|\.)localhost$/;
const NUMERIC_HOST_RE = /^[\d.]+$/;
const HEX_IP_RE = /^0x[0-9a-f]+$/i;

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

export function parseHost(input: string): string | null {
  let host: string;
  try {
    host = new URL(input).hostname;
  } catch {
    return null;
  }
  if (host === "") return null;
  return stripTrailingDot(host.toLowerCase());
}

export function isSuspiciousHost(host: string): boolean {
  const h = stripTrailingDot(host);
  if (IPV6_RE.test(h)) return true;
  if (NUMERIC_HOST_RE.test(h)) return true;
  if (HEX_IP_RE.test(h)) return true;
  if (LOCALHOST_RE.test(h)) return true;
  return h.endsWith(".local") || h.endsWith(".internal");
}

export function isValidDomain(host: string): boolean {
  if (NUMERIC_HOST_RE.test(host)) return false;
  return (
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      host,
    )
  );
}

export function deriveAllowedHosts(
  sources: AllowlistSource[],
): Set<string> {
  const hosts = new Set<string>();
  for (const source of sources) {
    if (source.baseUrl) {
      const host = parseHost(source.baseUrl);
      if (host && isValidDomain(host)) hosts.add(host);
    }
    for (const h of source.allowedHosts ?? []) {
      const host = parseHost(`https://${h}`);
      if (host && isValidDomain(host)) hosts.add(host);
    }
  }
  return hosts;
}

export function mergeExtraHosts(hosts: Set<string>, extra: string): Set<string> {
  const merged = new Set(hosts);
  for (const raw of extra.split(/[\s,]+/)) {
    if (!raw) continue;
    const host = parseHost(raw.includes("://") ? raw : `https://${raw}`);
    if (host && isValidDomain(host) && !isSuspiciousHost(host)) merged.add(host);
  }
  return merged;
}

export function isSafelistedHost(host: string, allowed: Set<string>): boolean {
  if (isSuspiciousHost(host)) return false;
  const lowered = stripTrailingDot(host.toLowerCase());
  for (const domain of allowed) {
    if (lowered === domain) return true;
    if (lowered.endsWith(`.${domain}`)) return true;
  }
  return false;
}

export function assertSafelistedUrl(
  rawUrl: string,
  allowed: Set<string>,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("non-http(s) URL");
  }
  if (url.username || url.password) throw new Error("URL with credentials");
  const host = url.hostname.toLowerCase();
  if (!isSafelistedHost(host, allowed)) {
    throw new Error(`host not allowed: ${host}`);
  }
  return url;
}