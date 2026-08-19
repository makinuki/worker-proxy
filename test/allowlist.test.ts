import { describe, expect, it } from "vitest";
import {
  assertSafelistedUrl,
  deriveAllowedHosts,
  isSafelistedHost,
  isSuspiciousHost,
  isValidDomain,
  mergeExtraHosts,
  parseHost,
} from "../src/allowlist";

describe("parseHost", () => {
  it("extracts lowercase hostname", () => {
    expect(parseHost("https://MangaDex.org/api")).toBe("mangadex.org");
  });
  it("strips a trailing FQDN dot", () => {
    expect(parseHost("https://MangaDex.org./api")).toBe("mangadex.org");
    expect(parseHost("https://127.0.0.1./")).toBe("127.0.0.1");
  });
  it("rejects invalid URLs", () => {
    expect(parseHost("not a url")).toBeNull();
    expect(parseHost("")).toBeNull();
  });
});

describe("isValidDomain", () => {
  it("accepts public domains", () => {
    expect(isValidDomain("mangadex.org")).toBe(true);
    expect(isValidDomain("api.mangadex.org")).toBe(true);
    expect(isValidDomain("cdn.example.com")).toBe(true);
  });
  it("rejects IPs, numeric hosts, wildcards and bare names", () => {
    expect(isValidDomain("127.0.0.1")).toBe(false);
    expect(isValidDomain("8.8.8.8")).toBe(false);
    expect(isValidDomain("127.1")).toBe(false);
    expect(isValidDomain("2130706433")).toBe(false);
    expect(isValidDomain("localhost")).toBe(false);
    expect(isValidDomain("*.example.com")).toBe(false);
    expect(isValidDomain("com")).toBe(false);
  });
});

describe("isSuspiciousHost", () => {
  it("flags any IPv4 literal, private or public", () => {
    expect(isSuspiciousHost("127.0.0.1")).toBe(true);
    expect(isSuspiciousHost("10.1.2.3")).toBe(true);
    expect(isSuspiciousHost("192.168.0.1")).toBe(true);
    expect(isSuspiciousHost("169.254.1.1")).toBe(true);
    expect(isSuspiciousHost("172.16.5.5")).toBe(true);
    expect(isSuspiciousHost("8.8.8.8")).toBe(true);
  });
  it("flags numeric and dotted obfuscated IP forms", () => {
    expect(isSuspiciousHost("127.1")).toBe(true);
    expect(isSuspiciousHost("0177.0.0.1")).toBe(true);
    expect(isSuspiciousHost("2130706433")).toBe(true);
    expect(isSuspiciousHost("0x7f000001")).toBe(true);
    expect(isSuspiciousHost("1.2.3.4.5")).toBe(true);
    expect(isSuspiciousHost("127.0.0.1.")).toBe(true);
  });
  it("flags localhost and mDNS names", () => {
    expect(isSuspiciousHost("localhost")).toBe(true);
    expect(isSuspiciousHost("foo.localhost")).toBe(true);
    expect(isSuspiciousHost("printer.local")).toBe(true);
  });
  it("flags any IPv6 literal", () => {
    expect(isSuspiciousHost("::1")).toBe(true);
    expect(isSuspiciousHost("2001:db8::1")).toBe(true);
  });
  it("passes public CDN hosts", () => {
    expect(isSuspiciousHost("mangadex.network")).toBe(false);
    expect(isSuspiciousHost("cmdxd98sb0x3yprd.mangadex.network")).toBe(false);
  });
});

describe("deriveAllowedHosts", () => {
  it("collects baseUrl hosts and allowedHosts", () => {
    const hosts = deriveAllowedHosts([
      { baseUrl: "https://mangadex.org", allowedHosts: ["mangadex.network"] },
      { baseUrl: "https://asurascans.com" },
      { baseUrl: "invalid" },
    ]);
    expect(hosts).toEqual(
      new Set(["mangadex.org", "mangadex.network", "asurascans.com"]),
    );
  });
});

describe("mergeExtraHosts", () => {
  it("merges comma/space separated overrides", () => {
    const hosts = mergeExtraHosts(
      new Set(["mangadex.org"]),
      "cdn.example.com,static.assets.net",
    );
    expect(hosts).toEqual(
      new Set(["mangadex.org", "cdn.example.com", "static.assets.net"]),
    );
  });
  it("drops suspicious override hosts", () => {
    const hosts = mergeExtraHosts(
      new Set(),
      "127.0.0.1 http://localhost:3000 8.8.8.8 127.0.0.1. 2130706433",
    );
    expect(hosts.size).toBe(0);
  });
});

describe("isSafelistedHost", () => {
  const allowed = new Set(["mangadex.org", "mangadex.network"]);

  it("matches exact host", () => {
    expect(isSafelistedHost("mangadex.org", allowed)).toBe(true);
  });
  it("matches subdomains of allowed domains", () => {
    expect(isSafelistedHost("api.mangadex.org", allowed)).toBe(true);
    expect(isSafelistedHost("cmdxd98sb0x3yprd.mangadex.network", allowed)).toBe(
      true,
    );
  });
  it("matches a trailing-dot FQDN form", () => {
    expect(isSafelistedHost("MangaDex.org.", allowed)).toBe(true);
  });
  it("rejects lookalike and foreign hosts", () => {
    expect(isSafelistedHost("mangadex.org.evil.com", allowed)).toBe(false);
    expect(isSafelistedHost("evil-mangadex.org", allowed)).toBe(false);
    expect(isSafelistedHost("example.com", allowed)).toBe(false);
    expect(isSafelistedHost("127.0.0.1", allowed)).toBe(false);
  });
  it("rejects IP literals even when allowlisted by string", () => {
    expect(isSafelistedHost("8.8.8.8", new Set(["8.8.8.8"]))).toBe(false);
  });
});

describe("assertSafelistedUrl", () => {
  const allowed = new Set(["mangadex.org"]);

  it("accepts an allowed subdomain URL", () => {
    const url = assertSafelistedUrl(
      "https://api.mangadex.org/manga?limit=1",
      allowed,
    );
    expect(url.hostname).toBe("api.mangadex.org");
  });
  it("rejects non-http protocols", () => {
    expect(() =>
      assertSafelistedUrl("file:///etc/passwd", allowed),
    ).toThrow(/non-http/);
  });
  it("rejects out-of-allowlist hosts", () => {
    expect(() =>
      assertSafelistedUrl("https://mangadex.org.evil.com/x", allowed),
    ).toThrow(/host not allowed/);
  });
  it("rejects credentials in URL", () => {
    expect(() =>
      assertSafelistedUrl("https://user:pass@mangadex.org/x", allowed),
    ).toThrow(/credentials/);
  });
  it("rejects IP literals even when allowlist host matches", () => {
    expect(() =>
      assertSafelistedUrl("https://127.0.0.1/ssrf", new Set(["127.0.0.1"])),
    ).toThrow(/host not allowed/);
    expect(() =>
      assertSafelistedUrl("https://8.8.8.8/ssrf", new Set(["8.8.8.8"])),
    ).toThrow(/host not allowed/);
  });
  it("rejects obfuscated IP forms", () => {
    expect(() =>
      assertSafelistedUrl("https://2130706433/x", allowed),
    ).toThrow(/host not allowed/);
    expect(() =>
      assertSafelistedUrl("https://127.0.0.1./x", allowed),
    ).toThrow(/host not allowed/);
  });
});