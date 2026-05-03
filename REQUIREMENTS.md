# Requirements

## What this is

A **clientless SSL VPN rewriter**: a transparent HTTP/HTTPS proxy that rewrites
HTML, JavaScript, and CSS on the wire so a browser sees the *original* origin
while every actual network request flows through the proxy. The browser thinks
it's talking to `example.com`; the wire and DNS only ever touch
`localhost:9080` (or wherever the proxy is deployed).

"Clientless" means no extension, no native client, no PAC file, no system
proxy setting — the user just visits a proxified URL like
`http://proxy/?goto=<base64(https://example.com/)>` and the rest is rewriting.

## What it must do

### 1. URL containment

Every URL the browser would otherwise send to a third party must be rewritten
to land at the proxy. The encoding scheme:

- `https://example.com/path?q=1` → `http://proxy:9080/?goto=<base64url(https://example.com/path?q=1)>`
- Base64url with no padding (RFC 4648 §5)
- Anchor URLs (`#foo`) and special schemes (`javascript:`, `data:`, `blob:`,
  `mailto:`, `tel:`, `about:`) pass through unchanged
- URLs already on the proxy host with a `load=` param pass through unchanged
  (don't double-rewrite)

### 2. Server-side body rewriting

By Content-Type:

| Content-Type | Rewriter | What it does |
|---|---|---|
| `text/html`, `application/xhtml+xml` | HTML | URL containment in tag attrs (src/href/srcset/action/etc.), bootstrap script injection at `<head>`, drop CSP meta, strip integrity, force `crossorigin=use-credentials`, ensure iframe `allow-same-origin`, inject cookie-sync onload hooks, rewrite `<noscript>` content as HTML fragment, strip whitespace from URLs (tab/LF/CR) |
| `application/javascript` | JS | AST-level wrapping of `location`/`top`/`parent` (get + set + member-access), `eval` (and direct calls), `document.write`/`postMessage`, `obj[expr]` computed access, `import(specifier)` dynamic imports (static specifiers resolved at rewrite time; dynamic expressions wrapped with `$rewriter.wrap_import_arg`) |
| `text/css` | CSS | Rewrite every `url()` and `@import` URL |
| inline `<script>` text | JS | Same as JS files |
| inline `<style>` text + `style="..."` attr | CSS | Same as CSS files |
| everything else | passthrough | No transformation |

### 3. Client-side runtime (browser-side)

A bundled IIFE script (`/rewriter.js`) that the HTML rewriter injects into
every page. It exposes `window.$rewriter` with helpers the server-rewritten
code calls into:

- `wrap_get_location` / `wrap_set_location` / `wrap_location` — lie to page
  code about `location.*` so it reads the original URL while writes are
  rewritten through `rewriteUrl()` and applied to the real `window.location`
- `wrap_get_top_window` / `wrap_top_window` / `wrap_parent_window` — same
  for `top` and `parent` window references
- `wrap_document_write`, `wrap_postMessage` — passthroughs in the current
  client (full semantics need an HTML parser in-browser; not yet)
- `wrap_eval` / `wrap_eval_arg` / `wrap_eval_memexp` — same caveat
- `wrap_member_expression` — for dynamic `obj[expr]`
- `set_base_url`, `set_location`, `set_cookies` — bootstrap state setters
- `process_server_cookies` / `fetch_cookies` — called from injected onload
  handlers to sync cookies after subresource loads
- `append_rewrite_script_into_iframe`, `get_top_level_window` — iframe helpers

The client also installs **prototype patches** for DOM URL-bearing APIs that
the server-side AST rewriter can't catch statically:

- `fetch`, `XMLHttpRequest.prototype.open`
- `WebSocket`, `EventSource`, `Worker`, `SharedWorker` constructors
- `navigator.sendBeacon` — rewrites analytics/telemetry beacon URLs
- `History.prototype.pushState` / `replaceState` — rewrites the URL argument
- `Node.prototype.appendChild` / `insertBefore` — injects rewriter runtime
  into dynamically-created `about:blank` iframes synchronously
- `src` / `href` / `srcset` / `action` / `data` / `poster` setters on Image,
  Script, IFrame, Source, Embed, Audio, Video, Track, Link, Anchor, Area,
  Form, Object element prototypes
- `Element.prototype.setAttribute` — all URL-bearing attributes
- `Element.prototype.innerHTML` / `outerHTML` / `insertAdjacentHTML` — HTML
  string rewrites via the client-side HTML rewriter
- `Function` constructor — `new Function(src)` / `Function(src)` patterns
  pass the body through the JS rewriter
- CSS: `CSSStyleSheet.prototype.insertRule`, `CSSStyleDeclaration` style
  property setters — rewrite `url()` values in dynamically-set CSS
- `window.location` property — overridden with `WrappedLocation` so all reads
  return the original URL; writes rewrite and navigate through the proxy
- `document.URL` / `document.baseURI` — patched to return the original URL
  so that `new URL(path, document.baseURI)` resolves against the original
  origin (critical for chunk loaders and dynamic `import()` on Astro/webpack sites)
- **`MutationObserver` safety net** — installed on the document root; watches
  all URL-bearing attributes (`src`, `href`, `srcset`, `action`, `data`,
  `poster`) across the full DOM subtree. When a non-proxified URL lands on a
  live element (i.e. a write path that bypassed every other patch), it is
  rewritten in-place via the pre-patch native `setAttribute` and logged to an
  in-memory miss log. On install, the observer also retroactively scans
  existing `<iframe>` elements: injects the rewriter runtime into same-origin
  frames and rewrites (reloads) any iframe whose `src` is an unproxified URL.

### 4. Session + cookies

- Per-session cookie storage keyed by a `crnsid` session cookie
- `/head-injection?bu=<b64>` endpoint emits an inline JS snippet calling
  `$rewriter.set_location(originalUrl)` so the page knows its effective URL
- `/cookies.json?p=<b64(url1,url2,...)>` returns the cookies the proxy holds
  for those resource hostnames
- Cookies received from upstream `Set-Cookie` are stored in the proxy's
  session, not forwarded to the browser as origin cookies (would leak
  cross-site state)
- Optional AES-CTR payload encryption (when `userDataEncryption: true`)

### 5. WebSocket / SSE / streaming

- WebSocket upgrades over `ws(s)://proxy/?goto=<b64(wss://origin/...)>` —
  hijack the conn, dial upstream, pipe frames bidirectionally
- Server-Sent Events (`text/event-stream`) — passthrough (no rewriting,
  no buffering)
- Long-poll / chunked / streaming — no body buffering when there's nothing
  to rewrite

### 6. Liveness + health

- `/rewriter-status.json` → `{"status":"ok"}`
- `/rewriter-extended-status.json` → adds upstream-storage liveness

## What it deliberately does NOT do

- **No allowlist / blocklist gating** — barebones; add per-deployment if needed.

## Architecture targets

- **Server in Go** — `golang.org/x/net/html` for HTML, `tdewolff/parse/v2/{js,css}`
  for JS/CSS, stdlib for HTTP/proxy/WebSocket. Single binary, no Node.js
  runtime needed. Located at `go/`.
- **Client in strict TypeScript** — Vite 5, IIFE output, every TS strictness
  flag enabled. Located at `ts/client/`.
- **Static assets** at `go/assets/` — served by the Go server, also writable
  by the TS build.
- **Configuration** as JSON, schema shared between Go and (legacy) Node.js
  runtimes, located in `config/`.

## Test surface

- **Go**: 125 tests across `b64u`, `urlrewrite`, `proxy`, `htmlrewrite`,
  `jsrewrite`, `cssrewrite`, `wsproxy`. Run with `cd go/src && go test ./...`.
- **TS**: 285 vitest tests under `ts/client/tests/`. Run with
  `cd ts/client && npx vitest run`. Typecheck: `npm run typecheck`.
- **bug-miner**: Playwright harness under `ts/bug-miner/`. Fetches sites via
  direct and proxied paths, diffs DOM/text/console-errors. Run:
  `cd ts/bug-miner && npm run mine`.

## Known gaps (tracked, not blocking demo)

1. Cookie storage is in-process. Multi-instance deployments need sticky
   routing (e.g. Istio consistent-hash on `crnsid`) rather than an external
   store — an external store adds latency on every proxied request.
2. Client `wrap_eval` / `wrap_postMessage` are passthroughs — full semantics
   need an in-browser JS parser.
3. AES-CTR payload encryption is wired but not implemented (Web Crypto in
   the TS client; matching helper in Go).
4. `document.currentScript.src` returns the proxy URL rather than the original
   URL — webpack `publicPath` auto-detection reads this and may compute the
   wrong chunk base. Partially mitigated by `document.baseURI` being patched.
5. Dynamic ES modules: `import.meta.url` in external module files returns the
   proxy URL — Astro/Vite chunk loaders that use `import.meta.url` as a base
   rather than `document.baseURI` may still mis-resolve chunk paths.
6. Blob URL contexts (workers / script blobs) execute with rewriter-injected
   code but no `$rewriter` in scope — calls to `$rewriter.*` from blob-URL
   workers throw `ReferenceError`.
