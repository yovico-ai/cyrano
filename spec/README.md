# spec/ — URL containment, in Agda

**Why this exists:** to prove cyrano's fundamental principle
(REQUIREMENTS.md): the page's own JS cannot tell it runs through the
proxy. The central theorem is that what page code is shown equals what
the browser shows for the original. Every other rule here serves that
theorem. Byte-compatibility between the Go and TS runtimes follows from
it, because both are checked against the same oracle.

The rules both runtimes must follow byte for byte, written once:

| Module | Decides | Implemented by |
|---|---|---|
| `Scheme.agda` | the proxified schemes (http, https, ws, wss) | `PROXIFIABLE_SCHEMES` in both runtimes |
| `Url.agda` | how a URL string is read (WHATWG basic URL parser, Node 22 flavour) | `go/src/internal/urlrewrite/whatwg.go`; the browser's `URL` in TS |
| `Containment.agda` | rewrite (proxify, remap, keep) and unwrap; the marks a proxified URL carries, `<scheme>[!<policy>][!js\|!css]` (proved: unwrap ignores them, the proxy reads them back) | `urlrewrite.Rewrite`/`Unwrap`; `rewriteUrl`/`unwrapProxiedUrl` in `ts/client/src/url/containment.ts` |
| `Srcset.agda` | where each srcset candidate's URL starts and ends | `htmlrewrite/srcset.go`; `ts/client/src/patches/srcset.ts` |
| `Referrer.agda` | Referer, Origin and Sec-Fetch-Site as a direct browser sends them (Referrer Policy, Fetch, Fetch Metadata); a RequestInit's referrer as Chromium reads it (`initReferrer`; the runtime hands it over proxified) | `urlrewrite/referrer.go`, applied in `proxy/fetch_headers.go`; `ts/client/src/patches/fetch.ts` (`initReferrer`) |
| `Cookies.agda` | reading Set-Cookie, storing, choosing cookies for a URL, SameSite, and the wire form of a cookie in the browser's jar (RFC 6265bis) | `urlrewrite/cookies.go`, `proxy/cookies.go`; `ts/client/src/cookies/rfc.ts` |
| `Fetch.agda` | a page's cross-origin fetch/XHR: whether it carries credentials (and so cookies), the CORS check of its response, the response headers a script sees (Access-Control-Expose-Headers) | `proxy/cors.go`, `proxy/cookies.go`; `ts/client/src/patches/cors.ts` (fetch, XHR) |
| `Csp.agda` | reading a Content-Security-Policy (CSP3 §2.2), translating it for the proxy (header and `<meta>`), the bootstrap's nonce and inline-or-external choice, and framing: frame-ancestors source matching and X-Frame-Options | `urlrewrite/csp.go`, `proxy/frame_ancestors.go`; `ts/client/src/patches/html-rewriter.ts` (`<meta>`) |
| `Css.agda` | the URLs in CSS text (CSS Syntax 3 tokenization: url tokens, `url("…")`, `@import`, `image-set()`) and the rewritten CSS | `go/src/internal/cssrewrite`; `ts/client/src/css/rewriter.ts` |
| `Html.agda` | what a `<script>` is (classic, module, import map, speculation rules, data block) and the document base URL (the first `<base href>`) | `htmlrewrite.ScriptKindFor`, `urlrewrite.DocumentBase`; `ts/client/src/patches/script-kind.ts` |
| `ImportMap.agda` | import maps edited as text (URL-like specifiers, addresses, scope prefixes proxified; integrity emptied), the JSON they are read as, and HTML's URL-like specifier rule | `urlrewrite/importmap.go`, `IsURLLikeSpecifier`; `ts/client/src/url/import-map.ts`, `isUrlLikeSpecifier` |
| `Attrs.agda` | which (namespace, element, attribute) holds a URL, a URL list (ping, attributionsrc), a srcset, or a reflected-only URL (cite, longdesc); URL lists rewritten token by token | `htmlrewrite/attrs.go` (`URLAttrKind`, `RewriteURLList`, SVG namespace tracking); `ts/client/src/patches/url-attribute-map.ts` |
| `HtmlTok.agda` | HTML tokenization (§13.2.5's boundary-deciding states, raw text only for HTML elements) and the namespace of each start tag (svg/math foreign content, integration points, breakouts); where the bootstrap goes; the attribute spans the client edits markup at | `htmlrewrite/stream.go` (x/net/html told raw text and CDATA from the tree), `nsTracker`; `ts/client/src/patches/html-tokens.ts`, `html-rewriter.ts` |
| `Link.agda` | the Link response header (RFC 8288) as Chromium reads it, and as the proxy rewrites it: targets proxified, imagesrcset, integrity taken out, crossorigin as the `<link>`'s | `urlrewrite.RewriteLinkHeader` |
| `Refresh.agda` | a Refresh header and `<meta http-equiv=refresh>` as Chromium reads them (it departs from HTML's steps), and their URL rewritten | `urlrewrite.RewriteRefresh`; `ts/client/src/url/refresh.ts` (written markup, `setAttribute`) |
| `WsOrigin.agda` | the page origin a proxied WebSocket URL carries (a last query parameter), and the server's reading of it | `urlrewrite.SplitWSOrigin`; `ts/client/src/patches/websocket.ts` |
| `Carry.agda` | what the proxy carries to the runtime: `Crn-H` (the origin's header values, byte for byte) and the Server-Timing `crnb` sizes | `proxy.CrnHValue`; `patches/response-headers.ts`, `install.ts` (`crnbSizes`) |
| `Query.agda` | query values unproxified on the way upstream (form decoding, Go's QueryEscape) | `urlrewrite.UnproxyQueryValues` |
| `Sf.agda` | RFC 8941 lists and dictionaries, as the headers below need them | `urlrewrite/sf.go` |
| `Permissions.agda` | Permissions-Policy as Chromium reads it (allowlists, Feature-Policy words for strings, a header that does not parse ignored whole) and the translation a proxied document is given | `urlrewrite.TranslatePermissionsPolicy` |
| `Allow.agda` | an iframe's allow attribute as Chromium reads it (case-sensitive names, keywords, origins without userinfo), the frame's view, and the translation (origins written 'src'); the Feature-Policy header (same words, no *. patterns, Permissions-Policy first) and its translation (origins written 'self') | `urlrewrite.RewriteAllow`, `RewriteFeaturePolicy`; TS `url/allow.ts` |
| `Storage.agda` | Sec-Fetch-Storage-Access: third-party by the chain of sites (a cross-site frame's requests to the top-level site are), credentialed, trustworthy targets only | `proxy/storage_access.go` |
| `Metadata.agda` | the request headers sent only to potentially trustworthy targets (Sec-Fetch-*, client hints): none to an http name | `urlrewrite.SecureOnlyHeader`, `upstream.copyHeaders` |
| `Messaging.agda` | postMessage's targetOrigin: delivered, dropped, or a SyntaxError (opaque origins throw; file:/ftp: drop), compared as the windows' original origins | TS `messaging/target-origin.ts` (`delivery`) |
| `Selectors.agda` | CSS attribute selectors on URL attributes widened to the proxied values (marked js/css too; *= and $= across the scheme) | TS `patches/selectors.ts` (`widenSelector`) |
| `Hints.agda` | client hints: Accept-CH as Chromium reads it (an RFC 8941 list of tokens; invalid counts for nothing), how a set is replaced, which hints go where, and the Sec-CH-UA a Chrome of a version sends | `proxy/client_hints.go`; `upstream.SecChUa` |
| `Upgrades.agda` | HTTPS-Upgrades: which navigations Chrome tries over https (unique names: a known ICANN TLD), the scheme swap in a marked URL, the per-host pending / fallback state | `proxy/https_upgrades.go` |
| `Disposition.agda` | what the proxy rewrites a response's body as — JavaScript, CSS, HTML or nothing — by its URL's mark, else Sec-Fetch-Dest, never by changing the Content-Type; a document's MIME type as Chromium reads it (a comma list, the last type with "/") and its HTML sniff | `server/bodyrewriter.go` (`responseKind`, `takenMime`, `sniffHTMLBytes`) |
| `Oracle.agda` | wire format only (one request line → one JSON line) | — |
| `Main.agda` | the IO loop (spec-oracle skill's file, unchanged) | — |

Owner decisions are dated in each module's header comment, and so are
the readings still awaiting confirmation ("Ours, to confirm"). Edit the
spec first, then the runtimes.

## Proved, not tested

In `Containment.agda`:

- **The law, on parsed URLs** (`unwrap-proxify`): unwrapping a proxified
  URL gives back exactly the original. Its one hypothesis, `canonical`,
  says a parsed authority reads back as itself. That's true of everything
  the parser produces, but it isn't proved yet; the oracle properties
  check it. Proving it is the next step.
- **Reading back undoes escaping, for every string** (`decode-escape`).
  Every `%` of the target is written `%25` in a proxified path, so the
  path is always valid percent-encoding, and decoding returns the
  target's text exactly.
- A proxified URL is never wrapped again; a URL that is kept comes back
  byte for byte.
- Adding a constructor to `Scheme` or `Kind` fails type checking until
  every rule handles it.

The law is about parsed values. The step from a proxified URL as *text*
back to its parsed form (that the browser's parser reads what proxify
wrote) is tested, not proved. That gap is where both holes found so far
sat: `.`/`..` hosts collapsing as dot segments, and `{`/`}` in hosts
being percent-encoded by the path parser.

## Tested against the oracle

`spec/build/Main` is the compiled spec. The Go (`internal/specoracle`,
rapid) and TS (`ts/client/tests/spec`, fast-check) conformance tests
generate inputs, ask the oracle, and compare. **The reference browser is Chromium**, not Node and not the written
standards, where they differ (`^` and `|` in paths, a space or `*` in a
host, IDNA, an invalid last `Max-Age`): a URL or cookie the user's browser
accepts and cyrano does not would escape containment. `make browser-check`
runs the spec against real Chromium (URLs: `spec-vs-chromium`, cookies:
`cookies-vs-chromium`, CORS: `fetch-vs-chromium`, framing:
`framing-vs-chromium`, CSS URLs: `css-vs-chromium`, script kinds and the base URL: `html-vs-chromium`, the JSON import maps are read as: `json-vs-chromium`; what Chromium fetches from and which IDL properties resolve URLs: `attrs-vs-chromium`; which start tags make elements in which namespace, and that the bootstrap placed by the spec runs first and leaves the document as direct: `html-tok-vs-chromium`; what a Link header makes Chromium fetch, direct and rewritten: `link-vs-chromium`; what a refresh does: `refresh-vs-chromium`; a carried header and crnb metric as Chromium shows them: `carry-vs-chromium`; which client hints Chromium sends, and its Sec-CH-UA: `hints-vs-chromium`; what document.featurePolicy says under a Permissions-Policy and its translation: `permissions-vs-chromium`; what a frame's featurePolicy says under its allow attribute and its translation: `allow-vs-chromium`; Sec-Fetch-Storage-Access over random frame trees: `storage-access-vs-chromium`; which headers reach trustworthy and http targets: `metadata-vs-chromium`; which documents Chromium renders as markup, by Content-Type and sniff: `sniff-vs-chromium`; which responses set the referrer policy of their own requests (documents, workers, stylesheets): `policy-contexts-vs-chromium`; postMessage delivery by targetOrigin: `post-message-vs-chromium`; featurePolicy under Feature-Policy (with Permissions-Policy) and its translation: `feature-policy-vs-chromium`; widened selectors on proxied elements against the page's on its own: `selectors-vs-chromium`; which navigations real Chrome upgrades to https, and that a fallback sticks: `upgrades-vs-chrome` (`make chrome-check`: Google Chrome on a display); and for the CSP translation, which is cyrano's own
rule, the page-cannot-tell property: what loads directly loads proxied,
`csp-vs-chromium`) and the runtime's native surface, `postMessage` and
workers in it (`tests/native`). IDNA, outside the spec, is checked by a
fixture recorded from Chromium (`urlrewrite/fixtures/idna.json`).

The main properties are:

- **the page cannot tell**: `unwrap(rewrite(raw))` equals `direct(raw)`.
  It's checked against the spec in both runtimes, and in TS also against
  Node's real URL parser, with no oracle involved
  (`page-cannot-tell.test.ts`);
- **the spec is the browser**: the spec's `direct` equals Node's
  `new URL(raw, base).href`;
- **the upstream cannot tell**: the request the server forwards equals
  what the browser would send directly (Go,
  `TestSpecConformance_UpstreamCannotTell`). An answer of `silent`
(IPv6, IDNA, percent-encoded or unusual IPv4 hosts) means the spec does
not decide that input, and it is skipped.

```bash
# from the repo root; builds the oracle and runs both suites with it required
env -u LD_LIBRARY_PATH nix develop --command make spec-check
```

Plain `go test ./...` and `npx vitest run` use `spec/build/Main` when it
exists (or `CYRANO_ORACLE`), and skip the conformance tests with a note
when it is missing or older than any `spec/*.agda` — so they still work
without Nix, and a stale oracle never passes silently.

## Not yet specified (the work list)

Every hand-written parser or decision rule over URLs, headers, HTML/CSS
text or another wire format is meant to be specified here and checked in
both runtimes (owner, 2026-11-18: "Agda completeness … super important for
upkeep"). What remains, by priority (inventory of 2026-11-18; remove an
entry when its module lands):


Medium: crossorigin / integrity / sandbox rules;
fetchLater's quota formula (TS); the storage partition key (TS: by
origin, browsers by site); blob/data worker sources; a frame's pending
origin; error-stack URL extraction; compression-dictionary removal;
Chrome's Priority table; the header-order recorder (HTTP/1.1 framing);
Referer-based routing.

Low: challenge heuristics, debug-variable parsing, boot/worker-init query
JSON, base64url.
