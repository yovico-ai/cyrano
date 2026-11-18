# Claude session guidance

This file is read into every Claude session for this repo. Keep it short and
useful — the goal is "what does a future Claude need to know to be productive
here that they couldn't reconstruct from grep + reading a few key files?"

## What this repo is

A clientless SSL VPN rewriter — see [REQUIREMENTS.md](REQUIREMENTS.md) for the
functional spec and [README.md](README.md) for the layout and how to run it.

## Working norms

**Fundamental principle: the page cannot tell.** The page's own JS must see
no difference between direct and rewritten — every object, function,
property, event and error returns exactly what it would on the origin
(URLs as the browser serializes them, attribute text as the page wrote it,
native errors still thrown, wrappers that look native). Judge every
rewriting decision by this; a rule that contradicts it is a bug, even an
owner-dated one in `spec/`. Full statement: REQUIREMENTS.md
"Fundamental principle".

The Go server (`go/`) and TS client (`ts/client/`) are a clean-room
implementation. The TS client is written from the server-side rewriting
contract (how rewritten HTML/JS calls into `$rewriter.*`).

**Every rewriting fix must be applied to BOTH runtimes.** When you fix a URL
rewriting bug in Go (e.g. `htmlrewrite/srcset.go`), the equivalent logic in
TypeScript (`ts/client/src/patches/srcset.ts` and friends) must receive the
same fix and vice versa. The two runtimes must stay byte-compatible: server
rewrites static HTML; the client rewrites dynamically-set attributes. A bug
fixed in only one runtime will still show up for the other's code paths.

**URL containment and srcset have an executable spec** in `spec/` (Agda;
see `spec/README.md`). For those rules, change the spec first, then both
runtimes, then run `env -u LD_LIBRARY_PATH nix develop --command make
spec-check` — the Go and TS conformance tests compare each runtime against
the compiled spec. Plain `go test`/`vitest` skip those tests when the
oracle is missing or stale, so a green plain run does not cover them.

## Directory layout

- `go/` — Go server. Module is `github.com/yovico/cyrano`.
- `ts/client/` — Browser runtime (TypeScript, strict mode).
- `ts/bug-miner/` — Playwright DOM-diff testing tool (in progress).

The TS client build (`npm run build` in `ts/client/`) outputs the IIFE bundle
to `go/assets/client/rewriter.js`. That file is gitignored (build artifact);
run the build step before starting the server if it's missing.

## Test commands

```bash
# Go — 125 tests, fast
( cd go/src && go test ./... )

# TS strict typecheck
( cd ts/client && npm run typecheck )

# Spec conformance (Go + TS against the compiled Agda spec), and the spec
# and runtime against real Chromium (needs Playwright's Chromium, ts/e2e)
env -u LD_LIBRARY_PATH nix develop --command make spec-check browser-check
```

## Build commands

```bash
# TS client (Vite) — outputs IIFE to go/assets/client/rewriter.js
( cd ts/client && npm run build )

# Go server
( cd go/src && go build -o /tmp/cyrano ./cmd/cyrano )
# or via script:
./go/scripts/build.sh    # outputs to go/assets/cyrano
```

## Run commands

```bash
# Via script (sets all env vars, runs from repo root):
./go/scripts/run.sh

# Or directly — env vars have sensible defaults for local dev:
/tmp/cyrano --assets ./go/assets --log-level debug
```

## Library choices

- `golang.org/x/net/html` — token-stream HTML parser (no full DOM).
- `github.com/tdewolff/parse/v2/js` — JS lexer + parser + AST (~50 MB/s).
- `github.com/tdewolff/parse/v2/css` — CSS lexer (token-based).
- Stdlib `net/http/httputil.ReverseProxy` with Director + ModifyResponse.
- Stdlib `http.Hijacker` + raw TCP for WebSocket — no third-party WS lib.
- Stdlib `log/slog` for structured logging.

## Known gaps

- **Reading markup back** is done for attributes, script/style text set
  by scripts, and serialization (`native/originals.ts`,
  `patches/read-back.ts`; the server carries originals in the `crn-o`
  attribute, consumed before page scripts run). Still open: `attributes` /
  `getAttributeNames` list what the element holds (a dropped `integrity` is
  missing from the list); an inline script rewritten by the server or inside
  an HTML string reads back rewritten; CSS attribute selectors match the
  rewritten values; `crossOrigin` reads the forced value.
- **JS source is visible**: a rewritten function's `toString()` shows the
  rewritten source (and `--prettify` reformats it).
- **CSP** is weakened, not translated (`proxy/csp.go`, `html-rewriter.ts`);
  a faithful translation (host-sources → proxied path prefixes, rehashed
  inline scripts) is not done. CSS `url()` handling still differs between
  Go (lexer) and TS (regex).
- **Referrer policy** set by `<meta name=referrer>`, a `referrerpolicy`
  attribute or `fetch({referrerPolicy})` is not applied (only the header).
- **Request fingerprint** (checked against tls.peet.ws in real Chrome: TLS
  JA4, HTTP/2 settings and header order equal a direct Chrome's). Header
  order is the browser's own, recorded off its HTTP/1.x connection
  (`internal/headerorder`); a browser reaching the proxy over HTTP/2 (TLS
  deployment) gets Chrome's usual order from a template instead. Client
  hints are per original origin (`proxy/client_hints.go`; gaps listed
  there: delegation, `<meta>` Accept-CH, the first cross-site navigation).
  Compression dictionaries are never registered. TLS never resumes a
  session (no `pre_shared_key`), as a first connection.
- **Cloudflare**: x.com, claude.ai, nowsecure.nl pass in real Chrome. A
  managed challenge (scrapingcourse.com/cloudflare-challenge) runs fully
  but ends at the interactive checkbox where direct passes silently —
  cause not yet found (suspects: Private Access Token 401, remaining
  runtime tells). Google search answers `/sorry` through the proxy.
- **Browser-level requests** the page cannot intercept escape the proxy
  (FedCM `navigator.credentials.get`, seen on theguardian.com).
- **Not wrapped yet**: `AsyncFunction`/`GeneratorFunction` constructors,
  the Navigation API (`navigation.currentEntry.url`), DOM insertion via
  `replaceChild`/`before`/`after`/`replaceWith`/`insertAdjacentElement`.
- Live check: `ts/e2e/tools/live-compare.cjs` (direct vs proxied, same
  browser). Last run clean: example.com, news.ycombinator.com,
  en.wikipedia.org, developer.mozilla.org, github.com, stackoverflow.com,
  bbc.com/news; theguardian.com matches direct except three FedCM requests.
  Headless Chromium is itself challenged by x.com/claude.ai: check those in
  a real Chrome. Run the server without `--prettify` when checking.

- Upstream request target for a path starting `//` (e.g.
  `https://h//a/^|`): `net/url` re-escapes it (`^` → `%5E`) because it can't
  go on the wire as `URL.Opaque`. Every other path is sent byte for byte
  (`urlrewrite.UpstreamPath`). Skipped by name in
  `TestSpecConformance_UpstreamCannotTell`.
- `wrap_postMessage` in the TS client is a passthrough — see
  `ts/client/src/wrappers/post-message.ts` (TODO: rewrite proxy-origin URLs
  in message payloads before they cross frame boundaries).
- AES-CTR cookie decryption in the TS client is stubbed —
  see `ts/client/src/cookies/decrypt.ts` (TODO: Web Crypto).
- Cookie sync endpoints return empty data (in-memory stub) —
  see `go/src/internal/server/endpoints.go`.
- HTML rewriter `wrap_member_expression` fires broadly on computed property
  accesses (redundant but not wrong on many of the call sites).
- `golang.org/x/net/html` decodes HTML entities in text nodes (and
  re-encodes on emit), which differs from htmlparser2's raw-passthrough
  behavior. Cosmetic difference; doesn't affect URL rewriting correctness.
