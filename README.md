# cyrano — a clientless SSL VPN

> *Cyrano de Bergerac ghostwrote love letters in real time.*  This proxy
> ghostwrites HTML, JavaScript, and CSS on the wire — the browser thinks
> it's hearing from the original origin, but every word is rewritten in
> flight before it lands.

A transparent HTTP/HTTPS proxy that rewrites HTML, JavaScript, and CSS on
the wire so a browser sees the *original* origin while every actual network
request flows through the proxy. No browser extension, no native client, no
PAC file, no system proxy setting — visit a proxified URL like

```
http://proxy:9081/?goto=<base64url(https://example.com/)>
```

…and everything else (URL containment, DOM/JS rewriting, cookie sync,
WebSocket upgrade) happens transparently behind that one entry point.

## Why this exists

The "clientless SSL VPN" idea has a long history, and this repo is, in part,
a retrospective on my own involvement with it:

- **uRoam (early 2000s, → acquired by F5)** - where the idea originated.
  I was the cofounder of the company with Michael Herne and Alex Sokolsky.
  The pitch: give an enterprise's remote workforce access to internal web
  apps from any browser, with no software installed, by terminating SSL at
  a gateway and rewriting URLs on the way back. F5 absorbed the technology
  into its FirePass and subsequently the BIG-IP line of products.

- **Cisco ASA (embedded reimplementation)** - an entirely separate, much
  more clean version baked into Cisco's appliances, written from
  scratch for the embedded environment. Cisco bought my early startup 
  MISecure to build this technology.

This repo is a clean-room, open-source implementation of the clientless-
SSL-VPN core — URL containment, HTML/JS/CSS rewriting, the browser-side
runtime library. The goal is to make the underlying technique available,
well-documented, and well-tested.  The code is generated with Claude code
using numerous open source modules. It is amazing how easier it is than
25 years ago.

## What it does

- **URL containment** — every URL the browser would request gets rewritten
  to land on the proxy origin via `?goto=<base64url(target)>`. Wire-
  compatible scheme across both runtimes (Go server, TS client).
- **HTML rewriting** — token-stream over `golang.org/x/net/html`. Rewrites
  every URL-bearing attribute, inlines a bootstrap `<script src="/rewriter.js">`,
  drops CSP `<meta>`, strips SRI, forces `crossorigin=use-credentials`,
  injects cookie-sync `onload` hooks.
- **JavaScript rewriting** (server side) — full AST-level transformation
  via `tdewolff/parse/v2/js`. Wraps `location` reads/writes/member access,
  `top` / `parent`, `eval`/`obj.eval`, `document.write`, `postMessage`,
  dynamic computed-member access (`obj[expr]`).
- **JavaScript rewriting** (client side) — same rule set, ported to a
  browser-deliverable acorn-based pass. Runs at runtime over `eval(src)`,
  `new Function(args, body)`, and inline `<script>` content inside any
  HTML payload that arrives through `document.write` / `innerHTML` /
  `outerHTML` / `insertAdjacentHTML`.
- **CSS rewriting** — server side via `tdewolff/parse/v2/css`, client side
  via a regex pass over `url(...)` and `@import "..."`. Both sides cover
  inline `<style>` content, `style="..."` attributes,
  `CSSStyleSheet.insertRule`, and `CSSStyleDeclaration` named-property
  setters / `setProperty` / `cssText`.
- **Prototype patches** in the browser — `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `Worker`, `SharedWorker`, the URL-bearing
  attribute setters (`src` / `href` / `srcset` / `action` / `data` /
  `poster`), `Element.innerHTML` / `outerHTML` / `insertAdjacentHTML` /
  `setAttribute`, the `Function` constructor, the `CSSStyleDeclaration`
  surfaces above.
- **WebSocket upgrade** — `http.Hijacker` + bidirectional pipe. No frame
  parsing; we shovel bytes.
- **Server-Sent Events / streaming** — passthrough; nothing is buffered when
  there's nothing to rewrite.
- **Per-session cookie storage** — proxy holds origin cookies in its own
  store and syncs them into `document.cookie` per page load, so cross-
  origin cookie state never leaks into the proxy's single shared origin.

The exhaustive surface list — every object, function, and runtime hook on
both sides — is in [REQUIREMENTS.md](REQUIREMENTS.md).

## Repo layout

```
.
├── go/                         Go server (production target)
│   ├── src/
│   │   ├── cmd/cyrano/          binary entry
│   │   └── internal/
│   │       ├── b64u/             URL-safe base64 — wire-compatible with TS
│   │       ├── urlrewrite/       URL containment scheme — Rewrite() / Unwrap()
│   │       ├── proxy/            ReverseProxy + body-rewrite pipeline
│   │       ├── wsproxy/          WebSocket upgrade hijack + bidir pipe
│   │       ├── htmlrewrite/      x/net/html token-stream rewriter
│   │       ├── jsrewrite/        tdewolff/parse/v2/js AST rewriter
│   │       ├── cssrewrite/       tdewolff/parse/v2/css url() + @import rewriter
│   │       ├── static/           static-file handler
│   │       ├── config/           env-var + JSON config loader
│   │       └── server/           dispatch + endpoints + body-rewriter wiring
│   ├── assets/                   static root (TS bundle, landing page)
│   └── scripts/                  Dockerfile, build.sh, run.sh
│
├── ts/
│   ├── client/                  strict-TS browser runtime (vite IIFE → go/assets/client/)
│   │   └── src/
│   │       ├── rewriter.ts        entry — sets window.$rewriter_init
│   │       ├── runtime/           bootstrap, api, base-url-state, iframe-injection
│   │       ├── url/               base64url, containment scheme
│   │       ├── wrappers/          WrappedLocation, eval, document-write, post-message,
│   │       │                      window-tree, member-expression
│   │       ├── patches/           fetch, xhr, websocket, event-source, worker,
│   │       │                      url-attributes, dynamic-html, css-rules,
│   │       │                      css-style-declaration, function-ctor, html-rewriter
│   │       ├── js/                acorn-based JS source rewriter (client-side parity)
│   │       ├── css/               regex-based CSS source rewriter
│   │       └── cookies/           apply-payload, sync, decrypt, document-cookie
│   └── bug-miner/                Playwright DOM-diff harness
│
├── LICENSE
├── README.md
├── REQUIREMENTS.md              functional spec + complete surface inventory
├── CLAUDE.md                    session guidance for working in this repo
└── .gitignore
```

## Running it

```bash
# Build the TS client (output → go/assets/client/rewriter.js)
( cd ts/client && npm install && npm run build )

# Build the Go binary
./go/scripts/build.sh

# Run with defaults (localhost:9081, see go/scripts/run.sh for all env vars)
./go/scripts/run.sh

# Open the landing page (a one-input form that URL-encodes a target)
open http://localhost:9081/
```

Configuration is read from environment variables. `go/scripts/run.sh` sets
them all to local-dev defaults and launches the binary. For production,
inject them via your container/secrets mechanism instead.

## Tests

```bash
# Go server (7 packages)
( cd go/src && go test ./... )

# TS client (238 tests, vitest + happy-dom)
( cd ts/client && npm test )
( cd ts/client && npm run typecheck )
```

## System testing — bug-miner

`ts/bug-miner` is a Playwright-based DOM-diff harness that stress-tests the
proxy against real websites. It picks three random English words, queries
DuckDuckGo, opens the first result both directly and through the proxy, then
compares the two rendered DOMs to surface rewriter bugs.

**Setup (one time):**

```bash
cd ts/bug-miner
npm install
npm run install-browsers   # downloads Playwright's Chromium
```

**Run:**

```bash
# Start the proxy first (separate terminal)
./go/scripts/run.sh

# One run, headed (visible browser window), random query
cd ts/bug-miner && npm run mine

# Specific query, headless, five iterations
npm run mine -- --query "wikipedia history" --headless --runs 5
```

Key flags:

| flag | default | meaning |
|---|---|---|
| `--runs N` | 1 | iterations |
| `--query "..."` | random words | skip random search, use this query |
| `--proxy URL` | `http://localhost:9081` | proxy origin |
| `--headless` | off | run without a visible window |
| `--browser chrome\|chromium` | `chrome` | system Chrome or bundled Chromium |
| `--slow-mo N` | 0 | ms between actions (useful for visual debugging) |

Reports land in `ts/bug-miner/reports/<session>/`. Each run produces:
- `run.json` — URL, verdict, console errors, signals
- `direct.html` — DOM rendered without the proxy
- `proxied.html` — DOM rendered through the proxy
- `summary.md` — verdict table across the session

Verdicts: `ok` / `suspicious` / `broken`. The most actionable signal is a
**proxy leak** — any request from the proxied page that bypasses the proxy
origin, indicating a URL-containment bug. Drop a run directory into a Claude
Code session to investigate: it contains the URL, both DOMs, and all JS errors.

## Roadmap

- **Multi-instance session affinity.** The cookie store is in-process; a
  second pod doesn't share it. An external store adds latency on the hot
  path, so the preferred approach for Kubernetes is sticky routing (Istio
  consistent-hash on `crnsid`) rather than externalizing state.
- Worker injection (currently only the constructor URL is rewritten —
  the worker's own runtime patches aren't injected; needs a server-side
  preamble for worker scripts).
- `postMessage` `targetOrigin` translation when the receiver is a cross-
  realm Window with strict origin checks.
- AES-CTR cookie payload encryption (Web Crypto on the TS side; matching
  helper on the Go side).
