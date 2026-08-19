# makinuki/worker-proxy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/makinuki/worker-proxy)

Cloudflare Worker CORS relay for MakiNuki WASM scraper sources. The web runtime
routes plugin-originated HTTP requests (and header-protected images) through
this worker.

## Architecture

```
browser runtime (runtime-web)
  |  POST /proxy { url, method, headers, body }     JSON relay (makinuki_fetch)
  |  GET  /proxy?url=...&ref=...                    image pass-through (<img>)
  v
worker-proxy (Cloudflare Worker)
  1. origin check      CLIENT_ORIGINS (browser requests)
  2. token check       CLIENT_TOKEN   (POST /proxy only)
  3. allowlist check   host must be on the registry allowlist (see Security)
  4. relay / stream    fetch upstream, timeouts, header filtering
  v
upstream (MangaDex API, image CDN, ...)
```

The allowlist is derived from the registry manifest (`REGISTRY_URL` index.json)
and cached in the worker isolate for `ALLOWLIST_REFRESH_SECONDS` with retry and
backoff. Image responses are streamed without buffering and mirrored into the
Cloudflare Cache API with a 7-day immutable TTL, so repeated chapter page loads
are served from the edge.

## Endpoints

- `POST /proxy` - JSON relay for `makinuki_fetch` traffic.
  Request body: `{ "url", "method", "headers", "body" }`.
  Response: `{ "status", "headers", "body" }` with `Access-Control-Allow-Origin: *`.
- `GET /proxy?url=<encoded>&ref=<optional-referer>` - streaming image
  pass-through for `<img>` delivery. Streams the raw upstream body with
  `cache-control: public, max-age=604800, immutable` and
  `CDN-Cache-Control: public, s-maxage=604800, immutable`.
- `GET /health` - liveness check. Returns
  `{ "status": "ok", "version": "<version>", "allowlistCount": <int> }`.
  `GET /healthz` is an alias returning the same payload.
- `OPTIONS` - CORS preflight.

Errors are returned in a uniform JSON shape with the matching HTTP status:

```json
{ "error": "<CODE>", "message": "<human readable detail>", "status": <http status> }
```

| Code | Status | Meaning |
| :-- | :-- | :-- |
| `BAD_REQUEST` | 400 | Malformed payload or missing/invalid field |
| `UNAUTHORIZED` | 403 | Missing/invalid client token or disallowed origin |
| `TARGET_REJECTED` | 403 | URL failed the allowlist or SSRF checks |
| `UPSTREAM_ERROR` | 502 | Upstream fetch/redirect/body-limit failure |
| `NOT_FOUND` | 404 | Unknown route |

## Security model

- **Host allowlist:** derived from the registry (`REGISTRY_URL` index.json):
  each source's `baseUrl` host plus its optional `allowedHosts` (image/CDN
  hosts). Hosts match exactly or as subdomains. `EXTRA_ALLOWED_HOSTS` adds
  comma/space-separated local overrides. The allowlist refreshes on a TTL
  (`ALLOWLIST_REFRESH_SECONDS`, default 3600) with retry/backoff.
- **SSRF guards:** http(s) only, no URL credentials, and no IP-literal hosts at
  all - private ranges, loopback, IPv6, numeric obfuscations (`127.1`,
  `2130706433`, `0x7f000001`, leading-zero and trailing-dot forms), `.local`,
  `.internal`, and localhost names are rejected regardless of any allowlist
  entry. A registered domain that later resolves to an internal address cannot
  be detected before the fetch on Workers (no DNS lookup API), so the curated
  registry allowlist plus the short refresh TTL is the boundary.
- **POST /proxy auth:** requires `X-MakiNuki-Client` header matching the
  `CLIENT_TOKEN` secret, and `Origin` in `CLIENT_ORIGINS` (when configured).
- **GET /proxy auth:** `<img>` tags cannot send custom headers, so the image
  path is protected by the `Origin` allowlist only. It is a personal relay:
  do not share the URL publicly. JSON relay traffic (the data-exfiltration
  surface) always needs the token.
- Hop-by-hop headers (`host`, `content-length`, ...) are stripped before the
  upstream request; relayed bodies are capped (5 MB request, 20 MB response);
  upstream calls time out at 30 s; redirects are followed only while every hop
  stays on the allowlist.

## Configuration

| Var | Kind | Meaning | Default |
| :-- | :-- | :-- | :-- |
| `CLIENT_TOKEN` | secret | Shared token required on `POST /proxy` | unset (allows any token-less POST - set it) |
| `CLIENT_ORIGINS` | var | Comma-separated allowed browser origins (no trailing slash) | unset (allow all) |
| `REGISTRY_URL` | var | Registry manifest for the allowlist | `https://makinuki.github.io/index.json` |
| `ALLOWLIST_REFRESH_SECONDS` | var | Allowlist refresh TTL | `3600` |
| `EXTRA_ALLOWED_HOSTS` | var | Extra allowlisted hostnames (comma/space separated) | unset |

Secrets (`CLIENT_TOKEN`) are stored via `wrangler secret put` and never in
`wrangler.toml`; the remaining variables live in `[vars]`. Locally, `.dev.vars`
holds both kinds and is gitignored. Setting `CLIENT_TOKEN` to a real value is
required before exposing the relay anywhere but your own machine.

Example `.dev.vars` for local development:

```ini
CLIENT_TOKEN=dev-token
CLIENT_ORIGINS=https://app.example.com,http://127.0.0.1:5173
EXTRA_ALLOWED_HOSTS=cdn.example.net
```

## Local development

```bash
pnpm install
pnpm dev          # wrangler dev on http://127.0.0.1:8787 (reads .dev.vars)
pnpm test         # vitest unit tests (allowlist / SSRF / relay / cache headers)
pnpm typecheck
pnpm smoke        # requires `pnpm dev` running
```

`pnpm smoke` exercises: the `/health` payload, an authorized relay, missing and
wrong token rejection, missing origin rejection, SSRF blocks (loopback, public
IP literal, obfuscated numeric host), and the image stream with its 7-day
immutable cache headers across two hits (edge cache). If the registry
(`REGISTRY_URL`) is unreachable from your machine, set `EXTRA_ALLOWED_HOSTS` in
`.dev.vars` so the allowlist is non-empty.

## Deploy

### One-Click Deploy

Click the button at the top of this file. Cloudflare pulls the repository,
opens its deployment flow, and everything is configured in the Cloudflare
dashboard: enter the worker name, the variables (`CLIENT_TOKEN`,
`CLIENT_ORIGINS`, ...), and deploy. No GitHub secrets are involved, and the
`CLIENT_TOKEN` you enter is yours alone. The repo must be public for the
button flow to work.

### Manual (Wrangler)

Prerequisites: a Cloudflare account and a token with Workers Scripts:Edit and
Account:Settings:Read permissions. Export `CF_API_TOKEN` and `CF_ACCOUNT_ID`.

```bash
pnpm deploy                                   # requires CF_API_TOKEN / CF_ACCOUNT_ID
echo "$CLIENT_TOKEN" | pnpm wrangler secret put CLIENT_TOKEN
```

### GitHub Actions (optional CI)

`.github/workflows/deploy.yml` runs on push to `master` (or manually from the
Actions tab). It always installs dependencies, typechecks, and runs the test
suite. The deploy steps only execute when the deploy secrets exist:

| Secret | Purpose | Needed for |
| :-- | :-- | :-- |
| `CF_API_TOKEN` | Deploys the Worker (Workers Scripts:Edit) | automated deploys |
| `CF_ACCOUNT_ID` | Cloudflare account identifier | automated deploys |
| `CLIENT_TOKEN` | Relay token written to the deployed worker | automated deploys |

Without these secrets the workflow is a plain CI gate; with them, every
`master` push also runs `pnpm deploy` and writes `CLIENT_TOKEN` into the
deployed worker. This is an alternative to the One-Click Deploy button, not a
requirement.

The `CLIENT_TOKEN` and `CLIENT_ORIGINS` you ship to production are your own;
runtime-web users configure the proxy URL + token in their app.