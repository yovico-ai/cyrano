# Claude session guidance

This file is read into every Claude session for this repo. Keep it short and
useful — the goal is "what does a future Claude need to know to be productive
here that they couldn't reconstruct from grep + reading a few key files?"

## What this repo is

A clientless SSL VPN rewriter — see [REQUIREMENTS.md](REQUIREMENTS.md) for the
functional spec and [README.md](README.md) for the layout and how to run it.

## Working norms

The Go server (`go/`) and TS client (`ts/client/`) are a clean-room
implementation. The TS client is written from the server-side rewriting
contract (how rewritten HTML/JS calls into `$rewriter.*`).

**Every rewriting fix must be applied to BOTH runtimes.** When you fix a URL
rewriting bug in Go (e.g. `htmlrewrite/srcset.go`), the equivalent logic in
TypeScript (`ts/client/src/patches/srcset.ts` and friends) must receive the
same fix and vice versa. The two runtimes must stay byte-compatible: server
rewrites static HTML; the client rewrites dynamically-set attributes. A bug
fixed in only one runtime will still show up for the other's code paths.

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
