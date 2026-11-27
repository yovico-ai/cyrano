# Regression run — 2026-11-26

Build under test: **1df3d60** (TLS dev instance, 9445). Every page compared
direct vs proxied with `tools/live-compare.cjs`. The baseline is each page's
first walk in `tools/tried-sites.tsv` (2026-11-18 … 2026-11-25).

## What ran

| | |
|---|---|
| Pages walked (every earlier page that loaded direct) | 3,734 |
| Pages with a result | 3,726 (8 harness timeouts / exits) |
| Judged in real Chrome (headed, `:97`) | 2,708 (the first 1,205 ran headless; the 190 headless refused on were replayed headed) |
| Refused on both sides (not judgeable) | 4 |
| site-regress batches | 52 (headless) and 53 (headed — the new baseline) |

Nothing was fixed or committed during the run. Instance 9081 was down for a
few minutes when memory ran out on the machine (restarted on 1df3d60).

## Proxy issues

### Regressions against the first walk

**Escapes that were not there before (8 pages, + thehill in site-regress):**

| Page | Escaped to | Run |
|---|---|---|
| thehill.com/country/us/ (site-regress) | 24 requests: ad.doubleclick.net, s0.2mdn.net, pagead2.googlesyndication.com, static.criteo.net | headed |
| modland.net | cdn.doubleverify.com, ep2.adtrafficquality.google, pagead2.googlesyndication.com — with `$rewriter is not defined` on the same page | headed |
| wordhint.net | cdnjs.cloudflare.com, pagead2 / tpc.googlesyndication.com | headed |
| percentagecalculator.net | pagead2.googlesyndication.com (`gen_204`) | headed |
| local3news.com | ib.adnxs.com/async_usersync | headed |
| yahoo.com (article) | static.admaster.cc cookieSync.html, static.yieldmo.com | headed |
| freeasteroids.org | turbo.freevideogames.org | headed |
| campus.edu | Mux video: the HLS manifest and chunks (fastly / cfcdn.mux.com) | headless |
| lung.org | cdn.userway.org | headless |
| immi-usa.com | www.immi-usa.com (its own origin) | headless |

Most are the Google ad stack and ad-sync frames. The first walks were mostly
headless and were never served these ads, so part of this may be "newly
exercised" rather than "newly broken"; an escape is a must-fix either way.

**`$rewriter is not defined` (5 pages):** nordstrom.com, nordstromrack.com,
geico.app.link, modland.net, my.adp.com — rewritten code ran in a realm
without the runtime. On modland that frame is also the one that escaped.

**Proxied page never reaches `load` in 45 s while direct does (86 pages):**
truckingboards, wunderground, yahoo (article), ipanda, delish, kerrang,
stringfurniture, hulu, etsy, 2gis, techcrunch, barrons, tandfonline,
androidpolice, caranddriver … They loaded on the first walk (headless). To
be confirmed with a second run each: some pages never finish loading
directly either (owner), and headed Chrome is served the full ad stacks.

**502 through the proxy only (6):** collegetransitions.com, visualfractions.com,
meatartisan.com, resources.mouser.com, halespropertymanagement.com,
pet-voyage.ru (and canvas.instructure.com's `.json`, trumpery.com earlier).

### Other proxy-only differences (not regressions, or not yet known to be)

- Redirect loop through the proxy only (`ERR_TOO_MANY_REDIRECTS`): 9 sites.
- Cloudflare's `fetch("data:,")` probe refused by `connect-src` proxied only: 11 sites.
- Trusted Types refuses `new Worker(trustedScriptURL)` (open queue entry): waze.com, outlook.com.
- Recurring proxied-only page errors: Google Identity Services after the
  FedCM refusal (`reading 'P'`, GSI_LOGGER), Facebook `ErrorUtils caught an
  error`, Alia launcher `Failed to fetch` (open birdies entry), Adobe Launch
  `identityProvider … rawData` (nfl.com, colts.com, chiefs.com), `$ is not
  defined`, `recaptcha is not defined` (californiacasa), a sandboxed
  `about:blank`'s script blocked (lawnlove), stylesheets refused for their
  MIME type (japantrendshop, king5's Google Fonts).
- justice.gov: the Akamai sensor script is fetched twice proxied (the first,
  the preload scanner's, aborted at ~57 ms).
- voltage.co.jp still never loads proxied (open entry).
- crazygames: the SecurityError message prefix names another origin (known).

## Cloudflare — what was found (and corrected)

The run listed 17 Cloudflare pages "refused through the proxy only" (403).
**That was the harness, not a regression.** Real Chrome reaches these zones
over HTTP/3 and gets no challenge; the proxy speaks HTTP/2 upstream and gets
Cloudflare's managed challenge first, which **solves itself through the
proxy** as it does for a direct Chrome over HTTP/2 (measured: findagrave 6 s,
napaonline 10 s, codepen 23 s proxied; 4 / 14 / 9 s direct with QUIC off).
live-compare read the first response's status and waited ~12 s at most.

Built and not committed: HTTP/3 upstream as Chrome chooses it (spec
`Alpn.agda`; `upstream/alpn.go`, `h3.go`; `dnscache/https.go` HTTPS records;
the connection raced, never the request). Through it 15 of the 17 zones load
with no challenge at all. Left: fivebelow (our QUIC stack rejects the server's
RSA handshake signature — deterministic), yellowpages (real Chrome uses h2
there; Cloudflare's h2 verdict on our client varies). Gates passed on it:
go vet, go test, e2e, spec-check; not yet browser-check and site-regress.

## Harness issues (the regression test reported something that was not a difference, or could not judge)

1. **Headless by default.** live-compare launched Playwright's headless shell
   unless `HEADED=1`: `HeadlessChrome` in the UA, `navigator.webdriver` true,
   no plugins — bot managers refused it on both sides (11% of pages, against
   1% headed), and ad stacks were not served, so ad-path escapes were never
   exercised. Every site-regress gate before today ran this way. **Fixed:**
   headed real Chrome on `:97` is the default (exits 2 if the display is
   down); `HEADLESS=1` only on purpose.
2. **Challenges judged by their first response.** A managed challenge that
   solves itself in 15–25 s was counted as a refusal (above). Wait for the
   challenge to resolve on both sides, then judge the final page.
3. **Network-error wording counted as a difference.** The proxy's refusals
   (ORB, CORS, CSP) read `ERR_HTTP2_PROTOCOL_ERROR` where direct reads
   `ERR_BLOCKED_BY_ORB`; the page sees a network error either way. Pair the
   failed request with direct's by original URL.
4. **The runtime's own requests counted** (its read of a revoked blob: URL).
5. **One run per page.** Ads, A/B buckets and challenges vary; differences
   should be confirmed by a second run (DOM differs ≥5 elements on 291 of
   969 headed pages at one checkpoint — mostly ad and consent churn).
6. **`Failed to load resource: status N` carries no URL**, so a proxied-only
   4xx/5xx cannot be paired with direct.
7. **Page console lines compared as errors** — some real (Adobe Launch),
   some timing (game logs); uncaught exceptions are the page-independent signal.
8. **`ERR_NETWORK_CHANGED`**: the machine's interfaces change during a run
   (container networks); such a run should be void and repeated.
9. **Pages that never reach `load` on either side** are compared mid-load.
10. **No interaction** (hover, clicks off) — hover-prefetch escapes not exercised.
12. **Certificate errors ignored on the direct side** (`ignoreHTTPSErrors`):
    an expired certificate (mouser, pet-voyage) reads as a proxy-only 502.
13. **No per-page watchdog**: a page whose main thread spins (ginifab's
    hang, above) holds live-compare — and a whole site-regress batch —
    forever. A hung page should be a result ("hung"), not a stall.
11. **The runner marked pages done while the display was down** (113 pages,
    un-marked and rerun). Fixed: it stops instead.

## Recheck (every candidate twice, same build) and fixes — evening

| Candidate | Recheck | Verdict |
|---|---|---|
| freeasteroids escape | 7 requests, both runs | **Fixed** (below) |
| immi-usa escape | 1 request, both runs (build before the fix) | **Fixed**: none in 2 runs after |
| `$rewriter is not defined` (nordstrom, nordstromrack, adp, geico) | both runs (rack: one) | **Fixed** (below): none in 6 runs after |
| Other escapes (campus, wordhint, lung, local3news, modland, percentagecalculator) | none in either run | Not reproduced (ad stacks vary) |
| talkaboutpopmusic | ad-stack escape in one run of 3 | Likely the pending-frame hole (Google ad frames); none since |
| 86 load timeouts | 8 proxied-only in both runs | 4 reach `load` on rerun; chefaa (60 s direct / 64 s proxied), efx (48 / 66), verizon speedtest (53 / 33) are slow on both sides, 24garten never loads on either: **harness** (a 45 s cutoff on pages that take ~60 s directly) |
| Intermittent 502s | one run of two each | **Fixed** in part (HTTP/3 QPACK, below); mouser: the expired certificate (harness 12); lknpd.nalog.ru: our lookups (with hedge) gave no answer in 10 s on a cold name (glibc 8 s) — not reproduced since |

**Fixed:**

1. **A frame on its way to a proxied URL had no runtime** until its document
   committed (spec/Frames.agda `frameRuntime`). Page code writing into it
   meanwhile ran natively there: Ruffle's `<script src>` on freeasteroids
   loaded from its origin. The frame now gets its creator's runtime at once,
   and its own document takes the window over when it arrives: the window
   and realm are kept, its config replaces the creator's in place, and
   per-document installs (the originals observer, named-frame listeners,
   the cookie snapshot) are redone (`bootstrap.ts` adoptDocument). Tests:
   `pending-frame-vs-chromium` (fails on 1df3d60; also fails with adoption
   off, by the referrer policy), `frame-runtime-conformance`.
2. **A parser-inserted frame got the runtime only at its `load` event**:
   its `javascript:` URL ran before, and the rules' `$rewriter` calls in
   it threw (adp's and geico's `javascript:window.parent.parent[k](window)`
   in a frame written into an empty frame). Now it is given it as soon as
   the observer sees it. Test: `js-url-frame-vs-chromium` (fails before).
2b. **Found by site-regress on fix 1, before it was committed: ginifab.com
   hung** (a renderer at 100% for 25 min, the batch stalled). The ad frame
   that adopted the page's runtime made Flashtalking's richload frame, which
   was given the copy of the runtime the ad frame's own bootstrap had loaded;
   the two copies both rewrote its `document.write`, against the ad frame's
   base, not the `<base>` it wrote — the stylesheet came from the wrong
   folder (404), and the creative's copy-fitting `while` loop never ended. A
   window now passes on the copy it runs. Test: `adopted-frame-copy-vs-chromium`
   (fails without the fix; passes on 1df3d60, which had no adoption).
3. **HTTP/3 upstream (uncommitted work): QPACK.** Chrome's SETTINGS offer a
   64 KiB dynamic table that our decoder lacks; Google and Cloudflare front
   ends used it and 36 of 848 responses failed (`Required Insert Count`),
   502 to the page — geico's canvaskit import, fonts.gstatic.com,
   googletagmanager. Now those settings are 0 (Chrome's order kept): none
   in 499 after. Test: `TestH3SettingsNoDynamicTable`.

## Queue

22 entries marked fixed and 7 partly fixed (with commit and test); 6 closed
as not legitimate or fixed elsewhere, each with a note; prezi closed (fixed).
