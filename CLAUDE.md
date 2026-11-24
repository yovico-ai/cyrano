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
# Go — fast; and the full-stack e2e tests (proxy + fixture upstreams)
( cd go/src && go test ./... && go test -tags e2e ./internal/e2e )

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
  The handshake carries the target's cookies only (`proxy.WebSocketCookies`):
  until 2026-11-22 it forwarded every proxied site's and the session cookie.
- Stdlib `log/slog` for structured logging.

## What a response is rewritten as

An XML document the browser renders — `image/svg+xml`, `application/xhtml+xml`,
`text/xml`, `application/xml` (measured: Chromium shows `text/*+xml` and the
feeds as text, downloads other `+xml` types), or an untyped / unknown-typed
document whose body starts with `<?xml` after whitespace (this case only) —
for a document destination (navigation, iframe, frame, object, embed) — is
rewritten as XML (spec/Disposition.agda asXml, spec/XmlDoc.agda; Go
`htmlrewrite.RewriteXML`): edited in place so it stays well-formed, its
SVG / XHTML elements' attributes by the `Attrs.agda` table (namespaces
resolved: `xlink:href` by any prefix bound to XLink), `<style>` / `<script>`
text and CDATA, `<?xml-stylesheet href?>`, the originals in `crn-o`; the
bootstrap as SVG or XHTML `<script>` elements after the root's start tag.
A document that does not read (malformed, an unbound prefix, a DTD entity)
is given as sent. XHTML used to go through the HTML rewriter, whose output
need not be well-formed XML. The XML parser has no microtask checkpoint
before a parser-inserted script, so in such a document the runtime takes an
element's originals on first reading it (`consumeOriginalsOnRead`).
pokemon-vortex.com's `<object>` SVG logo loaded its font from the origin
(`svg-document-vs-chromium`: the real server, Chromium, direct vs proxied).
An SVG requested as an image is left as it is (images load nothing).


By what the request is for, never by its Content-Type, which the proxy
never changes (spec/Disposition.agda; the browser decides what it runs).
The rewriter marks the proxified URL of every script and stylesheet it
writes — `<script src>`, `<link rel=stylesheet>`, their preloads, the Link
header, `@import`, import maps, module specifiers, `importScripts`, the
runtime's setters — as `/cyrano/https!js/…` or `!css` (after a policy mark,
`!origin!js`; spec/Containment.agda, Attrs.agda `urlDest`). (A frame's URL is marked `!frame`, which says who embeds it and
nothing of how it is rewritten.) A marked
response is rewritten as such even when served `text/plain`; a
cross-origin stylesheet of another type gets `nosniff` (it would apply in
a quirks document only same-origin: Disposition.agda `proxied-sheet`); an unmarked
one goes by Sec-Fetch-Dest (a prefetch for no destination — `<link
rel=prefetch>`, Sec-Purpose: prefetch — as a document: Chrome navigates
from it; Disposition.agda judgedDest, togaze.com); a fetch() of the same file gets the origin's
bytes under a different URL, so the browser's cache never hands a script
the data copy. Unwrap ignores the marks. A cross-origin script response
Chromium's ORB blocks (JSON, HTML, PDF… — spec/Orb.agda, checked against
Chromium) is failed by the proxy when the script was asked in no-cors mode
(the page's own: a missing crossorigin stays missing), whatever
Access-Control-Allow-Origin it carries, and is not a redirect (adform's 301
has an HTML body; the browser follows it); a cors-mode one (crossorigin, a
module) gets the CORS check by the page's origin, as for anonymous
(`proxy/orb.go` scriptCORSFails; snowball-io.io, `script-mode-vs-chromium`):
"null" for a sandboxed document, not judged when the Referer is itself a
script (a module's import: the page behind it is unknown). A sandboxed
document's browser runs CORS itself, use-credentials (the runtimes'
crossorigin): a response the anonymous check allows from "null" is told to
it as `null` + credentials (`opaqueElementCORS`). A typeless response stays
typeless (net/http would sniff one: `typelessWriter`).

## The portal toolbar

The small control over a proxied top-level page — grip, `<<`, home, `>>`
(`ts/client/src/ui/toolbar.ts`, spec/Toolbar.agda; `CYRANO_TOOLBAR=false`
turns it off; `tests/native/toolbar-vs-chromium`). The page cannot tell it
is there: it is no node of the page's DOM (a closed shadow root on
`<body>`, the body's content through a slot), out of flow, styled by a
constructed sheet of that root (its slot `all: inherit; display:
contents`: the body's children inherit the body's values through it —
`*{box-sizing:inherit}` pages lost border-box), and takes no pointer events — the runtime
takes the user's pointer events at the window, first in line, by
coordinates. Its cursor is the host's (`:host`), inherited beneath. Home
leaves without a Referer (`window.open(url, "_self", "noreferrer")`: a
bare path with a proxied Referer is the page's own, spec/Route.agda). Its
place is kept in localStorage under a bare name no page's view lists.
Limits: a page that makes `<body>` a shadow host itself (first: no
toolbar there; later: its attachShadow throws); computed `cursor` reads
the toolbar's while the pointer is over it; an element beneath with a
cursor of its own keeps it.

## The navigation net

A `navigate` listener, the first on `navigation` (`patches/navigation.ts`,
spec/Route.agda netDestination; `tests/native/navigation-net-vs-chromium`):
a navigation the document starts for an http(s) URL off the proxy's
origin — by code the rules never saw (`window[k] = url`, a setTimeout
string), a meta refresh, an unrewritten link or form — is cancelled and
made to the proxified URL (a form resubmitted to it, method and body
kept). A destination on the proxy's origin is left alone (the server's
Referer routing takes bare paths). Browser-side only; the page's own
navigate listeners see just the navigation that replaces it. Limit: a
frame still on its initial about:blank has the Navigation API's events
off (HTML), so code no rule saw that navigates such a frame (a
`setTimeout` string) is not caught; rewritten code is
(`frame-navigation-net-vs-chromium`: a handler written into an empty
frame, its `eval`, an `onload` attribute, `contentWindow[k].href`). A
popup opened on about:blank (`window.open("")`, `"about:blank"`: the
OAuth / payment pattern) gets its opener's runtime as an empty frame its
creator's (`patches/window-open.ts`, `injectIntoWindow`): what is written
into it and where the opener sends it go through the proxy, its cookies
and origin are the opener's (`popup-blank-vs-chromium`).

## Known gaps

- **Reading markup back** is done for attributes, script/style text
  (set by scripts, or rewritten by the server: the marked edits are taken
  out), an ancestor's `textContent`, a script's text node, and
  serialization, isEqualNode (Next.js's head manager re-inserted a rewritten
  script it found unequal: washingtonpost.com ran its ads twice)
  (`native/originals.ts`, `patches/read-back.ts`; the server
  carries originals in the `crn-o` attribute, consumed before page scripts
  run; a `<style>` whose text a rewriter changed carries it as written in
  `crn-o` under `#text`, both runtimes: React hydrates App Router pages
  against the `<style>`'s textContent, 21kschool.com). Still open:
  CharacterData methods (`substringData`) read the rewritten text;
  `attributes` / `getAttributeNames` list what the
  element holds (a dropped `integrity` is missing from the list); a
  `<meta http-equiv=content-security-policy>` reads its rewritten
  `content`; CSS attribute selectors match the rewritten values;
  `crossOrigin` reads the forced value.
- **localStorage, each site its own quota** (spec/LocalStore.agda,
  `patches/local-store.ts`, local-store-vs-chromium): every proxied site
  shares the proxy origin's one localStorage (Chromium: 5 242 880 UTF-16
  code units of keys and values per storage key, measured). A partition
  now lives in memory, in IndexedDB (all of it; name "crn␟ls", which no
  page lists) and in the native store as far as it fits, which is read
  synchronously at load. A full native store evicts other partitions
  (least recently used, only those IndexedDB holds); a write fails only
  when the writer's own partition passes the quota. Limit: entries evicted
  from the native store read as missing for the first moments of the
  site's next load, until IndexedDB answers. sessionStorage stays native (prefixed; a native refusal names the page's
  key). The native store is only a cache: its own refusals (a frame's
  Storage gone) never reach the page.
- **Cookies live on the server** (spec/CookieJar.agda, `internal/cookiejar`,
  `proxy/session_jar.go`; runtime `cookies/memory.ts`;
  `cookie-jar-vs-chromium`): every cookie of a session, script-visible
  ones too, is in the server's jar under Chromium's limits per registrable
  domain (180 purged to 150 by priority-aware LRU with secure protection,
  3300 in all — `cookie-evict-vs-chromium`), kept on disk
  (`CYRANO_COOKIE_DIR`, default the user cache dir). The browser's jar
  carries the session cookie (persistent: 400 days), a browser-session
  marker (a session cookie; a request without it ends the jar's session
  cookies, as a restart does — once the browser has sent it, however
  soon; requests sent before it stored a new one get it again) and the channel, all `Priority=Low`: a
  script's writes packed into a few outbox slots per page tree (ride the
  next request; the server's one ack per tree clears them), and inbox
  entries for changes a response made to the requesting page's own site
  (absorbed before every read and on cookieStore's change event), and —
  with no page known (a blob worker's fetch) or on a document's own
  response (a download, a frame sent to JSON) — for the response's own
  site; a response the proxy fails (ORB, CORS) still stores its cookies,
  its inbox entries riding the session's next response. A
  document gets its cookies inline in its config (`ck`; an external
  bootstrap's from the boot handler, never in a URL) and is revalidated
  (`no-cache`). Other tabs hear of a write on a BroadcastChannel. Cookie
  dates as Chromium reads them (spec/CookieDate.agda, not the RFC's);
  Chromium's Lax-allowing-unsafe: a cookie stating no SameSite goes on a
  cross-site top-level POST while at most two minutes old (OIDC
  form_post, SAML; the jar's creation times; Cookies.sameSiteAllows);
  another window's cookie accessor called on a document serves it through
  that document's own window (Quantum Metric takes its natives from a
  frame: `cookie-cross-realm-vs-chromium`);
  an overwrite with another value is a new cookie (last in order).
  Cookies of the old wire form (`__crn!`) are read until the jar holds
  their identity. cookieStore's change events are made from memory's
  changes, as Chromium's (one per write shown at the page's URL, even of
  the same value; a later task; the browser's own, listing the channel,
  are stopped — only trusted ones: `cookie-change-events-vs-chromium`);
  an expiry keeps microseconds as Chromium's (coarsened). Gaps: a made
  change event is not isTrusted; a script's write over an HttpOnly cookie
  shows in its memory until the next document; a third party's cookie a subresource sets reaches a
  live frame of that party only with its next document; last access of
  cookies a script reads is not tracked.
- **eval** (spec/Eval.agda, checked in Chromium by eval-calls-vs-chromium
  against the oracle): every eval the source shows is rewritten — eval(…)
  and (eval)(…) direct, X.eval(…), X["eval"](…), eval.call/apply (and
  X.eval's), (…, eval)(…) — and nothing else is touched: the runtime's
  wrap_eval_arg / wrap_eval_args rewrite only when the callee is an
  evaluator (identity: each realm's runtime records its window's eval at
  load), else pass the argument through. A read of eval, by any route,
  gives the intrinsic (no stand-in): a stand-in made `var eval =
  window.eval; eval(s)` indirect — Salesforce's Locker evaluates every
  component that way inside its `with (sandbox)`, and they ran outside it
  (help.twitch.tv; now as direct). Known limit, stated in the spec: the
  intrinsic stored and called under another name (`const e = window.eval;
  e(s)`) runs its source as written (guarding every call is not done).
  A Trusted Types default policy sees every eval but may not change its
  source (Chrome refuses), so it cannot be the catch-all.
- **JS source**: scripts are not re-printed; edits are spliced in and
  marked, and taken out again for `toString()` and script text
  (`spec/js-rewrite/README.md`). Code made with `new Function` names the
  page's calling frame as its eval origin, not the runtime's stand-in
  (a //# sourceURL tag the stack formatter puts back; spec/Stack.agda
  evalOrigin, untag; Kasada reads it). A stack's first line is V8's: the
  name the error has when the stack is first read, the message it was
  made with (recorded by the Error stand-in; `error-header-vs-chromium`;
  an error V8 throws itself shows a message changed before the first
  read — it is never seen made). A member that is written (`obj[k] = …`, `x.top = …`,
  `x.parent = …`: the next token a plain `=`) is left as written (R3, R5),
  so V8 names a function from its target as directly (`obj.<computed>`;
  rewritten, frames read `$rewriter.wrap_member_expression`: Adobe Launch).
  `window[k] = url` is then the navigation net's (below). Open: stack-trace columns are the
  rewritten text's (a Function body's first line: the preamble's); a server-rewritten inline script's text is restored
  only through the read-back paths (not CSS attribute selectors etc.).
- **CSP** is weakened, not translated — spec/Csp.agda (both runtimes
  checked against it; `csp-vs-chromium`: whatever loads directly loads
  proxied, and the bootstrap runs): source lists gain the proxy origin,
  Trusted Types directives are kept and enforced; `form-action` and
  `base-uri` gain it too (a form's action and a `<base href>` are on the
  proxy: dzen.ru's SSO post was refused, `csp-form-action-vs-chromium`); the connect policy
  also admits the proxy's WebSocket origin (`wss://` for an https proxy:
  an https: source does not admit wss:, Csp.agda wsOrigin; emeralds.com's
  chat), blob: and data: (the runtime reads a page's blob worker
  script with an XHR the page does not make: Costco); framing (frame-ancestors,
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
  Compression dictionaries are never registered (spec/Dictionary.agda:
Use-As-Dictionary gains `, type=crn`, which Chromium does not register). TLS never resumes a
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
  (`proxy/storage_access.go`, spec/Storage.agda: by the chain of sites);
  no Sec-Fetch-* / client hints to an http name, as direct
  (spec/Metadata.agda, `upstream.copyHeaders`); original body sizes in performance entries
  (Server-Timing metric `crnb`); read-back of script text through
  ancestors' `textContent`, text nodes and `XMLSerializer`;
  `Notification.permission` in a third-party frame (`patches/embedded.ts`).
  Permissions-Policy and an iframe's `allow` are read as Chromium reads
  them and translated (spec/Permissions.agda, Allow.agda: origins become
  self / 'src', which on the proxy every frame is).
  Still different in a third-party frame: Permissions Policy (features with
  a 'self' default stay on: `document.featurePolicy`, `permissions.query`,
  `screen.isExtended`), the parent's timing entry for the frame (natively
  zeroed without Timing-Allow-Origin), `nextHopProtocol` h2 where a direct
  Chrome speaks h3, `featurePolicy.getAllowlistForFeature` naming the proxy
  origin; a stand-in's `.caller` throws (strict function) and V8's own
  messages print its source (`Reflect.construct(Object, [], fetch)`).
  A response that varies on Origin is told to the browser as varying on
  Crn-I too (`proxy/vary.go`, spec/Carry.agda varyForBrowser): one cached
  copy went to every page (bbc.com was handed bbc.co.uk's, failed CORS and
  bounced back). The runtime's Crn-I / Crn-C on a fetch init are handed to
  the native as pairs: a Headers is read by its iterator, which hides them
  (until 2026-11-20 they were never sent from fetch(url[, init])).
  CORS gaps: no preflight, no opaque responses. A sandboxed (opaque-origin)
  document is cross-origin to the proxy, so the browser runs CORS there
  itself: the runtime adds no Crn-I/Crn-C (they forced preflights), and
  the proxy sends Origin "null", cross-site, as direct (spec/Fetch.agda
  namesContext, Referrer.agda originHeaderOpaque); it reads `origin`
  "null". The Cookie Store API reads and writes the same jar as
  document.cookie (spec/Cookies.agda cookieStoreSet; `patches/cookie-store.ts`:
  Google's ad tag stores __gads/__gpi/__eoi with it, every write was refused);
  its refusals are the native's own, and change events still list the
  wire cookies. `import.meta.resolve` is the runtime's (R15: it resolved against
  the proxied module URL; IKEA's Vite preloads). import() in code made at
  run time (new Function, eval) resolves against the script that made it,
  found from the stack when the source names `import` (`js/made-code.ts`;
  Usercentrics' `new Function("u","return import(u)")` on
  halespropertymanagement.com; `made-code-import-vs-chromium`). Known gap:
  natively a classic script fetched cross-origin without CORS resolves
  nothing (base about:blank); proxied every script is CORS same-origin.
  R13's global object inside a `with` takes `globalThis` (when it holds the
  runtime) before compiling "return this": that is an eval, refused under a
  CSP without 'unsafe-eval' (the Facebook SDK's strict modules in Disqus
  frames; `with-global-csp-vs-chromium`). A `new Function` body is tagged
  once per eval origin, so a body made again at the same place is the same
  source (V8's compilation cache; the tag table bounded). Media Session
  artwork `src`s are proxified (the browser fetches them itself:
  visitoslo.com; `media-metadata-vs-chromium`). Markup written into a
  document with no `<base href>` yet takes the first one it writes as the
  base of what follows in the same write (Flashtalking richloads on
  ginifab.com: `written-base-vs-chromium`). A module worker (`{type: "module"}`) has
  its URL marked `!mjs` by the runtime's Worker (through the proxy it is
  asked for same-origin, as a classic one) and gets the module preamble; a
  module it imports gets none (asked for as a worker's, marked `!js`); a
  blob module worker's static imports are proxified against its own URL
  (crumblcookies.com's MapLibre; `module-worker-vs-chromium`). A worker reads its own URL,
  fragment included (a served worker's from its own location, unwrapped;
  a blob: worker's the page's blob URL with the page's origin; Turbopack's
  `#params=` on thangs.com: `worker-location-vs-chromium`).
  `WebSocket#url` reads the page's URL made ws(s) as the browser makes it
  (toutiao.com: `websocket-url-vs-chromium`). A frame whose document has
  committed is that document's origin, not its src's (a frame sent
  elsewhere and redirected back to the page's origin: ir.netflix.net's
  Q4 sign-in; `frame-redirect-back-vs-chromium`); only an empty frame
  (about:) not on its way to a proxied URL is given its creator's runtime
  (a proxied document with no runtime of its own read the creator's URL).
  Limit: such a document reads its own `URL` from its own realm, proxied.
  The postMessage trampoline is compiled only for a realm other than the
  runtime's own (under Trusted Types a compile is a violation: Pinterest;
  Chrome's Function takes no TrustedScript), and only for one with no copy
  of the runtime of its own (`Internals.realmApply`: a frame's CSP without
  'unsafe-eval' refused the compile, a violation per message — Disqus and
  Google sign-in frames on dexterdaily.com; `csp-postmessage-vs-chromium`);
  a refused compile is not retried. A fetch preload keeps its
  crossorigin (Attrs.agda crossoriginValue: Spotify fetched its JSON twice).
  Trusted Types gaps: a page's *default* policy is handed the rewritten
  text; `setTimeout(string)` and `javascript:` URLs are not sinks the
  runtime handles.
  Kasada (Costco, 2026-11-20) passes through the proxy: its fingerprint
  read the runtime's `new Function` stand-in as eval origin and V8's own
  message for `class extends Function.prototype.toString` (now padded to
  print as native: `native/padded.ts`; other stand-ins still print their
  source in such messages). Its report is XOR'd with "omgtopkek" — decode
  it before guessing. PerimeterX (Zillow /graphql, Target's
  redsky store_location_v1 / nearby_stores_v1) passes through the proxy
  in real Chrome (2026-11-20, after written members stayed as written and
  `location` by reflection; not bisected to one of them). Judge it in
  real Chrome only: a Playwright-driven Chrome is refused direct as well
  (Zillow 403, Target 435 on the direct side), so that harness tells
  nothing about the proxy. Its sensor's serialized events do not carry
  `PX<n>` names any more (a JSON.stringify hook matched none). On the way:
  `location` reached by reflection (Reflect.get, the window's/document's
  own getter, __lookupGetter__) is the view, as by name
  (`patches/location-reflect.ts`). Markup inside a `<template>` reads back as written:
  serialization pairs template content with its clone's, and a URL in a
  document with no browsing context (template content, DOMParser) resolves
  the page's value against that document's base, as natively (heart.org's
  Vue templates; `template-readback-vs-chromium`). `serviceWorker.getRegistration`
  is judged by the page's own origin (none can be registered: undefined;
  another origin: the native's SecurityError naming the page's; staples.com;
  `service-worker-vs-chromium`). Google search answers `/sorry` through the proxy. Akamai Bot Manager's
  sensor (ibm.com) runs clean. `run.sh` kills every running cyrano: start
  a second (TLS) instance after it.
- **OAuth / social sign-in** (2026-11-18): from a relying site's "Sign in
  with …" button, Google, Microsoft, Apple, GitHub, LinkedIn (popup) and
  X reach their login forms through the proxy without errors (survey
  harness: direct vs proxied, headed Chrome). What that took: a page whose
  CSP lets no inline script run gets its bootstrap as external scripts
  (`htmlrewrite.BootPath`; appleid.apple.com, api.twitter.com);
  `<base href>` is rewritten; `frame-ancestors` / `X-Frame-Options` are
  judged against the real embedder (`proxy/frame_ancestors.go`): the
  frame's parent. A document gives its frames marked URLs —
  `/cyrano/https!frame/…` for an iframe's / frame's / embed's src, an
  object's data, a child's location set by its parent (Containment.agda
  destFrame, Attrs.agda urlDest) — so a marked navigation is embedded by
  the Referer's document, and an unmarked one from a frame's document (the
  frame navigating itself: a link, a form POST back from a login page)
  keeps that frame's recorded embedder (Frames.agda embedderOf;
  support.microsoft.com's silent sign-in frame was refused). Not told
  apart: a framed document navigating a frame of its own by name;
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
  cannot send), judged by the URL it holds, not its `url` (YouTube's
  blocker bait: a data: Request subclass naming its player API); minified `@import"…"` (both runtimes); CSS handed to a constructed sheet
  (replace, replaceSync, addRule: Google Pay's button on Bloomberg); `fetchLater`,
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
  From the 2026-11-19 run: the Link header's integrity / crossorigin
  (spec/Link.agda; Shop Pay's modulepreload was blocked); a RequestInit's
  referrer (spec/Referrer.agda initReferrer; Mapbox's worker names its
  page, its URL-restricted token was refused); a cross-origin window's
  child frames by name (`parent.frames["a-…"]`, reCAPTCHA). Not ours
  there: stamped.io's own init race, artfund's origin alternating 301 and
  a meta-refresh page, readthedocs' and 1stdibs' challenges (direct too,
  once the IP is flagged).
  Known: blob: URLs carry the proxy's origin. A frame given a blob: URL
  of an HTML document the page built (src, setAttribute, markup) gets that
  document rewritten as a srcdoc is, its first `<base href>` the base of
  what follows (spec/Frames.agda blobDocument, `patches/blob-document.ts`;
  TradingView's chart on bitrue.com loaded its bundles from their origin);
  the page reads back its own URL; the frame's location reads the
  rewritten blob's. A blob stylesheet a link is given is rewritten too,
  against the document's base (Chromium's); a blob document's references
  without a scheme fail as directly (blobBase).
- **Turnstile on a page's main thread** (techcrunch.com, 2026-11-20):
  direct, its frame is another process; proxied, every frame shares the
  page's thread, so what its interpreter costs the page feels. It froze
  the page: R5 made the interpreter three times slower, and it times an
  eval of 1.3 MB of spaces twice a second, which went through acorn
  (80 ms each). Now: R5 skips keys that are certainly numbers, its helper
  returns at once for anything else that is not this window's, a source
  no rule could touch is not parsed (`mayEdit`, both runtimes), a
  repeated source is not parsed again, and the public-suffix trie is
  built once for a page and its frames (`native/internals.ts`
  sharedData). Good runs are at direct's CPU. The 20 s hangs that
  remained were not cost at all but Turnstile's answer to a tell: it makes
  an empty sandboxed frame (allow-same-origin, in a closed shadow root) as
  a source of pristine natives and reads `eval` with that frame's
  `Function.prototype.toString`; given our stand-in's source it
  stringifies eval over a million times (8 in a good run) on the page's
  thread. The stand-in showed because every loaded document has its own
  copy of the runtime, each with a private table of what its stand-ins
  stand for: a toString patched by one copy did not know another's. Such
  registries are now one for a page tree (`native/shared.ts`: masks,
  masked realms, eval stand-ins, recorded originals;
  `tests/native/cross-window-surface-vs-chromium`). Saved specimen: 10 of
  10 hung with marks stripped, 4 of 15 as rewritten; after, 0 of 23, and
  0 of 8 live. Lessons: (1) a hang in a challenge's interpreter is first
  a question of what it saw, not what it costs — count its native calls
  (a good run against a hung one) before profiling; (2) "R5 off: 0 of 24
  hung" proved nothing: without R5 the frame reads the proxy's location
  and never reaches the check — an A/B is only as good as the proof that
  both arms got as far; (3) a hung run's frame document can be replayed
  (the hang comes before the first POST): scratchpad `replay.cjs` /
  `replayroute.cjs` serve a saved one in place of the live one,
  `variants.cjs` rewrites its edits fragment by fragment, `LOGCALLS=1`
  logs every native the interpreter applies (`ring2.cjs` reads the log
  inside the hang, through a debugger pause). Still per copy, so still
  tells where two copies meet: window views (`native/cross-origin.ts`),
  Trusted Types policies, stack tags, document.write state. An empty
  frame runs on its creator's copy, so what the runtime makes for it
  (promises, arrays, errors) is of the creator's realm. Open: a `srcdoc`
  frame under Turnstile's CSP has an inline script refused (the committed
  build too). Tools: scratchpad `loop.cjs` (CDP
  profile by host, `NOISO=1` puts frames in one process for a like-for-like
  direct profile), `pause2.cjs` (stack samples inside a hang).
- **Measure load time without a debugger attached.** A DevTools session
  (Playwright, any CDP client) makes every stack capture walk the whole
  stack: the runtime's `new Function` stand-in took a minute on qidian.com
  under Playwright and ~1 s more than direct in a stock Chrome. Start Chrome
  with `--remote-debugging-port` and attach only after the load
  (scratchpad `loadtime.cjs`, `fntime.cjs`).
- **Speed: profile before guessing.** A page that feels slow proxied was
  the runtime's CPU, not the network: CDP `Network.loadingFinished` early
  but `responseReceived` late means the main thread is busy — take a
  `Profiler` profile (warframe.market: `isWindowObject` threw for every
  `obj.parent` of a tree walk, 26 s of 35). A throw per call is the cost to
  look for: ~15 µs, stack capture or not. The brand checks now rule out
  non-candidates with [LegacyLenientThis] accessors (Window's onmouseenter,
  Document's onreadystatechange: undefined for another receiver, no throw,
  no Proxy trap — `native/brand.ts`). A 12-site sample (2026-11-20): median
  load 1.2x direct over TLS; the runtime ~20% of main-thread time on a
  script-heavy page.
- **The runtime bundle is named by its content** (`static.RuntimeURL`:
  `/rewriter.js?v=<hash>`, served immutable; any other name revalidated).
  Served no-store, a page with 250 ad frames downloaded it 250 times, hit
  Chrome's limit on requests in flight (ERR_INSUFFICIENT_RESOURCES) and
  left frames without it. **The bootstrap fails closed**
  (`htmlrewrite.FailClosed`, TS `FAIL_CLOSED`, held equal by a Go test):
  without the runtime the document stops loading — those frames' scripts
  had run unproxied and reached their origins (windowscentral.com;
  `tests/native/fail-closed-vs-chromium`).
- **HTTP/1.1 upstream requests are Chrome's** (spec/H1.agda h1Head,
  `upstream/h1head.go`): Host first, `Connection: keep-alive`, client
  hints lower case, other names Title-Case, no Priority. Applied in the
  client trace's GotConn, once ALPN is known; HTTP/2 is untouched. http:
  origins go through the impersonating client too (Go's transport wrote
  its own order to them). A Cloudflare site that negotiates HTTP/1.1
  refused Go's head (spokanecounty.gov). The TLS/H2 fingerprint checks never
  saw this: compare an HTTP/1.1 head by capturing it (a local
  http/1.1-only TLS server, direct Chrome vs `mitmprobe`).
- **Random testing** (owner, 2026-11-21): 3 random words → a search → a
  random result of a site not visited before (every comparison so far:
  `ts/e2e/tools/tried-sites.tsv`) → `live-compare.cjs` with
  `CLICKS=3`, several at once, on a nested display the owner watches (`Xephyr :97`).
  live-compare compares DOM structure (signatures outside ads), computed
  styles of elements both sides have once, pixels, errors (proxied URLs
  and quoted CSP read as direct), escapes; ads are masked on both sides
  (`tools/ads.cjs`), never in the escape count. Challenges and bot
  refusals go on `tools/human-assist.json` (`assist.cjs`) for a run with a
  person: `LIST=human-assist.json HANDOFF_WAIT=… node tools/xdrive.cjs`.
  Found and fixed by it: markup placed before or after an element parses
  in the parent's context (insertAdjacentHTML after a <script> was read
  as script text: flashtalking's creatives escaped); import() takes its
  specifier's string (a URL object escaped); text reaching a <script> or
  <style> by any route (a fragment's text: Marketo forms; append/prepend
  /replaceChildren/after strings; its text node's data, nodeValue,
  textContent, append/insert/delete/replaceData — goober's CSS-in-JS on
  bearsaver.com) is rewritten, each text node keeping its
  original for read-back; event handler attributes (`on` + a–z, any
  element: spec/Attrs.agda handler) are JS-rewritten as function bodies in
  both runtimes (birdies.com, guns.com; `event-handlers-vs-chromium`);
  http: and https: to one host
  use separate upstream clients (tls-client caches a transport per host
  and port, 443 by default); a script's text is judged by its kind when
  it is inserted, not when the text was set (spec/Html.agda scriptKind:
  consent managers — Cookiebot on jackery.com — write the text under
  `text/plain`, then flip the type; `script-type-flip-vs-chromium`); a
  script given a `data:` URL (`<script src>`, `import()`, markup the
  server sends or the page writes) is read as Chromium reads it
  (spec/DataUrl.agda, checked against Chromium: `data-url-vs-chromium`)
  and given a `data:` URL of its rewritten text — not a blob:, so a CSP
  admitting data: runs it as directly; a tab or newline inside the URL is
  outside the model (Chromium keeps them in some, drops them in others)
  and the URL is left as is (vegrecipesofindia.com's PWA module;
  `data-script-vs-chromium`, Go `TestE2E_DataScriptRewritten`); a worker
  made inside a worker gets the runtime as one made in a window (blob: /
  data: source rewritten; douyin.com's decoders; `nested-worker-vs-chromium`). The
  `Speculation-Rules` header's rule-set URLs are proxified
  (spec/Speculation.agda; chadscafe.com); a rule set's content (`urls`,
  `href_matches`, inline `<script type=speculationrules>`) is not
  rewritten yet. The Cache API keys entries by the proxified URL whichever
  form the page gives (string, URL, Request): `add`/`addAll` fetch through
  the proxy, lookups by the page's URL find them (`patches/cache-urls.ts`,
  windows and workers; toyotaofbellevue.com; `cache-api-vs-chromium`). CSS
  Typed OM text (`StylePropertyMap.set/append`, `CSSStyleValue.parse/
  parseAll`) is rewritten as a style's (`patches/typed-om.ts`; nfl.com;
  `typed-om-vs-chromium`); read back it holds the proxied URL, as `style`
  does. A gzip or deflate body that ends early (no trailer, cut mid-block)
  or fails its checksum is read as far as it inflated, as Chromium does
  (measured; hulu.com's ad tag got a 502); `deflate` (zlib or raw) is
  decoded at all (`server.lenientInflate`). A closed connection through the proxy
  (ERR_EMPTY_RESPONSE) is an upstream failure direct sees as its own net
  error: no such host, refused, the CORS check, ORB.
  Over plain HTTP the proxy keeps 6 connections, and ad-heavy pages
  behave unlike direct (techcrunch re-runs its user syncs, never fires
  load); judge those over TLS.
- **Rewritten bodies go to the browser compressed** (`proxy/compress.go`:
  zstd, else br, else gzip, by the browser's own Accept-Encoding; only a
  body a rewriter replaced — the rest streams as the origin sent it). They
  went out raw: cnn.com's 720 kB brotli document was 7.9 MB to the
  browser. The page reads the origin's Content-Encoding / Content-Length
  (Crn-H) and sizes (crnb). On localhost this does not show in load times;
  measure it by bytes, or over a throttled link. Server CPU on a large
  document: `CYRANO_PPROF` — CSS text that names no URL is not tokenized
  (as the client: a third of cnn.com's rewrite was `style` attributes);
  the CSS tokenizer still materializes its tokens (35 MB/s; the JS
  recognizer does 60). Still open: the document is rewritten whole before
  its first byte is sent (no streaming), so first paint trails direct.
- **Measuring pages with many requests (ads): serve the proxy over TLS.**
  Over plain HTTP the browser keeps 6 connections to the proxy for every
  site's traffic and queues the rest; over TLS it multiplexes on HTTP/2.
  Load races are lost that way too: TikTok's "a.init is not a function"
  (its Slardar SDK queued 1.5 s behind the app chunk that needs it) is
  gone over TLS, as direct.
  Second instance: `CYRANO_PUBLIC_URL=https://localhost:9443 CYRANO_PORT=9443
  CYRANO_HTTPS_ENABLED=true CYRANO_SSL_CERT=… CYRANO_SSL_KEY=… go/assets/cyrano
  --assets go/assets` (self-signed cert; Playwright `ignoreHTTPSErrors`).
  Header order is then Chrome's template, not the browser's own
  (`internal/headerorder` reads HTTP/1.x only).
- **Mixed content** is judged by the proxy as the browser would have
  (spec/MixedContent.agda; through the proxy every request is same-origin
  https to the browser): for an https page (its Crn-I, else its Referer)
  an http target that is not loopback is upgraded to https for an image,
  audio, video, and blocked (a network error, nothing sent) for anything
  else but a top-level navigation (a-hospital.com's http share.js ran;
  `mixed-content-vs-chromium`) — an image a srcset offers (an img's or a
  picture source's, imagesrcset) is blocked, as Chromium (its URL marked
  `!set` by both rewriters: Containment destImageSet). Gap: ws: from an
  https page.
- **Secure contexts** (spec/SecureContext.agda, `native/secure-context.ts`;
  `secure-context-vs-chromium`): every proxied document is served over
  https, so an http: page was a secure context (cookieStore, crypto.subtle,
  serviceWorker, WebGPU…). A document whose original URL is not
  trustworthy has Chromium's secure-only surface taken away at its first
  set_location (a measured table, checked against Chromium so a new
  version shows) and reads isSecureContext false. Gaps: workers; a frame
  judged by its own URL only.
- **HTTPS-Upgrades** as Chrome's (`proxy/https_upgrades.go`,
  spec/Upgrades.agda; `make chrome-check` — real Chrome, as Playwright's
  Chromium has the feature off): a main-frame http navigation to a unique
  name (a known ICANN TLD; not a.example) is sent to https first and falls back to http when https
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
  `CYRANO_PPROF=127.0.0.1:6060` serves pprof for such hunts. A chain the
  server sends short is completed from the certificate's AIA (CA Issuers),
  as Chrome does: the issuer is accepted only if it verifies to a system
  root, and the request is tried once more (`upstream/aia.go`; per session, like the clients).
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
  `nqueueMicrotask`, and the methods polyfills replace: `sStarts`,
  `sEnds`, `sIncludes`, `sPadStart`, `aIncludes` — mountaineers.org's
  Plone bundle made startsWith a RegExp and every cookie write threw),
  never the page-writable globals (the worker-script read uses the
  XMLHttpRequest saved at load, not a page's wrapper of it) —
  keep it so in new code (write
  `sStarts(s, p)`, not `s.startsWith(p)`). tldts (the public-suffix list)
  is routed to them by a Vite transform (`vite.config.ts`); acorn calls
  none of them. Still live: the other Array/String/RegExp methods and
  iteration (for…of, spread). Bisecting such a site:
  `CYRANO_DEBUG_JS_OFF` (rules), `CYRANO_DEBUG_NO_JS=<url re>`,
  `CYRANO_DEBUG_R5="[!]<url re> <lo> <hi> …; …"` (R5 by offset), and
  V8 coverage / pause-on-caught-exceptions over CDP, direct vs proxied.
- **Browser-level requests** the page cannot intercept escape the proxy
  (FedCM `navigator.credentials.get`, seen on theguardian.com). FedCM is
  refused (`patches/fedcm.ts`), and so is a PaymentRequest for a URL-based
  method (spec/Payment.agda, `patches/payment-request.ts`: Chrome fetches
  the method's manifest and app at construction — Stripe's Google Pay on
  kenhub.com fetched gstatic): answered as a method without an app.
- **Not wrapped yet**: `AsyncFunction`/`GeneratorFunction` constructors;
  an SVG element's `href.baseVal` (SVGAnimatedString; setAttribute /
  setAttributeNS are rewritten). URL-bearing attributes are one table in
  both runtimes (spec/Attrs.agda, checked against what Chromium fetches):
  `ping` / `attributionsrc` are URL lists (and window.open's
  attributionsrc features: spec/Features.agda); `currentSrc` (img, media)
  reads unwrapped (`current-src-vs-chromium`); `cite` / `longdesc` / `lowsrc` /
  `codebase` stay as written, their getters unwrapped; an SVG presentation
  attribute that takes a <url> (clip-path, fill, mask, …) is CSS, rewritten
  as a style attribute (Attrs.agda cssValue: Google Charts' clip-path naming
  the page was, proxied, an external document fetched outside the proxy). Markup is tokenized
  as the browser does (spec/HtmlTok.agda, checked against Chromium): raw
  text only for HTML elements (`<svg><style>` holds markup), the
  namespace from a simplified tree construction; Go feeds that back to
  x/net/html (`htmlrewrite/stream.go`), the client ports it
  (`patches/html-tokens.ts`). The client edits markup a page writes where
  it stands, at token spans (`patches/html-rewriter.ts`; no template parse
  and re-serialization: a `document.write` chunk that opens an element
  leaves it open; `tests/native/written-markup-vs-chromium`); the
  bootstrap goes where the server's goes (after the first `<head>` /
  `<body>`, else before the first other element) for documents, srcdoc
  and writes into empty frames. A `<noscript>`'s content is kept as
  written (text with scripting on). A tag, comment or script split across
  `document.write` calls is kept back until it is complete (the next
  write, the next microtask, or close()). The form element pointer is
  modelled (a `<form>` inside an open form makes no element: HtmlTok.agda
  formIgnored, both tokenizers). Open: a page's parse inside
  `<select>` or after `<frameset>` is not modelled. The
  Navigation API is wrapped (`patches/navigation.ts`; Shopify). Open from
  random-site testing (2026-11-18): `location` / `top` / `parent` read by
  destructuring is handled where the pattern has a source (R14:
  declarations, assignments — Transcend's consent manager), not in a
  parameter's or a nested pattern; a document under which no script of its own can run gets no runtime
  (spec/Csp.agda noScriptsRun; frames judge it by its proxified URL).
  A CSP `sandbox` directive without allow-scripts counts (no runtime).
  An iframe whose `sandbox` attribute lacks allow-scripts gets none
  either: its URL is marked `!inert` in place of `!frame` by the document
  holding it (spec/Frames.agda frameDest, inertFrame; both runtimes), and
  what that frame then navigates itself to inherits it. Open: a sandbox
  attribute changed after the frame was given its URL. A parent
  navigating a child frame the browser holds cross-origin (sandboxed,
  opaque) goes through a location view that can be set, not read
  (`native/cross-origin.ts` opaqueLocationView); reading another member
  of it throws the runtime's SecurityError, not the browser's own object.
  `fetchLater` keeps its quota per original origin (spec/FetchLater.agda)
  and defers what the
  proxy makes the native refuse (`patches/fetch-later.ts`; tumblr) — the
  requests it defers go out with keepalive (64 KiB in flight at unload). DOM insertion by any
  method gives inserted empty frames the runtime (`dynamic-iframe.ts`); and
  the URL fix-up before insert (spec/Attrs.agda's table, originals recorded)
  runs for every insertion method too.
- **Site regression list**: `ts/e2e/tools/regression-sites.json` — every
  site a fix was made for and what was fixed; `tools/site-regress.cjs`
  compares the "auto" ones direct vs proxied and lists the "chrome" ones
  (bot-protected: refused in an automated browser on both sides) for a
  check in real Chrome. Run it before a commit that touches rewriting,
  against the build to be committed (`PROXY=https://localhost:9443`). The
  "chrome" ones run by themselves in `tools/xdrive.cjs`: a stock Chrome
  on a hidden display, started as a person starts it and driven through
  X input (xdotool) — no DevTools protocol, which is what those sites
  refuse; read from outside by window title and screenshot
  (`DISPLAY=:98 PROXY=… node tools/xdrive.cjs`; a site's steps are its
  "x" in the list). It does not answer a challenge or a sign-in form: it
  hands over to `XDRIVE_ON_CHALLENGE` / `XDRIVE_ON_LOGIN` (the owner's
  commands), and `PROFILE=<dir>` keeps the session they leave. To watch
  or take over by hand, run it on a nested display in a window:
  `Xephyr :97 -screen 1600x1000 &` then `DISPLAY=:97 HANDOFF_WAIT=120 …`. A
  site-found bug also gets a distilled local test where it can be played
  without the site (`tests/native/*-vs-chromium`); add the site to the
  list in the same commit. The owner's instance (9081) runs a snapshot of
  a committed, gated build from its own copy of the assets — a client
  rebuild overwrites `go/assets/client/rewriter.js`, which a server
  running from `go/assets` serves at once; experiments go on other ports.
- Live check: `ts/e2e/tools/live-compare.cjs` (direct vs proxied, same
  browser; `PROXY=` picks the instance). Last run clean: example.com, news.ycombinator.com,
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
