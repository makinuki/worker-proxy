import { assertSafelistedUrl } from "./allowlist";

export interface RelayRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Allowlist = Set<string>;

const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_BODY_LIMIT = 5 * 1024 * 1024;
const RESPONSE_BODY_LIMIT = 20 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-makinuki-client",
  "Access-Control-Max-Age": "86400",
};

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  return out;
}

export function okCors(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function errJson(
  status: number,
  code: string,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return Response.json(
    { error: code, message, status, ...extra },
    { status, headers: CORS_HEADERS },
  );
}

export function verifyClientAuth(env: Env, request: Request): string | null {
  const token = env.CLIENT_TOKEN;
  if (token) {
    const provided = request.headers.get("x-makinuki-client");
    if (!provided || provided !== token) {
      return "missing or invalid X-MakiNuki-Client token";
    }
  }
  return null;
}

export function verifyOrigin(env: Env, request: Request): string | null {
  const allowed = (env.CLIENT_ORIGINS ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((o) => o.replace(/\/$/, ""));
  if (allowed.length === 0) return null;
  const origin = request.headers.get("origin");
  if (!origin) return "missing Origin header";
  if (!allowed.includes(origin)) return `origin not allowed: ${origin}`;
  return null;
}

export async function relayRequest(
  request: Request,
  env: Env,
  allowed: Allowlist,
): Promise<Response> {
  const authError = verifyClientAuth(env, request) ?? verifyOrigin(env, request);
  if (authError) return errJson(403, "UNAUTHORIZED", authError);

  let payload: RelayRequest;
  try {
    payload = (await request.json()) as RelayRequest;
  } catch {
    return errJson(400, "BAD_REQUEST", "invalid JSON body");
  }

  if (typeof payload.url !== "string" || payload.url.length === 0) {
    return errJson(400, "BAD_REQUEST", "missing url");
  }
  if (typeof payload.method !== "string") {
    return errJson(400, "BAD_REQUEST", "missing method");
  }
  const method = payload.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return errJson(400, "BAD_REQUEST", `method not allowed: ${method}`);
  }
  if (
    payload.body !== undefined &&
    payload.body !== null &&
    typeof payload.body !== "string"
  ) {
    return errJson(400, "BAD_REQUEST", "body must be a string");
  }
  if (
    payload.headers !== undefined &&
    (payload.headers === null ||
      typeof payload.headers !== "object" ||
      Array.isArray(payload.headers))
  ) {
    return errJson(400, "BAD_REQUEST", "headers must be an object");
  }

  let url: URL;
  try {
    url = assertSafelistedUrl(payload.url, allowed);
  } catch (err) {
    return errJson(403, "TARGET_REJECTED", `target rejected: ${(err as Error).message}`);
  }

  const headers = sanitizeHeaders(payload.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT);

  let upstream: Response;
  let upstreamUrl: URL = url;
  let upstreamMethod: string = method;
  let upstreamBody: string | null | undefined = payload.body;
  try {
    upstream = await fetchUpstream(upstreamUrl, upstreamMethod, headers, upstreamBody);
    for (let hops = 0; upstream.status >= 300 && upstream.status < 400; hops++) {
      if (hops >= 5) {
        return errJson(502, "UPSTREAM_ERROR", "upstream redirected too many times");
      }
      const location = upstream.headers.get("location");
      if (!location) break;
      const next = new URL(location, upstreamUrl);
      try {
        assertSafelistedUrl(next.toString(), allowed);
      } catch (err) {
        return errJson(403, "TARGET_REJECTED", `redirect target rejected: ${(err as Error).message}`);
      }
      if (
        upstreamMethod === "POST" &&
        (upstream.status === 301 || upstream.status === 302 || upstream.status === 303)
      ) {
        upstreamMethod = "GET";
        upstreamBody = undefined;
      }
      upstreamUrl = next;
      upstream = await fetchUpstream(upstreamUrl, upstreamMethod, headers, upstreamBody);
    }
  } catch (err) {
    return errJson(502, "UPSTREAM_ERROR", `upstream fetch failed: ${(err as Error).message}`);
  }

  const resHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) resHeaders[key] = value;
  });

  let body = "";
  if (upstreamMethod !== "HEAD") {
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > RESPONSE_BODY_LIMIT) {
      return errJson(502, "UPSTREAM_ERROR", "upstream response exceeds body limit");
    }
    body = new TextDecoder().decode(buf);
  }

  const relayed: RelayResponse = {
    status: upstream.status,
    headers: resHeaders,
    body,
  };
  return Response.json(relayed, { headers: CORS_HEADERS });
}

async function fetchUpstream(
  url: URL,
  method: string,
  headers: Headers,
  body: string | null | undefined,
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Host", url.host);
  return fetch(url, {
    method,
    headers: requestHeaders,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

async function fetchStream(
  url: URL,
  cache: Cache,
  ctx: ExecutionContext,
  cacheTtl: number,
  referer: string | null,
): Promise<Response> {
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const headers = new Headers();
  headers.set("user-agent", DEFAULT_USER_AGENT);
  if (referer) headers.set("referer", referer);
  const upstream = await fetch(url, { redirect: "follow", headers });
  if (!upstream.ok) return upstream;

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(upstream.clone().body, {
        status: upstream.status,
        headers: cacheableHeaders(upstream, cacheTtl),
      }),
    ),
  );
  return upstream;
}

export function cacheableHeaders(upstream: Response, cacheTtl: number): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("cache-control", `public, max-age=${cacheTtl}, immutable`);
  return headers;
}

export function sniffImageType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 &&
    ((bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && (bytes[11] === 0x66 || bytes[11] === 0x73)) ||
      (bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x30 && bytes[11] === 0x31))
  ) {
    return "image/avif";
  }
  return null;
}

export async function streamImage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  allowed: Allowlist,
): Promise<Response> {
  const originError = verifyOrigin(env, request);
  if (originError) return errJson(403, "UNAUTHORIZED", originError);

  const params = new URL(request.url).searchParams;
  const rawUrl = params.get("url");
  if (!rawUrl) return errJson(400, "BAD_REQUEST", "missing url parameter");

  let url: URL;
  try {
    url = assertSafelistedUrl(rawUrl, allowed);
  } catch (err) {
    return errJson(403, "TARGET_REJECTED", `target rejected: ${(err as Error).message}`);
  }

  let referer: string | null = null;
  const ref = params.get("ref");
  if (ref) {
    try {
      const refUrl = new URL(ref);
      if (refUrl.protocol === "https:" || refUrl.protocol === "http:") {
        referer = ref;
      }
    } catch {
      // ignore malformed ref
    }
  }

  const cacheTtl = 60 * 60 * 24 * 7;
  const upstream = await fetchStream(url, caches.default, ctx, cacheTtl, referer);

  const headers = new Headers(upstream.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  headers.set("cache-control", `public, max-age=${cacheTtl}, immutable`);
  headers.set("CDN-Cache-Control", `public, s-maxage=${cacheTtl}, immutable`);
  headers.delete("content-security-policy");
  headers.delete("x-frame-options");

  const contentType = headers.get("content-type");
  if (!contentType || !contentType.startsWith("image/")) {
    const buf = new Uint8Array(await upstream.arrayBuffer());
    const sniffed = sniffImageType(buf);
    if (sniffed) {
      headers.set("content-type", sniffed);
      return new Response(buf, { status: upstream.status, headers });
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}