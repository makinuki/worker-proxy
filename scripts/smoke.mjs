const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const CLIENT_TOKEN = process.env.SMOKE_TOKEN ?? "dev-token";
const ORIGIN = "https://app.example.com";
const TOKEN_HEADER = "x-makinuki-client";

const CACHE_CONTROL = "public, max-age=604800, immutable";
const CDN_CACHE_CONTROL = "public, s-maxage=604800, immutable";

let checks = 0;
let failures = 0;

function check(label, cond, detail = "") {
  checks++;
  if (cond) {
    console.log(`ok:   ${label}`);
  } else {
    failures++;
    console.error(`FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function postProxy(body, { token = CLIENT_TOKEN, origin = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== null && token !== false) headers[TOKEN_HEADER] = token;
  if (origin) headers.origin = ORIGIN;
  return fetch(`${BASE}/proxy`, { method: "POST", headers, body });
}

const relayBody = (url, method = "GET") =>
  JSON.stringify({ url, method, headers: {}, body: null });

async function main() {
  section("health");
  const health = await fetch(`${BASE}/health`);
  check("GET /health returns 200", health.ok, `status ${health.status}`);
  const healthJson = await health.json();
  check(
    "health reports status ok",
    healthJson.status === "ok",
    `got ${healthJson.status}`,
  );
  check(
    "health reports version",
    healthJson.version === "1.0.0",
    `got ${healthJson.version}`,
  );
  check(
    "health reports numeric allowlist-count",
    Number.isInteger(healthJson.allowlistCount),
    `got ${healthJson.allowlistCount}`,
  );
  const healthz = await fetch(`${BASE}/healthz`);
  check("GET /healthz alias returns 200", healthz.ok, `status ${healthz.status}`);

  section("relay (authorized)");
  const relay = await postProxy(relayBody("https://api.mangadex.org/manga?limit=1"));
  check("authorized relay returns 200", relay.status === 200, `status ${relay.status}`);
  const relayed = await relay.json();
  check("upstream status relayed", relayed.status === 200, `got ${relayed.status}`);
  check("upstream body relayed", relayed.body.includes('"data"'));
  check(
    "CORS header present",
    relay.headers.get("access-control-allow-origin") === "*",
  );

  section("auth (unauthorized)");
  const missingToken = await postProxy(
    relayBody("https://api.mangadex.org/manga?limit=1"),
    { token: false },
  );
  check("missing token rejected", missingToken.status === 403, `status ${missingToken.status}`);
  const mt = await missingToken.json();
  check("missing token error code", mt.error === "UNAUTHORIZED", `got ${mt.error}`);

  const wrongToken = await postProxy(
    relayBody("https://api.mangadex.org/manga?limit=1"),
    { token: "wrong-token" },
  );
  check("wrong token rejected", wrongToken.status === 403, `status ${wrongToken.status}`);

  const noOrigin = await postProxy(
    relayBody("https://api.mangadex.org/manga?limit=1"),
    { origin: false },
  );
  check("missing origin rejected", noOrigin.status === 403, `status ${noOrigin.status}`);

  section("ssrf");
  const ssrfIp = await postProxy(relayBody("http://127.0.0.1/"));
  check("private IP literal rejected", ssrfIp.status === 403, `status ${ssrfIp.status}`);
  const sIp = await ssrfIp.json();
  check("ssrf error code", sIp.error === "TARGET_REJECTED", `got ${sIp.error}`);
  check("ssrf error carries status", sIp.status === 403, `got ${sIp.status}`);

  const ssrfPublic = await postProxy(relayBody("http://8.8.8.8/"));
  check("public IP literal rejected", ssrfPublic.status === 403, `status ${ssrfPublic.status}`);

  const ssrfInt = await postProxy(relayBody("http://2130706433/"));
  check("obfuscated numeric IP rejected", ssrfInt.status === 403, `status ${ssrfInt.status}`);

  section("image caching");
  const IMAGE_URL =
    "https://cmdxd98sb0x3yprd.mangadex.network/data/2e90ad09f8b0922c1d822c39420e4008/v1-08e90b19da80aa1abe7633082a505d07abe18eb3a08c8c1d8e27766dd44b6305.jpg";
  const imgParams = `url=${encodeURIComponent(IMAGE_URL)}&ref=${encodeURIComponent("https://mangadex.org/")}`;

  const first = await fetch(`${BASE}/proxy?${imgParams}`, {
    headers: { origin: ORIGIN },
  });
  check("image stream returns 200", first.status === 200, `status ${first.status}`);
  check(
    "image content-type streamed",
    (first.headers.get("content-type") ?? "").startsWith("image/"),
    `got ${first.headers.get("content-type")}`,
  );
  check(
    "image cache-control header",
    first.headers.get("cache-control") === CACHE_CONTROL,
    `got ${first.headers.get("cache-control")}`,
  );
  check(
    "image CDN-Cache-Control header",
    first.headers.get("CDN-Cache-Control") === CDN_CACHE_CONTROL,
    `got ${first.headers.get("CDN-Cache-Control")}`,
  );

  const second = await fetch(`${BASE}/proxy?${imgParams}`, {
    headers: { origin: ORIGIN },
  });
  check("cached hit returns 200", second.status === 200, `status ${second.status}`);
  check(
    "cached image content-type streamed",
    (second.headers.get("content-type") ?? "").startsWith("image/"),
    `got ${second.headers.get("content-type")}`,
  );
  check(
    "cached image cache-control header",
    second.headers.get("cache-control") === CACHE_CONTROL,
    `got ${second.headers.get("cache-control")}`,
  );

  console.log(`\nsummary: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`smoke failed (${failures} check${failures === 1 ? "" : "s"} failed)`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  console.error("start the worker first with: pnpm dev");
  process.exit(1);
});