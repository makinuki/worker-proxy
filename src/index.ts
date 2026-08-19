import {
  deriveAllowedHosts,
  mergeExtraHosts,
  type AllowlistSource,
} from "./allowlist";
import { CORS_HEADERS, errJson, okCors, relayRequest, streamImage } from "./proxy";

const VERSION = "1.0.0";

interface AllowlistState {
  hosts: Set<string>;
  expiresAt: number;
}

const state: AllowlistState = { hosts: new Set(), expiresAt: 0 };

async function refreshAllowlist(env: Env): Promise<Set<string>> {
  const now = Date.now();
  if (now < state.expiresAt) return state.hosts;

  const ttlSeconds = Number(env.ALLOWLIST_REFRESH_SECONDS ?? 3600) || 3600;
  let traces = 0;
  for (;;) {
    try {
      const res = await fetch(
        env.REGISTRY_URL ?? "https://makinuki.github.io/index.json",
      );
      if (res.ok) {
        const index = (await res.json()) as { sources?: AllowlistSource[] };
        const hosts = deriveAllowedHosts(index.sources ?? []);
        state.hosts = mergeExtraHosts(hosts, env.EXTRA_ALLOWED_HOSTS ?? "");
        state.expiresAt = now + ttlSeconds * 1000;
        return state.hosts;
      }
    } catch {
      // fall through to retry/backoff below
    }
    traces++;
    if (traces >= 3) break;
    await new Promise((r) => setTimeout(r, 1000 * traces));
  }
  if (state.hosts.size === 0) {
    state.hosts = mergeExtraHosts(new Set(), env.EXTRA_ALLOWED_HOSTS ?? "");
    state.expiresAt = now + Math.min(ttlSeconds, 60) * 1000;
  }
  return state.hosts;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return okCors();

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/proxy") {
      const allowed = await refreshAllowlist(env);
      return relayRequest(request, env, allowed);
    }
    if (request.method === "GET" && url.pathname === "/proxy") {
      const allowed = await refreshAllowlist(env);
      return streamImage(request, env, ctx, allowed);
    }
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      const allowed = await refreshAllowlist(env);
      return Response.json(
        { status: "ok", version: VERSION, allowlistCount: allowed.size },
        { headers: CORS_HEADERS },
      );
    }
    return errJson(404, "NOT_FOUND", "not found");
  },
};