import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheableHeaders,
  relayRequest,
  sniffImageType,
  streamImage,
} from "../src/proxy";
import type { Allowlist } from "../src/proxy";

const env = {} as Env;
const allowed: Allowlist = new Set(["mangadex.org", "cdn.example.com"]);

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as
  ExecutionContext;

function mockCache() {
  const match = vi.fn(async () => null);
  const put = vi.fn(async () => {});
  vi.stubGlobal("caches", { default: { match, put } });
  return { match, put };
}

function relayBody(url: string, method = "GET") {
  return JSON.stringify({ url, method, headers: {}, body: null });
}

function makeRequest(body: string): Request {
  return new Request("https://proxy.example/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function mockFetch(impl: (url: URL, init?: RequestInit) => Response) {
  const fetcher = vi.fn((input: string | URL, init?: RequestInit) => {
    return impl(new URL(String(input)), init);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayRequest", () => {
  it("relays a 200 upstream as an envelope with outer 200", async () => {
    const fetcher = mockFetch((url) => {
      expect(url.toString()).toBe("https://api.mangadex.org/manga?limit=1");
      return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    });

    const res = await relayRequest(
      makeRequest(relayBody("https://api.mangadex.org/manga?limit=1")),
      env,
      allowed,
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status?: number; body?: string; error?: string };
    expect(payload.status).toBe(200);
    expect(payload.body).toContain('"data"');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps upstream 4xx inside the envelope with outer 200", async () => {
    mockFetch(() => new Response("blocked", { status: 429 }));

    const res = await relayRequest(makeRequest(relayBody("https://api.mangadex.org/x")), env, allowed);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status?: number; body?: string; error?: string };
    expect(payload.status).toBe(429);
  });

  it("follows an allowlisted redirect and relays the final response", async () => {
    const fetcher = mockFetch((url) => {
      if (url.toString() === "https://mangadex.org/old") {
        return new Response(null, { status: 302, headers: { location: "https://mangadex.org/new" } });
      }
      return new Response("final", { status: 200 });
    });

    const res = await relayRequest(makeRequest(relayBody("https://mangadex.org/old")), env, allowed);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status?: number; body?: string; error?: string };
    expect(payload.status).toBe(200);
    expect(payload.body).toBe("final");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect to a non-allowlisted host", async () => {
    mockFetch((url) => {
      if (url.toString() === "https://mangadex.org/old") {
        return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } });
      }
      return new Response("nope", { status: 200 });
    });

    const res = await relayRequest(makeRequest(relayBody("https://mangadex.org/old")), env, allowed);

expect(res.status).toBe(403);
    const payload = (await res.json()) as {
      error?: string;
      message?: string;
      status?: number;
    };
    expect(payload.error).toBe("TARGET_REJECTED");
    expect(payload.message).toContain("redirect target rejected");
    expect(payload.status).toBe(403);
  });

  it("switches POST to GET on 301/302 redirects", async () => {
    const fetcher = mockFetch((url, init) => {
      if (url.toString() === "https://mangadex.org/submit") {
        expect(init?.method).toBe("POST");
        return new Response(null, { status: 302, headers: { location: "https://mangadex.org/done" } });
      }
      expect(init?.method).toBe("GET");
      return new Response("done", { status: 200 });
    });

    const res = await relayRequest(
      makeRequest(relayBody("https://mangadex.org/submit", "POST")),
      env,
      allowed,
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status?: number; body?: string; error?: string };
    expect(payload.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts after too many redirect hops", async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { location: "https://mangadex.org/loop" } }));

    const res = await relayRequest(makeRequest(relayBody("https://mangadex.org/start")), env, allowed);

expect(res.status).toBe(502);
    const payload = (await res.json()) as { error?: string; message?: string; status?: number };
    expect(payload.error).toBe("UPSTREAM_ERROR");
    expect(payload.message).toContain("redirected too many times");
    expect(payload.status).toBe(502);
  });
});
describe("cacheableHeaders", () => {
  it("preserves content-type and other upstream headers", () => {
    const upstream = new Response(null, {
      headers: { "content-type": "image/webp", "content-encoding": "br" },
    });

const headers = cacheableHeaders(upstream, 604800);

    expect(headers.get("content-type")).toBe("image/webp");
    expect(headers.get("cache-control")).toBe("public, max-age=604800, immutable");
    expect(headers.get("content-encoding")).toBeNull();
  });
});

describe("streamImage", () => {
  it("streams an image with 7-day immutable cache headers", async () => {
    mockCache();
    mockFetch(() =>
      new Response("fakepng", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const url = "https://cdn.example.com/page1.png";
    const req = new Request(
      `https://proxy.example/proxy?url=${encodeURIComponent(url)}`,
    );
    const res = await streamImage(req, env, ctx, allowed);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=604800, immutable",
    );
    expect(res.headers.get("CDN-Cache-Control")).toBe(
      "public, s-maxage=604800, immutable",
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects a non-allowlisted target before streaming", async () => {
    mockCache();
    const req = new Request(
      `https://proxy.example/proxy?url=${encodeURIComponent("https://evil.example.com/x.png")}`,
    );
    const res = await streamImage(req, env, ctx, allowed);

    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error?: string; status?: number };
    expect(payload.error).toBe("TARGET_REJECTED");
    expect(payload.status).toBe(403);
  });
});

describe("sniffImageType", () => {
  const u8 = (hex: string) => new Uint8Array(hex.split(" ").map((b) => parseInt(b, 16)));

  it("detects png, jpeg, gif, webp and avif magic bytes", () => {
    expect(sniffImageType(u8("89 50 4e 47 0d 0a 1a 0a"))).toBe("image/png");
    expect(sniffImageType(u8("ff d8 ff e0 00 10"))).toBe("image/jpeg");
    expect(sniffImageType(u8("47 49 46 38 39 61 10 00"))).toBe("image/gif");
    expect(sniffImageType(u8("52 49 46 46 24 00 00 00 57 45 42 50"))).toBe("image/webp");
    expect(sniffImageType(u8("00 00 00 20 66 74 79 70 61 76 69 66"))).toBe("image/avif");
    expect(sniffImageType(u8("00 00 00 20 66 74 79 70 61 76 69 73"))).toBe("image/avif");
    expect(sniffImageType(u8("00 00 00 20 66 74 79 70 61 76 30 31"))).toBe("image/avif");
  });

  it("returns null for non-image bytes", () => {
    expect(sniffImageType(u8("3c 21 44 4f 43 54 59 50"))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});
