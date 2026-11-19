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

**JS rewriting rules live in one place** — `ts/client/src/js/rewriter.ts`
(R1…R12) with shared cases in `spec/js-rewrite/cases.json`. A rule change
goes into the TS reference, the Go recognizer and the cases file together,
then the corpus comparison is rerun (`spec/js-rewrite/README.md`).

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
- JS: our own recognizer (`go/src/internal/jsrewrite/recognizer.go`,
  ~60 MB/s, no tree); TS uses acorn as the reference implementation.
  `tdewolff/parse/v2/js` remains only for the `--prettify` debug formatter.
- `github.com/tdewolff/parse/v2/css` — CSS lexer (token-based).
- Stdlib `net/http/httputil.ReverseProxy` with Director + ModifyResponse.
- Stdlib `http.Hijacker` + raw TCP for WebSocket — no third-party WS lib.
- Stdlib `log/slog` for structured logging.

## Known gaps

- **Reading markup back** is done for attributes, script/style text
  (set by scripts, or rewritten by the server: the marked edits are taken
  out), an ancestor's `textContent`, a script's text node, and
  serialization (`native/originals.ts`, `patches/read-back.ts`; the server
  carries originals in the `crn-o` attribute, consumed before page scripts
  run). Still open: `attributes` / `getAttributeNames` list what the
  element holds (a dropped `integrity` is missing from the list); a
  `<meta http-equiv=content-security-policy>` reads its rewritten
  `content`; CSS attribute selectors match the rewritten values;
  `crossOrigin` reads the forced value.
- **JS source**: scripts are not re-printed; edits are spliced in and
  marked, and taken out again for `toString()` and script text
  (`spec/js-rewrite/README.md`). Open: stack-trace columns are the
  rewritten text's; a server-rewritten inline script's text is restored
  only through the read-back paths (not CSS attribute selectors etc.).
- **CSP** is weakened, not translated — spec/Csp.agda (both runtimes
  checked against it; `csp-vs-chromium`: whatever loads directly loads
  proxied, and the bootstrap runs): source lists gain the proxy origin,
  Trusted Types directives are kept and enforced; framing (frame-ancestors,
  X-Frame-Options) is judged by the proxy for the real embedder, checked
  against Chromium (`framing-vs-chromium`). A faithful translation
  (host-sources → proxied path prefixes, rehashed inline scripts) is not
  done: a proxied page is allowed more than direct.
- **Referrer policy**: the document's (header, `<meta name=referrer>`) is
  recorded per page; a request's own (an element's `referrerpolicy`,
  `fetch`/`Request` `referrerPolicy`) travels in its proxified URL,
  `/cyrano/https!origin/…` (spec/Containment.agda `rewriteUrlWith`,
  `targetPolicy`; unwrap ignores it — proved). The browser is always told
  unsafe-url; the proxy applies the policy (`proxy/fetch_headers.go`).
- **Request fingerprint** (checked against tls.peet.ws in real Chrome: TLS
  JA4, HTTP/2 settings and header order equal a direct Chrome's). Header
  order is the browser's own, recorded off its HTTP/1.x connection
  (`internal/headerorder`); a browser reaching the proxy over HTTP/2 (TLS
  deployment) gets Chrome's usual order from a template instead. Client
  hints are per original origin (`proxy/client_hints.go`; gaps listed
  there: delegation, `<meta>` Accept-CH, the first cross-site navigation).
  Compression dictionaries are never registered. TLS never resumes a
  session (no `pre_shared_key`), as a first connection.
- **Cloudflare**: x.com, claude.ai, nowsecure.nl pass in real Chrome; the
  managed challenge at scrapingcourse.com/cloudflare-challenge passes
  silently through the proxy (2026-11-18), as direct. Its root cause was
  the CSP translation dropping the page's Trusted Types directives: the
  challenge frame asks for `require-trusted-types-for 'script'` and tells
  when it is not enforced. They stay now, with a policy of the runtime's
  own admitted (`urlrewrite.RewriteCSP`, `TrustedTypesPolicy`;
  `native/trusted.ts` — every sink the runtime writes into gets a trusted
  value where the page gave one).
  **How it was found — use this before guessing again:** `go/src/cmd/mitmprobe`
  is a forward proxy for a *native* page (Chrome `--proxy-server`,
  `--ignore-certificate-errors`): plain, it sends the browser's traffic
  through cyrano's upstream transport untouched (passes ⇒ the network leg
  is clean); `-csp`, `-shift`, `-decode` apply one of cyrano's changes to
  an otherwise native page; `-via <cyrano>` runs cyrano's rewriting and
  runtime on native origins (`config.identity`, `config.skip`,
  `CYRANO_DEBUG_NO_JS`). One change at a time against a passing baseline
  finds the cause in minutes; diffing what scripts read did not. Headed
  Chrome via Playwright passes the challenge direct (headless does not).
  What the challenge's scripts check is public:
  github.com/bisqet/turnstile-deobfuscated.
  Other tells fixed on the way (none of them the decider): function
  stand-ins are real functions, never Proxies (`native/surface.ts` standIn:
  `Object.setPrototypeOf(f, f)` and V8's frame naming tell a Proxy), so are
  `eval`/`Function`/`Error`; CORS for cross-origin fetch/XHR
  (`patches/cors.ts`: exposed headers, the check, `Crn-I`/`Crn-C` request
  headers naming the context and credentials mode to the proxy);
  `Sec-Fetch-Storage-Access` for third-party frames
  (`proxy/storage_access.go`); original body sizes in performance entries
  (Server-Timing metric `crnb`); read-back of script text through
  ancestors' `textContent`, text nodes and `XMLSerializer`;
  `Notification.permission` in a third-party frame (`patches/embedded.ts`).
  Still different in a third-party frame: Permissions Policy (features with
  a 'self' default stay on: `document.featurePolicy`, `permissions.query`,
  `screen.isExtended`), the parent's timing entry for the frame (natively
  zeroed without Timing-Allow-Origin), `nextHopProtocol` h2 where a direct
  Chrome speaks h3, `featurePolicy.getAllowlistForFeature` naming the proxy
  origin; a stand-in's `.caller` throws (strict function) and V8's own
  messages print its source (`Reflect.construct(Object, [], fetch)`).
  CORS gaps: no preflight, no opaque responses.
  Trusted Types gaps: a page's *default* policy is handed the rewritten
  text; `setTimeout(string)` and `javascript:` URLs are not sinks the
  runtime handles.
  Google search answers `/sorry` through the proxy. Akamai Bot Manager's
  sensor (ibm.com) runs clean. `run.sh` kills every running cyrano: start
  a second (TLS) instance after it.
- **OAuth / social sign-in** (2026-11-18): from a relying site's "Sign in
  with …" button, Google, Microsoft, Apple, GitHub, LinkedIn (popup) and
  X reach their login forms through the proxy without errors (survey
  harness: direct vs proxied, headed Chrome). What that took: a page whose
  CSP lets no inline script run gets its bootstrap as external scripts
  (`htmlrewrite.BootPath`; appleid.apple.com, api.twitter.com);
  `<base href>` is rewritten; `frame-ancestors` / `X-Frame-Options` are
  judged against the real embedder (`proxy/frame_ancestors.go`);
  `<meta name="referrer">` is honoured (the proxy needs the full Referer);
  `new Request(url)` is proxified; FedCM requests are refused as if the
  user had turned third-party sign-in off (`patches/fedcm.ts` — the
  browser would make them outside the proxy). **Not verified: the
  credentialed half** (submitting a login, the redirect or popup back to
  the relying site, token exchange) — it needs a person to sign in.
  Cannot work by design: passkeys / WebAuthn (bound to the proxy's
  origin), FedCM / One Tap.
- **Random-site testing** (2026-11-18; Google 3 random words, compare
  direct vs proxied with `ts/e2e/tools/live-compare.cjs`, `HEADED=1` on a
  virtual display — never open windows on the owner's desktop, see memory).
  Fixed from it: selectors on URL attributes match the original URL
  (`patches/selectors.ts`; Squarespace ran its scripts twice); the page's
  own Request goes to fetch as is (a rebuilt one has a stream body HTTP/1.1
  cannot send); minified `@import"…"` (both runtimes); `fetchLater`,
  `new Audio(url)`; the CORS check is enforced by the proxy for scripts'
  cross-origin requests (`proxy/cors.go`: the connection is broken, a
  network error to page code); script URLs resolve against `<base href>`;
  the location view keeps the browser's fragment (Stripe); postMessage:
  a called `X.postMessage` goes through the calling window's runtime (R3,
  marks the sender), a bare `postMessage()` is its own window's, and the
  native is called from a trampoline compiled in the sender's realm — a
  blank frame the creator injected keeps its Window (and the creator's
  runtime) when it navigates, and the browser takes `event.source` from
  the calling function's realm (reCAPTCHA, PayPal); a frame handed out as
  itself stays itself after it becomes cross-origin (one WindowProxy).
  Not ours: sites whose own server fails (Cloudflare 525 on fpi-inc).
  Known: blob: URLs carry the proxy's origin.
- **Measuring pages with many requests (ads): serve the proxy over TLS.**
  Over plain HTTP the browser keeps 6 connections to the proxy for every
  site's traffic and queues the rest; over TLS it multiplexes on HTTP/2.
  Second instance: `CYRANO_PUBLIC_URL=https://localhost:9443 CYRANO_PORT=9443
  CYRANO_HTTPS_ENABLED=true CYRANO_SSL_CERT=… CYRANO_SSL_KEY=… go/assets/cyrano
  --assets go/assets` (self-signed cert; Playwright `ignoreHTTPSErrors`).
  Header order is then Chrome's template, not the browser's own
  (`internal/headerorder` reads HTTP/1.x only).
- **HTTPS-Upgrades** as Chrome's (`proxy/https_upgrades.go`): a main-frame
  http navigation is sent to https first and falls back to http when https
  fails (times.com: certificate for nytimes.com). The landing page sends a
  bare host as http. A navigation that cannot reach its origin gets an error
  page (subresources: connection closed). Check ads in a Chrome profile
  without an ad blocker: through the proxy its network rules still match
  ad paths but its per-site rules (hiding anti-adblock walls) do not.
- **Upstream connections**: one impersonation client per (session, host) —
  tls-client holds a client-wide lock across every first dial, and one
  client per session made a page's hundreds of hosts connect one by one
  (header-bidding auctions timed out). Names resolve through
  `internal/dnscache` (browser-like host cache, joined + hedged lookups).
  `CYRANO_PPROF=127.0.0.1:6060` serves pprof for such hunts.
- **Publisher harness**: direct vs proxied (TLS instance) per site — ad
  requests, filled ad frames, escapes, page errors; ad auctions vary run to
  run, so compare over several runs.
- **Frames are tested as ads use them** (`tests/native/frames-vs-chromium`):
  empty frames written into, nested empty frames, srcdoc, a `write` taken off
  the document. Runtime state is per window, never module-wide: empty frames
  get the runtime from their creator's copy of the module.
- **Site-run leftovers** (45 premium sites, 2026-11-17): `frame-ancestors`
  / `X-Frame-Options` judged against the proxy origin (Stripe, Zoom, Cisco,
  NIST); image requests escaping on Figma, Atlassian, Workday, HubSpot;
  Dropbox renders ~400 fewer elements; Notion API call gets an HTML error;
  Slack never fires `load`; publishers that block headless Chromium not
  yet checked in real Chrome.
- **Runtime vs page-hooked built-ins** (rugerforum.net / Ad-Shield,
  2026-11-18): its integrity checks replace natives with their own
  (rewritten) code; R5's `$__crn_key__` was overwritten by such a hook
  running inside `wrap_member_expression` (a regexp's `exec`), so
  `window["Array"]["from"]` read the wrong key. Now the R5 wrapper reads
  nothing of the object (`native/brand.ts`: native brand checks, no Proxy
  trap fires), uses no regexp, and puts the key back before returning.
  The runtime calls built-ins saved at load (`native/intrinsics.ts`:
  `nR`/`nO`/`nOP`, `ncall`/`napply`/`nbind`, `Safe{Weak,}{Map,Set}`,
  `nqueueMicrotask`), never the page-writable globals — keep it so in new
  code. Still live (a page that replaces them sees the runtime call them):
  Array/String/RegExp methods and iteration (for…of, spread), and the
  bundled third-party code (acorn, run whenever the runtime rewrites JS
  source; the public-suffix list). Bisecting such a site:
  `CYRANO_DEBUG_JS_OFF` (rules), `CYRANO_DEBUG_NO_JS=<url re>`,
  `CYRANO_DEBUG_R5="[!]<url re> <lo> <hi> …; …"` (R5 by offset), and
  V8 coverage / pause-on-caught-exceptions over CDP, direct vs proxied.
- **Browser-level requests** the page cannot intercept escape the proxy
  (FedCM `navigator.credentials.get`, seen on theguardian.com).
- **Not wrapped yet**: `AsyncFunction`/`GeneratorFunction` constructors;
  an SVG element's `href.baseVal` (SVGAnimatedString; setAttribute /
  setAttributeNS are rewritten); `<a ping>` in TS (Go rewrites it). The
  Navigation API is wrapped (`patches/navigation.ts`; Shopify). Open from
  random-site testing (2026-11-18): `location` / `top` / `parent` read by
  destructuring is handled where the pattern has a source (R14:
  declarations, assignments — Transcend's consent manager), not in a
  parameter's or a nested pattern; a document whose CSP is `default-src 'none'` still gets the runtime.
  `fetchLater` keeps its quota per original origin and defers what the
  proxy makes the native refuse (`patches/fetch-later.ts`; tumblr) — the
  requests it defers go out with keepalive (64 KiB in flight at unload). DOM insertion by any
  method gives inserted empty frames the runtime (`dynamic-iframe.ts`); the
  URL fix-up before insert is still only appendChild/insertBefore/replaceChild.
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
