# API Coverage Audit

Coverage of browser APIs that carry or expose URLs, execute code dynamically,
or cross frame boundaries — the three categories a clientless VPN proxy must
intercept.

**Columns**

| Column | Meaning |
|---|---|
| **Server (Go)** | What the static HTML/JS/CSS rewriter does at response time |
| **Client (TS)** | What the runtime patching layer does in the browser |
| **Status** | ✓ covered end-to-end · ~ partial · ✗ not handled · 🚫 intentionally blocked |

---

## 1. Window Navigation / Frame References

These are the APIs that expose or mutate "which page are we on / which
window are we in." Every VPN proxy lives or dies on getting these right.

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `location` (bare read) | `wrap_get_location(location)` AST wrap | `wrap_get_location` → `WrappedLocation` | ✓ | Returns virtual URL |
| `location = url` (bare assignment) | `wrap_set_location(location, fn).value = url` AST wrap | setter proxifies URL | ✓ | |
| `obj.location` (member read) | `wrap_location({obj}).location` AST wrap | `wrap_location` → `WrappedLocation` or `wrapForeignLoc` | ✓ | Non-targetWindow gets `wrapForeignLoc` so cross-frame `.href = url` is also proxified |
| `obj.location = url` (member assign) | `wrap_set_location(obj.location, fn).value = url` AST wrap | setter proxifies URL | ✓ | |
| `obj.location.href = url` | via `wrap_location` member read, then `wrapForeignLoc.href` setter | same | ✓ | Fixed this session |
| `window.location.assign(url)` | `wrap_get_location` | `WrappedLocation.assign` proxifies | ✓ | |
| `window.location.replace(url)` | same | `WrappedLocation.replace` proxifies | ✓ | |
| `window.location.reload()` | — | passes through to real location | ✓ | No URL involved |
| `location.href` (read) | — | `WrappedLocation.href` returns virtual URL | ✓ | |
| `location.origin/host/hostname/port/…` (read) | — | `WrappedLocation.*` returns virtual values | ✓ | |
| `top` (bare read) | `wrap_get_top_window(top)` AST wrap | identity passthrough | ~ | Value is the real `top` window; useful only for same-origin comparisons |
| `obj.top` (member read) | `wrap_top_window({obj}).top` AST wrap | returns `obj.top` for window-like; `obj` otherwise | ~ | Same passthrough — no URL in the value |
| `parent` (bare read) | `wrap_get_parent_window(parent)` AST wrap | identity passthrough | ~ | Same as `top` |
| `obj.parent` (member read) | `wrap_parent_window({obj}).parent` AST wrap | returns `obj.parent` for window-like; `obj` otherwise | ~ | |
| `window.frames[i]` | — | — | ✗ | Cross-frame access via frames array; rare in practice |
| `window.opener` | — | — | ✗ | Reference to window that opened this one; low risk |
| `window.open(url)` | — | — | ✗ | URL arg not proxified at runtime; static JS AST only wraps known patterns |
| `window.name` | — | — | ✗ | Sometimes used for cross-frame data passing; not URL-bearing |

---

## 2. Cross-Frame Communication

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `obj.postMessage(data, targetOrigin)` | `wrap_postMessage({obj}).postMessage(…)` AST wrap | `wrapPostMessage` translates `targetOrigin` from upstream origin to proxy origin for same-origin windows | ✓ | Prevents SecurityError when proxied iframes post to each other |
| `Window.prototype.postMessage` (unmodified scripts) | — | Prototype patch translates `targetOrigin` | ✓ | Covers scripts not processed by AST rewriter |
| `MessageEvent.origin` (in listeners) | — | `addEventListener('message')` wrap spoofs `event.origin` with upstream origin | ✓ | So `event.origin === 'https://example.com'` guards work |
| `postMessage` data payload URL rewriting | — | — | ✗ | **TODO** — URLs embedded in `event.data` objects/strings are not rewritten; recipient sees proxy-origin URLs |
| `BroadcastChannel.postMessage` | `wrap_postMessage` fires on `.postMessage` member | passthrough (non-Window `postMessage`) | ~ | targetOrigin not applicable; data payload gap same as above |

---

## 3. JavaScript Dynamic Execution

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `eval(src)` | `eval($rewriter.wrap_eval_arg(eval, src))` AST wrap | `wrap_eval_arg` runs JS source through AST rewriter | ✓ | Preserves direct-eval scope semantics |
| `eval` (as rvalue, e.g. `var f = eval`) | `wrap_eval(eval)` AST wrap | `wrap_eval` returns a wrapper that rewrites source before forwarding | ~ | Loses direct-eval scope (indirect call) — documented limitation |
| `obj.eval(src)` | `wrap_eval_memexp(obj).eval(src)` AST wrap | `wrapEvalMemexp` returns a Proxy whose `.eval` rewrites source | ✓ | |
| `new Function(...body)` | — | `Function` constructor patched to run body through JS rewriter | ✓ | Handles GTM and other runtime code-generation patterns |
| `import(specifier)` | `wrap_import_arg(specifier)` AST wrap; static string literals are resolved+proxified inline | `wrap_import_arg` proxifies at runtime | ✓ | |
| `import.meta.url` | Replaced with a string literal (the original script URL) at rewrite time | — | ✓ | Fixes ES module chunk loading relative to `import.meta.url` |
| `import … from "url"` (static) | Resolved and proxified inline in the rewritten source | — | ✓ | |
| `export … from "url"` (static) | Same as static import | — | ✓ | |
| `<script>` inline content | Passed through JS AST rewriter | — | ✓ | |
| Inline event handlers (`onclick="…"`) | **Known, not rewritten** (Phase 4 TODO) | — | ✗ | `htmlEventAttrs` list exists in config.go but the JS rewriter is not applied to them |
| `setTimeout(stringArg)` / `setInterval(stringArg)` | — | — | ✗ | When called with a string (legacy code-as-string), that string is not run through the rewriter |

---

## 4. Workers

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `new Worker(url)` | `wrap_worker_url(url)` AST wrap | `wrap_worker_url` proxifies URL | ✓ | |
| `new SharedWorker(url)` | `wrap_worker_url(url)` AST wrap | `wrap_worker_url` proxifies URL | ✓ | |
| Worker script body (Sec-Fetch-Dest: worker) | Worker shim prepended; `Cache-Control: no-store` | — | ✓ | Shim defines `$rewriter` stub + patches `importScripts`/`fetch`/XHR |
| `importScripts(url)` inside worker | — (shim handles it) | — | ✓ | Shim patches `self.importScripts` |
| `fetch(url)` inside worker | — | — | ✓ | Shim patches `self.fetch` |
| `XMLHttpRequest` inside worker | — | — | ✓ | Shim patches `XMLHttpRequest.prototype.open` |
| `new Worker(url)` inside worker (nested) | — | Worker shim `wrap_worker_url` | ✓ | Shim's `_p()` proxifies; already-proxified check prevents double-encoding |
| Worker `$rewriter.wrap_location` | — | Worker shim stub: passthrough | ~ | Workers have `WorkerLocation` (read-only, no navigation) — passthrough is correct |
| Worker `$rewriter.wrap_member_expression` | — | Worker shim stub: passthrough (`function(o){return o;}`) | ~ | Sufficient for worker context; no cross-frame access |
| `navigator.serviceWorker.register(url)` | — | **Stubbed** — `.register()` replaced with no-op | 🚫 | Service workers can intercept all requests and would break proxy containment |
| `ServiceWorkerContainer.controller` | — | — | ✗ | Unpatched; code reading this would see `null` (no registered SW) |

---

## 5. Network APIs

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `fetch(url, init)` | — | `globalThis.fetch` replaced; URL proxified | ✓ | |
| `fetch(Request)` | — | `Request` URL proxified at construction | ✓ | |
| `Request.prototype.url` (read-back) | — | Getter returns un-proxified URL | ✓ | |
| `Response.prototype.url` (read-back) | — | Getter returns un-proxified URL | ✓ | |
| `XMLHttpRequest.prototype.open(method, url)` | — | Prototype patched; URL proxified | ✓ | |
| `XMLHttpRequest.responseURL` (read-back) | — | Getter returns un-proxified URL | ✓ | |
| `new WebSocket(url)` | — | Constructor replaced; URL proxified | ✓ | |
| `WebSocket.prototype.url` (read-back) | — | Getter returns un-proxified URL | ✓ | |
| `new EventSource(url)` | — | Constructor replaced; URL proxified | ✓ | |
| `EventSource.prototype.url` (read-back) | — | Getter returns un-proxified URL | ✓ | |
| `navigator.sendBeacon(url, data)` | — | `navigator.sendBeacon` replaced; URL proxified; `data` unchanged | ✓ | Covers GA4, doubleclick |
| WebRTC (`RTCPeerConnection`, ICE) | — | — | ✗ | ICE candidates expose real IP; TURN/STUN URLs not proxified |
| `fetch` streaming / body URLs | — | — | ✗ | URLs in response bodies not rewritten; only the request URL is |

---

## 6. Document Properties

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `document.write(html)` | `wrap_document_write({obj}).write(html)` AST wrap | `wrapDocumentWrite` runs HTML through the HTML rewriter | ✓ | |
| `document.writeln(html)` | same | same | ✓ | |
| `document.URL` | — | Getter returns `wrappedLocation.href` (virtual URL) | ✓ | |
| `document.baseURI` | — | Getter returns `wrappedLocation.href` | ✓ | Drives relative URL resolution |
| `document.referrer` | — | Getter returns upstream `Referer` header value injected by server | ✓ | |
| `document.cookie` (read) | — | Getter returns proxy's in-memory cookie store | ✓ | Proxy manages cookie state |
| `document.cookie = "..."` (write) | — | Setter updates in-memory store | ✓ | |
| `document.currentScript.src` | — | — | ✗ | Returns real proxy URL, not virtual URL. Known source of double-encoding (reCAPTCHA reads this to build Worker URL) |
| `document.domain` | — | — | ✗ | Setting `document.domain` can change same-origin semantics |
| `document.location` | via `wrap_location` | via `wrap_location` | ✓ | Handled identically to `window.location` |

---

## 7. History API

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `history.pushState(state, title, url)` | — | `History.prototype.pushState` patched; URL proxified | ✓ | `baseUrlState` also updated so subsequent `location.href` reads are consistent |
| `history.replaceState(state, title, url)` | — | `History.prototype.replaceState` patched; URL proxified | ✓ | Same |
| `history.back()` / `forward()` / `go()` | — | Passthrough (no URL arg) | ✓ | Browser navigates to a previously-proxified URL |
| `popstate` event | — | Listener updates `baseUrlState` | ✓ | Keeps virtual URL in sync after back/forward |
| `hashchange` event | — | — | ~ | `WrappedLocation.hash` setter keeps state in sync for programmatic changes; browser-driven hash changes may drift |

---

## 8. Dynamic HTML Injection

All five injection paths run the resulting HTML through the same rewriter
that processes static server responses, so dynamically injected markup is
treated identically.

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `element.innerHTML = html` | — | `Element.prototype.innerHTML` setter patched; HTML parsed+rewritten | ✓ | |
| `element.outerHTML = html` | — | `Element.prototype.outerHTML` setter patched | ✓ | |
| `element.insertAdjacentHTML(pos, html)` | — | `Element.prototype.insertAdjacentHTML` patched | ✓ | |
| `element.setAttribute('src', url)` | — | `Element.prototype.setAttribute` patched; URL-bearing attrs proxified | ✓ | |
| `element.setAttribute('href', url)` | — | same | ✓ | |
| `element.getAttribute('src')` | — | Returns un-proxified URL | ✓ | |
| `Node.appendChild(node)` | — | Patched: iframes/scripts get bootstrap injection + URL fix-up | ✓ | Covers Cloudflare beacon + dynamically created iframes |
| `Node.insertBefore(node, ref)` | — | Same as appendChild | ✓ | |
| `document.createElement('iframe')` + set `src` | — | `iframe.src` setter proxifies via prototype patch | ✓ | |
| `MutationObserver` catch-all | — | Installed as last-resort: rewrites any URL attr change that slipped past synchronous patches | ~ | Asynchronous — cannot prevent the first request, only corrects state |
| `element.insertAdjacentElement` | — | — | ✗ | Inserts existing node, not HTML string; less common path |
| `Range.createContextualFragment` | — | — | ✗ | Another HTML-string-to-DOM path; rare |
| `DOMParser.parseFromString` | — | — | ✗ | Returns a Document whose URLs are not proxified |
| `document.implementation.createHTMLDocument` | — | — | ✗ | Same issue |

---

## 9. HTML Element URL Attributes

These are the attributes rewritten statically (server-side) for all markup
in the response, and also patched dynamically (client-side) so that JS
assignments after page load are caught too.

| Element | Attribute | Server (Go) | Client (TS) | Status |
|---|---|---|---|---|
| `<a>` | `href` | ✓ | ✓ proto patch | ✓ |
| `<a>` | `ping` | ✓ HTML rewrite | — not in TS map | ~ |
| `<area>` | `href` | ✓ | ✓ proto patch | ✓ |
| `<audio>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<base>` | `href` | — (removed/not rewritten) | ✓ proto patch | ~ | `<base href>` sets page-wide base URL; server currently omits it; client patches the IDL setter |
| `<body>` | `background` | ✓ HTML rewrite | — not in TS map | ~ |
| `<button>` | `formaction` | ✓ | ✓ proto patch (`.formAction`) | ✓ |
| `<embed>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<form>` | `action` | ✓ | ✓ proto patch | ✓ |
| `<frame>` | `src` | ✓ HTML rewrite | — not in TS map (deprecated element) | ~ |
| `<iframe>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<img>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<img>` / `<source>` | `srcset` | ✓ (WHATWG parser) | ✓ proto patch + srcset parser | ✓ |
| `<input>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<input>` | `formaction` | ✓ | ✓ proto patch (`.formAction`) | ✓ |
| `<link>` | `href` | ✓ | ✓ proto patch | ✓ |
| `<object>` | `data` | ✓ HTML rewrite | — not in TS map | ~ |
| `<script>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<source>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<table>` / `<tbody>` / `<td>` / `<th>` / `<thead>` / `<tfoot>` / `<tr>` | `background` | ✓ HTML rewrite | — not in TS map | ~ |
| `<track>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<use>` | `href` | ✓ HTML rewrite | — not in TS map | ~ |
| `<use>` | `xlink:href` | ✓ HTML rewrite | — not in TS map | ~ |
| `<video>` | `src` | ✓ | ✓ proto patch | ✓ |
| `<video>` | `poster` | ✓ | ✓ proto patch | ✓ |
| Any element | `style="…url(…)"` | ✓ (inline CSS rewriter) | — | ~ | Inline `style` attr rewritten server-side; dynamic `element.style = "…"` assignment is not caught (IDL `style` returns a CSSStyleDeclaration, handled separately below) |
| `<script>`, `<link>` | `integrity` | Stripped (removed) | — | ✓ | SRI would block proxy-rewritten resources |
| `<link>` etc. | `crossorigin` | Set to `use-credentials` | — | ✓ | Ensures cookies go with cross-origin (now same-proxy-origin) requests |
| `<iframe>` | `sandbox` | `allow-same-origin` injected | — | ✓ | Enables JS access across proxy frames |
| `<meta http-equiv="Content-Security-Policy">` | Removed | — | ✓ | Would block inline scripts, the proxy JS, etc. |
| `<link rel="preconnect/dns-prefetch">` | `href` rewritten | ✓ proto patch | ✓ | So pre-connections go through proxy |

---

## 10. CSS URL APIs

| API | Server (Go) | Client (TS) | Status | Notes |
|---|---|---|---|---|
| `url(…)` in stylesheets | ✓ CSS rewriter (token-based) | — | ✓ | Covers `background`, `background-image`, `cursor`, `mask`, etc. in server-delivered CSS |
| `@import "url"` | ✓ CSS rewriter | — | ✓ | |
| `<style>` inline block | ✓ CSS rewriter | — | ✓ | |
| `style="…"` attribute (inline) | ✓ inline CSS rewriter | — | ✓ | |
| `element.style.backgroundImage = "url(…)"` | — | ✓ proto patch on `CSSStyleDeclaration` | ✓ | Also covers `borderImage`, `borderImageSource`, `listStyleImage`, `maskImage`, `cursor`, `content`, `background`, `border*`, `mask` |
| `element.style.setProperty("background-image", "url(…)")` | — | ✓ proto patch on `CSSStyleDeclaration.setProperty` | ✓ | |
| `element.style.cssText = "…url(…)"` | — | ✓ via `cssText` setter → CSS rewriter | ✓ | |
| `CSSStyleSheet.prototype.insertRule(rule)` | — | ✓ proto patch (instance-chain walk, not class-level) | ✓ | |
| `CSSGroupingRule.prototype.insertRule(rule)` (@media etc.) | — | ✓ same proto walk | ✓ | |
| `CSSStyleSheet.prototype.deleteRule` | — | — | ✗ | No URL in `deleteRule`; no action needed |
| `CSSStyleSheet.prototype.replace(css)` | — | — | ✗ | Constructable stylesheet method; CSS content with URLs not rewritten dynamically |
| `CSSStyleSheet.prototype.replaceSync(css)` | — | — | ✗ | Same |
| CSS selector rewriting (`rewrite_css_selectors`) | — | Configurable; currently disabled | ~ | Feature-flagged; `rewrite_css_selectors: false` in all configs |
| Adopted stylesheets (`document.adoptedStyleSheets`) | — | — | ✗ | Content not rewritten after adoption |

---

## 11. Response / Request Headers (Server-Side Only)

| Header | Treatment | Notes |
|---|---|---|
| `Content-Security-Policy` | Rewritten: nonces stripped, proxy origin injected | See `go/src/internal/proxy/csp.go` |
| `Content-Security-Policy-Report-Only` | — not touched | Reports sent to third party; could expose proxy structure |
| `Location` (redirect) | URL proxified | |
| `Refresh` | URL proxified | |
| `Set-Cookie` | Cookie attributes adjusted (Path, SameSite); value unchanged | Encryption is a TODO |
| `X-Frame-Options` | Removed | Would block embedding in proxy pages |
| `Strict-Transport-Security` | — | Passed through; applies to proxy origin, not upstream |
| `Link` (preload) | — | Link header URLs not proxified |

---

## 12. Cookies

| Mechanism | Status | Notes |
|---|---|---|
| `document.cookie` read/write | ✓ | In-memory store; script sees clean cookie jar |
| `Set-Cookie` response headers | ✓ | Proxy stores and re-sends cookies |
| Cookie sync via `process_server_cookies` | ✓ | `onload` hook on `<script src>` pulls cookies from proxy |
| Cookie sync via `fetch_cookies` | ✓ | `onload` hook on `<img src>` |
| Cookie decryption (AES-CTR, per-session key) | 🚫 stub | **TODO** — `ts/client/src/cookies/decrypt.ts` decodes base64 but skips decryption |
| Cookie sync endpoint | 🚫 stub | `go/src/internal/server/endpoints.go` returns empty data; in-memory only |

---

## 13. Comparison with Reference Implementation

The reference client at `/media/igor/igor/work/aproxy/client` is the prior
production implementation (F5/Cisco lineage). Entries below are surfaces it
covers that the new implementation either does not cover or handles differently.

### Reference handles; new impl does not

| API | Reference approach | Risk | Notes |
|---|---|---|---|
| `window.open(url)` | URL proxified | **Medium** | New impl has no runtime interception; static JS AST wrap only covers literal strings |
| `setTimeout(string)` / `setInterval(string)` | String arg run through JS rewriter | **Low** | Legacy but used by some CMSes |
| `element.textContent = js` on `<script>` | Setter runs through JS rewriter | **Medium** | Standard pattern for dynamically building inline scripts (e.g. GTM) |
| `element.innerText = css` on `<style>` | Setter runs through CSS rewriter | **Low** | |
| `Range.prototype.createContextualFragment(html)` | HTML rewritten before node creation | **Low** | Another DOM injection path beyond innerHTML/insertAdjacentHTML |
| `Node.prototype.replaceChild(new, old)` | New node inspected + URL-fixed | **Low** | Complement to appendChild/insertBefore |
| `Element.prototype.replaceWith(…)` | Same | **Low** | |
| `Element.prototype.setAttributeNode(attr)` | `Attr.prototype.value` setter intercepts URL-bearing attr nodes | **Low** | Uncommon path; some SVG libraries use it |
| `Attr.prototype.value` setter | URL rewriting on any attr value write | **Low** | Covers the above and any other attr-node manipulation |
| `document.documentURI` | Returns virtual URL | **Low** | Alias for `document.URL`; patched separately in reference |
| `document.origin` / `window.origin` | Returns virtual origin | **Medium** | Scripts guarding on `window.origin === "https://…"` fail without this |
| `HTMLAnchorElement.href` / `HTMLAreaElement.href` read-back | Returns un-proxified URL | **Medium** | `anchor.href` gives the IDL absolute URL; without a getter patch it returns the proxy URL, confusing scripts that read link href back |
| `HTMLAnchorElement.protocol/host/pathname/…` | Full URL-decomposition properties | **Low** | Scripts that read `anchor.hostname` etc. see proxy host without these |
| `HTMLIFrameElement.srcdoc = html` | HTML content rewritten | **Medium** | Inline iframes without `src`; injected HTML is not proxified |
| `new Audio(url)` | URL proxified | **Low** | `HTMLAudioElement` constructor accepts a URL arg |
| `new Image(w, h)` src assignment | onload / src handled | **Low** | Already covered via `HTMLImageElement.prototype.src` setter |
| `document.open()` / `document.close()` | Manages write-stream state | **Low** | `document.open()` before `document.write()` sequences |
| Cookie encryption / decryption | Full AES-CTR per-session key | **High** | New impl has the stub; `decrypt.ts` does base64 only |
| uBlock / ad-detector bypass | `dispatchEvent` interception; custom class rewriting | Ad-feature only | Not applicable — no ad evasion in new impl (intentional) |
| CSS selector rewriting (ID/class mangling) | Full selector rewrite in querySelector | Ad-feature only | `rewrite_css_selectors: false` in new impl; feature-flagged |

### Reference handles differently; new impl should verify

| API | Reference | New impl | Notes |
|---|---|---|---|
| `window.location` | `Proxy`-based full Location proxy | `WrappedLocation` class + `Object.defineProperty` | Both approach the same result; Proxy handles unknown property accesses automatically |
| `postMessage` data payload | URLs in `event.data` strings NOT rewritten either | Same gap | Both implementations share this gap |
| `Function.prototype.toString` | Returns original source via KV store | Not patched | Matters only if code uses `fn.toString()` to check source (anti-tamper) |
| Worker shim | Inline `$aproxy` stub injected into worker responses | Separate `buildWorkerShim` prepended to response body | New impl's approach is cleaner; reference inlines at server too |
| `document.cookie` encryption | AES-CTR with per-session key | Stubbed | New impl has the decryption hook points; just not implemented |

---

## 14. Known Gaps Summary

These are the surfaces the proxy does not currently handle. Sorted
roughly by real-world impact.

| Gap | Risk | File to fix |
|---|---|---|
| `document.currentScript.src` returns proxy URL | **High** — reCAPTCHA reads this to construct Worker URL, causing double-encoding (workaround: double-encoding detection in `rewriteUrl`) | `ts/client/src/patches/url-attributes.ts` or new patch |
| Inline event handler JS (`onclick="location.href='…'"`) | **Medium** — URL assignments in HTML event attrs bypass AST rewriting | `go/src/internal/htmlrewrite/config.go` + JS rewriter |
| `postMessage` data payload URL rewriting | **Medium** — URLs in `event.data` arrive un-rewritten at recipient | `ts/client/src/wrappers/post-message.ts` |
| `setTimeout/setInterval(string)` | **Low** — legacy but used by some CMSes | JS AST wrap or patch |
| `<object data>`, `<body background>`, layout `background` attrs not in TS map | **Low** — server covers static HTML; JS assignment would leak | `ts/client/src/patches/url-attribute-map.ts` |
| `<a ping>` not in TS map | **Low** | Same file |
| `<use href>` / `<use xlink:href>` not in TS map | **Low** | Same file |
| `window.open(url)` | **Low** | JS AST wrap |
| `DOMParser.parseFromString` / `Range.createContextualFragment` | **Low** | New TS patch |
| `CSSStyleSheet.replace(css)` / `replaceSync(css)` | **Low** | New TS patch |
| `document.adoptedStyleSheets` | **Low** | New TS patch |
| WebRTC ICE / STUN / TURN | **Low** — IP leak risk | New TS patch |
| Cookie decryption (AES-CTR) | **Medium** — encrypted cookie payloads unreadable | `ts/client/src/cookies/decrypt.ts` |
| `navigator.serviceWorker` controller read-back | **Low** | New TS patch |
| `Link:` preload response header URL | **Low** | Go proxy header rewriter |
| `CSP-Report-Only` header | **Low** | Go proxy header rewriter |
