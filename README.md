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
https://proxy/cyrano/https/example.com/
```

…and everything else (URL containment, DOM/JS rewriting, cookies, WebSocket
upgrade, WebRTC relay) happens transparently behind that one entry point.

The rule everything is judged by: **the page cannot tell.** Its own scripts
see exactly what they would on the origin — URLs as the browser serializes
them, attribute text as the page wrote it, native errors in Chromium's own
words, functions that look native — and the origin sees what a direct
Chrome sends (TLS and HTTP/2 fingerprint, header order, CORS preflights).

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

- **URL containment** — every URL the browser would request is rewritten to
  land on the proxy as `/cyrano/<scheme>/<host><path>`, with marks for what
  the request is for (`/cyrano/https!js/…` for a script, `!css`, `!frame`, a
  referrer policy, credentials) — the same scheme in both runtimes.
- **HTML rewriting** (server) — a token stream over `golang.org/x/net/html`
  fed by the spec's own tokenizer: every URL-bearing attribute (one table,
  `spec/Attrs.agda`), inline scripts and styles, event-handler attributes,
  `srcdoc`, `data:` / `blob:` frame documents; XML documents (SVG, XHTML)
  edited in place. Start and end tags the rules leave alone go out byte for
  byte; the originals travel in a `crn-o` attribute for read-back. The
  runtime bootstrap goes in first and fails closed.
- **JavaScript rewriting** — invertible edits spliced into the page's own
  text (never re-printed): `location`, `top` / `parent`, `eval` and its
  forms, `document.write`, `postMessage`, computed members, `import()`,
  `import.meta`, workers, `javascript:` URLs. Server: an own recognizer in
  Go (`jsrewrite`); client: the acorn-based reference; one shared case file
  (`spec/js-rewrite/cases.json`).
- **CSS rewriting** — CSS Syntax tokenization as far as finding URLs needs
  it (`spec/Css.agda`), both runtimes, each URL keeping its written form.
- **The browser runtime** (`ts/client`) — patches every surface a page can
  load, read or navigate through: fetch / XHR (CORS, opaque responses,
  exposed headers), WebSocket, EventSource, workers and worklets, the DOM's
  insertion and serialization methods, CSSOM, Typed OM, canvas tainting,
  storage partitions (localStorage, IndexedDB names, OPFS, the old
  FileSystem API, Web Locks), the cross-origin window view, the navigation
  net, error and timing entries — and reads everything back as the page
  wrote it.
- **The upstream leg** — Chrome's TLS ClientHello (tls-client / uTLS,
  extension order permuted, sessions resumed), HTTP/2 settings, header
  order and casing, client hints, `Origin` / `Referer` / `Sec-Fetch-*` as a
  direct Chrome computes them, CORS preflights, ORB / CORP / mixed-content
  judged as Chromium would, HTTPS-Upgrades.
- **Cookies** live on the server, per session, under Chromium's limits and
  context rules (SameSite, CHIPS partitions, Lax-allowing-unsafe); the
  page's `document.cookie` and Cookie Store API read and write that jar.
- **WebSocket** — `http.Hijacker` + bidirectional pipe; **WebRTC** — every
  peer connection relayed through cyrano's own TURN server.
- **Isolation** — upstream connections, TLS session tickets, cookies and
  storage are per user session; nothing crosses sessions.

The functional requirements are in [REQUIREMENTS.md](REQUIREMENTS.md); what
is done, how, and the known gaps are in [CLAUDE.md](CLAUDE.md).

## An executable spec

The rewriting rules are specified in Agda (`spec/*.agda`: URL containment,
srcset, CSS, HTML tokenization, attributes, CSP, cookies, referrer and
`Sec-Fetch-*`, CORS preflights, ORB, canvas origin-clean, …), compiled to an
oracle. The Go and TS conformance tests compare each runtime against it, and
the `*-vs-chromium` tests compare the spec and both runtimes against real
Chromium. A rule changes in the spec first, then in both runtimes.

## Repo layout

```
.
├── go/                       Go server
│   ├── src/
│   │   ├── cmd/cyrano/        the binary (cmd/mitmprobe: a diagnostic forward proxy)
│   │   └── internal/
│   │       ├── urlrewrite/     containment, CSP, referrer, cookies' rules …
│   │       ├── proxy/          the reverse proxy: request headers, CORS, ORB, preflights, framing
│   │       ├── server/         dispatch, endpoints, body rewriting
│   │       ├── htmlrewrite/    HTML and XML rewriting
│   │       ├── jsrewrite/      the JS recognizer and rules
│   │       ├── cssrewrite/     CSS rewriting
│   │       ├── upstream/       the Chrome-impersonating client (TLS, HTTP/2, HTTP/1.1 head)
│   │       ├── cookiejar/      the server-side jar
│   │       ├── headerorder/ dnscache/ tlsdial/ wsproxy/ turn/ static/ config/
│   │       └── specoracle/     runs the compiled spec for conformance tests
│   ├── assets/                 static root (the TS bundle, the landing page)
│   └── scripts/                build.sh, run.sh, Dockerfile
├── ts/
│   ├── client/                 the strict-TS browser runtime (vite IIFE → go/assets/client/)
│   │   ├── src/                 runtime/ native/ patches/ wrappers/ url/ js/ css/ xml/ cookies/ messaging/ ui/
│   │   └── tests/               unit (vitest + happy-dom), spec/ (conformance), native/ (vs real Chromium)
│   ├── e2e/                    Playwright tools: site regression, live comparison, the problems queue
│   └── bug-miner/              an older DOM-diff harness (predates the /cyrano/ URL scheme)
├── spec/                       the Agda spec and the JS rules' shared cases
├── REQUIREMENTS.md             functional spec
├── CLAUDE.md                   working notes: what is done, how, known gaps
└── LICENSE
```

## Running it

```bash
# Build the TS client (output → go/assets/client/rewriter.js)
( cd ts/client && npm install && npm run build )

# Build the Go binary (→ go/assets/cyrano)
./go/scripts/build.sh

# Run with local defaults (http://localhost:9081; go/scripts/run.sh lists every env var)
./go/scripts/run.sh

# Open the landing page (a one-input form that goes to /cyrano/<scheme>/<host>/…)
open http://localhost:9081/
```

Configuration is read from environment variables; `go/scripts/run.sh` sets
them to local-dev defaults. Serve it over TLS for real use
(`CYRANO_HTTPS_ENABLED`, `CYRANO_SSL_CERT`, `CYRANO_SSL_KEY`,
`CYRANO_PUBLIC_URL=https://…`): over plain HTTP the browser keeps six
connections to the proxy for every site's traffic, and ad-heavy pages behave
unlike direct. WebRTC needs the TURN port open (`CYRANO_TURN_PORT`, default
3478, and `CYRANO_TURN_IP`).

## Tests

```bash
# Go, and the full-stack e2e tests (proxy + fixture upstreams)
( cd go/src && go test ./... && go test -tags e2e ./internal/e2e )

# TS: strict typecheck and unit tests
( cd ts/client && npm run typecheck && npm test )

# Spec conformance (Go + TS against the compiled Agda spec), and the spec
# and both runtimes against real Chromium (Playwright's Chromium, ts/e2e)
env -u LD_LIBRARY_PATH nix develop --command make spec-check browser-check
```

Plain `go test` / `vitest` skip the conformance tests when the oracle is
missing or stale; `make spec-check` builds it.

## Testing against real sites

`ts/e2e/tools` holds the harnesses used day to day:

- `site-regress.cjs` — every site a fix was made for
  (`regression-sites.json`), direct against proxied: DOM, styles, errors,
  failed requests, and any request that escaped the proxy. Run it before a
  commit that touches rewriting, against a TLS instance:
  `PROXY=https://localhost:9443 node tools/site-regress.cjs`.
- `live-compare.cjs` — one site direct against proxied, in the same
  browser, with clicks.
- `xdrive.cjs` — the bot-protected sites, in a stock Chrome driven through
  X input (no DevTools protocol, which those sites refuse).
- `problems-queue.md` — what the random-site runs found and what became of it.

A site-found bug also gets a distilled test in
`ts/client/tests/native/*-vs-chromium.test.ts` that fails without the fix.

## Roadmap

- **Multi-instance session affinity.** Session state (cookie jar, upstream
  pools) is per process; for several instances, sticky routing on the
  session cookie rather than an external store on the hot path.
- **Permissions isolation.** Permission grants (camera, notifications, …)
  are the proxy origin's, shared by every site.
- The known gaps listed in [CLAUDE.md](CLAUDE.md) — among them a faithful
  CSP translation (it is weakened, not translated), reading markup back in
  a few remaining places (shadow roots' own serialization, ranges), and
  passkeys / FedCM, which cannot work by design.
