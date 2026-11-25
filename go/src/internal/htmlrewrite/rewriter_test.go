package htmlrewrite

import (
	"github.com/yovico/cyrano/internal/jsrewrite"
	"bytes"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// devProxy is a typical dev-time setup — single public origin
// `http://localhost:9081`. Every rewritten URL lands here.
var devProxy = urlrewrite.ProxyConfig{
	PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"},
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u
}

// rewrite is a thin test helper — string-in, string-out, default config.
func rewrite(t *testing.T, in string, opts ...func(*Config)) string {
	t.Helper()
	cfg := Config{
		BaseURL:         mustURL(t, "https://example.com/"),
		Proxy:           devProxy,
		RewriterJSPath:  "/rewriter.js",
		InjectBootstrap: false,
		NoOriginals:     true, // most tests compare the rewritten markup itself
	}
	for _, o := range opts {
		o(&cfg)
	}
	var out bytes.Buffer
	if err := Rewrite(&out, strings.NewReader(in), cfg); err != nil {
		t.Fatalf("Rewrite: %v", err)
	}
	return out.String()
}

func withInject(cfg *Config) { cfg.InjectBootstrap = true }
func withBaseURL(u string) func(*Config) {
	return func(cfg *Config) {
		parsed, _ := url.Parse(u)
		cfg.BaseURL = parsed
	}
}

// ── HTML_EXTERNAL_RESOURCE_ATTRS ────────────────────────────────────────────

func TestRewrite_AnchorHrefAbsolute(t *testing.T) {
	got := rewrite(t, `<a href="https://other.com/about">x</a>`)
	want := `<a href="http://localhost:9081/cyrano/https/other.com/about">x</a>`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestRewrite_AnchorHrefRelative(t *testing.T) {
	got := rewrite(t, `<a href="/about">x</a>`)
	want := `<a href="http://localhost:9081/cyrano/https/example.com/about">x</a>`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestRewrite_ImgSrc(t *testing.T) {
	got := rewrite(t, `<img src="https://cdn.example.com/img.png" />`)
	if !strings.Contains(got, `src="http://localhost:9081/cyrano/https/cdn.example.com/img.png"`) {
		t.Errorf("img src not rewritten: %s", got)
	}
}

func TestRewrite_ScriptSrc(t *testing.T) {
	got := rewrite(t, `<script src="https://cdn.example.com/x.js"></script>`)
	if !strings.Contains(got, `src="http://localhost:9081/cyrano/https!js/cdn.example.com/x.js"`) {
		t.Errorf("script src not rewritten: %s", got)
	}
}

func TestRewrite_LinkHref(t *testing.T) {
	got := rewrite(t, `<link rel="stylesheet" href="/styles.css">`)
	if !strings.Contains(got, `href="http://localhost:9081/cyrano/https!css/example.com/styles.css"`) {
		t.Errorf("link href not rewritten: %s", got)
	}
}

func TestRewrite_FormAction(t *testing.T) {
	got := rewrite(t, `<form action="/submit" method="POST"></form>`)
	if !strings.Contains(got, `action="http://localhost:9081/cyrano/https/example.com/submit"`) {
		t.Errorf("form action not rewritten: %s", got)
	}
}

func TestRewrite_VideoPosterAndSrc(t *testing.T) {
	got := rewrite(t,
		`<video poster="https://cdn.example.com/poster.jpg" src="https://cdn.example.com/v.mp4"></video>`)
	if !strings.Contains(got, "localhost:9081/cyrano/https/cdn.example.com/poster.jpg") {
		t.Errorf("poster not rewritten: %s", got)
	}
	if !strings.Contains(got, "localhost:9081/cyrano/https/cdn.example.com/v.mp4") {
		t.Errorf("video src not rewritten: %s", got)
	}
}

func TestRewrite_PreservesAnchorOnly(t *testing.T) {
	got := rewrite(t, `<a href="#foo">x</a>`)
	if got != `<a href="#foo">x</a>` {
		t.Errorf("in-page anchor mutated: %s", got)
	}
}

// ── HTML_SRCSET ──────────────────────────────────────────────────────────────

func TestRewrite_Srcset_TwoCandidates(t *testing.T) {
	got := rewrite(t,
		`<img srcset="https://cdn.example.com/a.png 1x, https://cdn.example.com/b.png 2x" />`)
	if !strings.Contains(got, "localhost:9081/cyrano/https!set/cdn.example.com/a.png 1x") {
		t.Errorf("srcset 1x candidate missing: %s", got)
	}
	if !strings.Contains(got, "localhost:9081/cyrano/https!set/cdn.example.com/b.png 2x") {
		t.Errorf("srcset 2x candidate missing: %s", got)
	}
}

func TestRewrite_Srcset_NoDescriptor(t *testing.T) {
	got := rewrite(t, `<img srcset="https://cdn.example.com/a.png" />`)
	if !strings.Contains(got, `srcset="http://localhost:9081/cyrano/https!set/cdn.example.com/a.png"`) {
		t.Errorf("srcset single-URL not rewritten: %s", got)
	}
}

// ── HTML_INTEGRITY ───────────────────────────────────────────────────────────

func TestRewrite_StripsIntegrity(t *testing.T) {
	got := rewrite(t, `<script src="/x.js" integrity="sha256-abc"></script>`)
	if strings.Contains(got, "integrity") {
		t.Errorf("integrity attr should be stripped: %s", got)
	}
}

// ── HTML_CROSSORIGIN ─────────────────────────────────────────────────────────

func TestRewrite_CrossoriginToUseCredentials(t *testing.T) {
	got := rewrite(t, `<script src="/x.js" crossorigin="anonymous"></script>`)
	if !strings.Contains(got, `crossorigin="use-credentials"`) {
		t.Errorf("crossorigin not normalized: %s", got)
	}
}

// A script preload must be normalized to use-credentials too, so it matches the
// (also-forced) use-credentials <script> and the browser reuses the preload
// instead of double-fetching the bundle (which, under HTTP/2 coalescing, wedged
// the connection). Regression for the vendor.js/main.js pending-forever bug.
func TestRewrite_CrossoriginScriptPreloadToUseCredentials(t *testing.T) {
	got := rewrite(t, `<link rel="preload" as="script" crossorigin="anonymous" href="/x.js">`)
	if !strings.Contains(got, `crossorigin="use-credentials"`) {
		t.Errorf("script preload crossorigin not normalized: %s", got)
	}
}

// A font preload must stay anonymous to match the (non-credentialed) @font-face
// fetch; forcing use-credentials there would double-fetch the font instead.
func TestRewrite_CrossoriginFontPreloadStaysAnonymous(t *testing.T) {
	got := rewrite(t, `<link rel="preload" as="font" crossorigin="anonymous" href="/x.woff2">`)
	if strings.Contains(got, `crossorigin="use-credentials"`) {
		t.Errorf("font preload crossorigin should stay anonymous: %s", got)
	}
	if !strings.Contains(got, `crossorigin="anonymous"`) {
		t.Errorf("font preload lost its crossorigin: %s", got)
	}
}

// ── HTML_METATAG (CSP) ───────────────────────────────────────────────────────

// A <meta> CSP keeps enforcing, translated as a header policy is:
// the proxy origin added where sources are allowed, 'none' left alone.
func TestRewrite_TranslatesCspMeta(t *testing.T) {
	got := rewrite(t, `<meta http-equiv="content-security-policy" content="default-src 'self'; object-src 'none'; frame-src 'none'; report-uri /r">`)
	want := `<meta http-equiv="content-security-policy" content="default-src 'self' http://localhost:9081; object-src 'none'; frame-src 'none'; connect-src 'self' http://localhost:9081 ws://localhost:9081 blob: data:">`
	if got != want {
		t.Errorf("\n got  %s\n want %s", got, want)
	}
}

func TestRewrite_KeepsOtherMeta(t *testing.T) {
	got := rewrite(t, `<meta name="viewport" content="width=device-width">`)
	if !strings.Contains(got, `viewport`) || !strings.Contains(got, `width=device-width`) {
		t.Errorf("non-CSP meta should pass through: %s", got)
	}
}

// ── HTML_SANDBOX ─────────────────────────────────────────────────────────────

// A sandbox is kept as written: allow-same-origin added let the parent
// read the frame's document, its messages come from a real origin and its
// cookies work, where directly it is opaque.
func TestRewrite_IframeSandboxKeptAsWritten(t *testing.T) {
	got := rewrite(t, `<iframe src="/x" sandbox="allow-scripts"></iframe>`)
	if !strings.Contains(got, `sandbox="allow-scripts"`) || strings.Contains(got, "allow-same-origin") {
		t.Errorf("sandbox changed: %s", got)
	}
}

func TestRewrite_IframeSandboxAlreadyHasAllowSameOrigin(t *testing.T) {
	got := rewrite(t, `<iframe src="/x" sandbox="allow-scripts allow-same-origin"></iframe>`)
	if !strings.Contains(got, `sandbox="allow-scripts allow-same-origin"`) {
		t.Errorf("sandbox should be unchanged: %s", got)
	}
	// shouldn't double up
	if strings.Count(got, "allow-same-origin") != 1 {
		t.Errorf("allow-same-origin duplicated: %s", got)
	}
}

// ── HTML_BASETAG ─────────────────────────────────────────────────────────────

func TestRewrite_BaseTagShiftsResolution(t *testing.T) {
	in := `<head><base href="https://other.com/sub/"><a href="page.html">x</a></head>`
	got := rewrite(t, in)
	// After <base>, "page.html" should resolve against https://other.com/sub/
	if !strings.Contains(got, "localhost:9081/cyrano/https/other.com/sub/page.html") {
		t.Errorf("base href not honored: %s", got)
	}
}

// ── HTML_APPEND_REWRITER_JS ────────────────────────────────────────────────────

func TestRewrite_BootstrapInjected(t *testing.T) {
	got := rewrite(t, `<html><head><title>x</title></head><body></body></html>`, withInject)
	if !strings.Contains(got, `<script src="/rewriter.js"></script>`) {
		t.Errorf("rewriter.js script tag missing: %s", got)
	}
	if !strings.Contains(got, `window.$rewriter=window.$rewriter_init(window`) {
		t.Errorf("inline bootstrap call missing: %s", got)
	}
	// Regression: set_location MUST be inline (same <script> as the
	// $rewriter_init call), not in a separate async <script src=…>. An async
	// head-injection lets the page's own inline scripts run *before* the
	// runtime's base-URL state is set, so any relative URL they touch (e.g.
	// Cloudflare's /cdn-cgi/...) gets resolved against the proxy origin
	// instead of the original page origin and bypasses the rewriter.
	if !strings.Contains(got, `$rewriter.set_location("https://example.com/")`) {
		t.Errorf("inline set_location call missing: %s", got)
	}
	if strings.Contains(got, "head-injection?bu=") {
		t.Errorf("async head-injection script must NOT be emitted (set_location is inlined): %s", got)
	}
}

func TestRewrite_BootstrapInjectedBeforeOtherScripts(t *testing.T) {
	got := rewrite(t, `<html><head><script src="/page.js"></script></head></html>`, withInject)
	idxBootstrap := strings.Index(got, `<script src="/rewriter.js"`)
	idxPageScript := strings.Index(got, `<script src="http://localhost:9081/cyrano/https!js/example.com/page.js"`)
	if idxBootstrap < 0 || idxPageScript < 0 {
		t.Fatalf("missing scripts: bootstrap=%d page=%d in:\n%s", idxBootstrap, idxPageScript, got)
	}
	if idxBootstrap > idxPageScript {
		t.Errorf("bootstrap injected after page script (must be first): %s", got)
	}
}

func TestRewrite_NoBootstrapWhenDisabled(t *testing.T) {
	got := rewrite(t, `<html><head></head></html>`)
	if strings.Contains(got, "$rewriter_init") {
		t.Errorf("bootstrap should not be injected: %s", got)
	}
}

func TestRewrite_BootstrapFallbackOnBody_WhenNoHead(t *testing.T) {
	// Some pages (e.g. redirect landing pages, partial HTML responses) omit
	// the <head> element. The bootstrap must still be injected so $rewriter is
	// available to any scripts in the body.
	got := rewrite(t, `<html><body><script src="/page.js"></script></body></html>`, withInject)
	if !strings.Contains(got, `window.$rewriter=window.$rewriter_init(window`) {
		t.Errorf("bootstrap not injected via <body> fallback: %s", got)
	}
	idxBootstrap := strings.Index(got, `<script src="/rewriter.js"`)
	idxPageScript := strings.Index(got, `<script src="http://localhost:9081/cyrano/`)
	if idxBootstrap < 0 || idxPageScript < 0 {
		t.Fatalf("missing scripts: bootstrap=%d page=%d in:\n%s", idxBootstrap, idxPageScript, got)
	}
	if idxBootstrap > idxPageScript {
		t.Errorf("bootstrap injected after page script (must be first): %s", got)
	}
}

func TestRewrite_BootstrapNotDoubleInjected_WithHeadAndBody(t *testing.T) {
	// <head> AND <body> both present — bootstrap injected only once.
	got := rewrite(t, `<html><head></head><body></body></html>`, withInject)
	count := strings.Count(got, "window.$rewriter=window.$rewriter_init(")
	if count != 1 {
		t.Errorf("bootstrap injected %d times, want exactly 1: %s", count, got)
	}
}

// ── End-to-end: full page round-trip ────────────────────────────────────────

func TestRewrite_FullPage(t *testing.T) {
	in := `<!doctype html><html><head><title>X</title>` +
		`<meta http-equiv="content-security-policy" content="x">` +
		`<link rel="stylesheet" href="/style.css" integrity="sha-x">` +
		`</head><body><a href="/about">about</a><img src="/p.png"/></body></html>`
	got := rewrite(t, in, withInject)

	// CSP meta kept (translated; "x" is no directive it changes)
	if !strings.Contains(got, `<meta http-equiv="content-security-policy" content="x">`) {
		t.Errorf("CSP meta not kept: %s", got)
	}
	// Integrity stripped
	if strings.Contains(got, "integrity") {
		t.Errorf("integrity not stripped: %s", got)
	}
	// Bootstrap injected
	if !strings.Contains(got, "$rewriter_init") {
		t.Errorf("bootstrap missing: %s", got)
	}
	// All three external URLs proxified
	for _, u := range []string{
		"localhost:9081/cyrano/https!css/example.com/style.css",
		"localhost:9081/cyrano/https/example.com/about",
		"localhost:9081/cyrano/https/example.com/p.png",
	} {
		if !strings.Contains(got, u) {
			t.Errorf("URL not rewritten in output: %q\nout: %s", u, got)
		}
	}
}

// ── srcset corner cases ─────────────────────────────────────────────────────

func TestRewriteSrcset_Empty(t *testing.T) {
	out := rewriteSrcset("", func(s string) string { return "REWRITTEN(" + s + ")" })
	if out != "" {
		t.Errorf("got %q", out)
	}
}

func TestRewriteSrcset_OnlyWhitespace(t *testing.T) {
	out := rewriteSrcset(" , , ", func(s string) string { return "X" })
	if !strings.Contains(out, "X") {
		// nothing to rewrite — no candidates
		// This is OK; just don't crash.
	}
}

func TestRewriteSrcset_Trailing(t *testing.T) {
	out := rewriteSrcset(
		"a.png 1x, b.png",
		func(s string) string { return "R(" + s + ")" },
	)
	if !strings.Contains(out, "R(a.png) 1x") {
		t.Errorf("first candidate: %s", out)
	}
	if !strings.Contains(out, "R(b.png)") {
		t.Errorf("descriptor-less candidate: %s", out)
	}
}

func TestRewriteSrcset_CloudflareCommasInURL(t *testing.T) {
	// Cloudflare Image Resizing embeds transform params with commas in the URL
	// path: /cdn-cgi/image/width=640,quality=75,format=auto/https://origin/img
	// Those commas must NOT be treated as srcset candidate separators.
	cfURL1 := "https://cdn.example.com/cdn-cgi/image/width=640,quality=75,format=auto/https://origin.com/img.jpg"
	cfURL2 := "https://cdn.example.com/cdn-cgi/image/width=1280,quality=75,format=auto/https://origin.com/img.jpg"
	srcset := cfURL1 + " 640w, " + cfURL2 + " 1280w"
	out := rewriteSrcset(srcset, func(s string) string { return "R(" + s + ")" })
	if !strings.Contains(out, "R("+cfURL1+") 640w") {
		t.Errorf("first candidate not intact: %s", out)
	}
	if !strings.Contains(out, "R("+cfURL2+") 1280w") {
		t.Errorf("second candidate not intact: %s", out)
	}
}

// ── inline-script handoff to RewriteInlineJS ─────────────────────────────
//
// Regression: RewriteInlineJS receives a slice into the html tokenizer's
// internal buffer. The downstream JS rewriter (tdewolff/parse) writes a
// NUL sentinel one byte past the end of its input. Without a defensive
// copy, that NUL stomps the first byte of the next tag — typically the
// `<` of `</script>` — corrupting the output to `\0/script>` /
// `\0meta>` / `\0/head>`. The fix copies before handoff; this test pins
// the contract so a regression shows up immediately.

func TestRewrite_InlineScript_NoNULStompFromRewriter(t *testing.T) {
	in := `<html><head><script>function f() { return 1; }</script><meta charset="utf-8"></head></html>`
	got := rewrite(t, in, func(cfg *Config) {
		// Pretend the JS rewriter just round-trips the body. The previous
		// bug's blast radius came from the *underlying buffer aliasing*,
		// not from the rewriter's logic — so even a no-op rewriter would
		// reproduce it without the fix. (This makes the test independent
		// of jsrewrite, which lives in a sibling package.)
		cfg.RewriteInlineJS = func(src []byte) []byte {
			out := make([]byte, len(src)+1)
			copy(out, src)
			out[len(src)] = 0     // simulate the tdewolff NUL sentinel
			return out[:len(src)] // return only the original bytes
		}
	})
	if strings.IndexByte(got, 0) != -1 {
		t.Errorf("output contains NUL byte; html rewriter must copy z.Text() before handing off to RewriteInlineJS\noutput: %q", got)
	}
	if !strings.Contains(got, `</script>`) {
		t.Errorf("missing intact </script> in output: %q", got)
	}
	if !strings.Contains(got, `<meta charset="utf-8">`) {
		t.Errorf("missing intact <meta> after script: %q", got)
	}
}

func TestRewrite_InlineScript_RewriterOutputPreserved(t *testing.T) {
	// Sanity: RewriteInlineJS's return value lands verbatim in the output,
	// between the script open and close tags, with surrounding tags intact.
	in := `<html><body><script>x;</script><p>after</p></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.RewriteInlineJS = func(src []byte) []byte { return []byte("REPLACED;") }
	})
	if !strings.Contains(got, `<script>REPLACED;</script>`) {
		t.Errorf("inline script body not replaced or boundary corrupted: %q", got)
	}
	if !strings.Contains(got, `<p>after</p>`) {
		t.Errorf("post-script content lost: %q", got)
	}
}

// ── inline-style handoff to RewriteInlineCSS ─────────────────────────────
//
// Same NUL-stomp risk as inline-script; same defensive copy in the
// rewriter. Pinning the contract here too.

func TestRewrite_InlineStyle_NoNULStompFromRewriter(t *testing.T) {
	in := `<html><head><style>.a { color: red; }</style><meta charset="utf-8"></head></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.RewriteInlineCSS = func(src []byte) []byte { return src }
	})
	if strings.IndexByte(got, 0) != -1 {
		t.Errorf("output contains NUL byte after inline-style rewrite\noutput: %q", got)
	}
	if !strings.Contains(got, `</style>`) {
		t.Errorf("missing intact </style>: %q", got)
	}
	if !strings.Contains(got, `<meta charset="utf-8">`) {
		t.Errorf("missing intact <meta> after style: %q", got)
	}
}

// ── <noscript> content: the page's text ──────────────────────────────────

// With scripting on, a noscript's content is a text node the page reads
// back (lazy loaders turn it into markup through innerHTML, which the
// runtime rewrites): it is left as written.
func TestRewrite_Noscript_ContentAsWritten(t *testing.T) {
	inner := `<link rel="stylesheet" href="//example.com/noscript.css"><img src="https://example.com/a.png" data-x=1>`
	in := `<html><head><noscript>` + inner + `</noscript><title>T</title></head></html>`
	got := rewrite(t, in)
	if !strings.Contains(got, "<noscript>"+inner+"</noscript>") {
		t.Errorf("noscript content changed:\n%s", got)
	}
	if !strings.Contains(got, "<title>T</title>") {
		t.Errorf("content after </noscript> missing:\n%s", got)
	}
}

func TestRewrite_NoOnloadHooksWithoutBootstrap(t *testing.T) {
	// Without InjectBootstrap, $rewriter.* onload hooks must not be emitted —
	// they would throw ReferenceError on pages that have no $rewriter runtime.
	in := `<html><head></head><body><script src="/s.js"></script><img src="/i.png" /></body></html>`
	got := rewrite(t, in) // default: InjectBootstrap=false
	if strings.Contains(got, "$rewriter") {
		t.Errorf("$rewriter.* references injected without InjectBootstrap: %s", got)
	}
}

// ── No cyrano attributes in the page's markup ────────────────────────────

func TestRewrite_NoCookieHooksInMarkup(t *testing.T) {
	// Cookies live in the browser's own jar: no element gets a cyrano onload
	// (page code would see it through getAttribute, outerHTML, el.onload).
	in := `<html><head></head><body><script src="/x.js"></script><img src="/i.png" onload="userCode()" /></body></html>`
	got := rewrite(t, in, withInject)
	if strings.Contains(got, "process_server_cookies") || strings.Contains(got, "fetch_cookies") || strings.Contains(got, "set_cookies") {
		t.Errorf("cookie hooks in markup: %s", got)
	}
	if !strings.Contains(got, `onload="userCode()"`) {
		t.Errorf("the page's own onload changed: %s", got)
	}
}

func TestRewrite_BootstrapWithoutHeadOrBody(t *testing.T) {
	// A fragment-like document (no <head>, no <body>): its scripts are
	// rewritten to call $rewriter, so the bootstrap must come first.
	got := rewrite(t, `<!doctype html><script>var a = 1;</script><div>x</div>`, withInject)
	boot := strings.Index(got, "$rewriter_init")
	page := strings.Index(got, "var a")
	if boot < 0 || page < 0 || boot > page {
		t.Errorf("bootstrap not before the page's first script: %s", got)
	}
	if strings.Count(got, "window.$rewriter=window.$rewriter_init(") != 1 {
		t.Errorf("bootstrap injected more than once: %s", got)
	}
}

func TestRewrite_MetaRefresh(t *testing.T) {
	got := rewrite(t, `<html><head><meta http-equiv="refresh" content="0; url=/next"></head></html>`)
	if !strings.Contains(got, `/cyrano/https/`) || strings.Contains(got, `content="0; url=/next"`) {
		t.Errorf("meta refresh URL not proxified: %s", got)
	}
}

// ── The page's own markup, kept ──────────────────────────────────────────

func TestRewrite_OriginalsAttribute(t *testing.T) {
	withOriginals := func(cfg *Config) { cfg.NoOriginals = false; cfg.InjectBootstrap = true }
	in := `<html><head></head><body>` +
		`<a class="k" href="../up?q=1">x</a>` + // changed: recorded
		`<img alt="a" src="/i.png" srcset="a.png 1x, b.png 2x">` +
		`<script src="/s.js" integrity="sha384-abc"></script>` + // integrity dropped: recorded
		`<iframe src="/f"></iframe>` + // no cyrano onload hook is written any more
		`<p id="p" title="plain">t</p>` + // untouched: nothing recorded
		`</body></html>`
	got := rewrite(t, in, withOriginals)
	for _, want := range []string{
		`crn-o="{&#34;href&#34;:&#34;../up?q=1&#34;}"`,
		`&#34;src&#34;:&#34;/i.png&#34;`, `&#34;srcset&#34;:&#34;a.png 1x, b.png 2x&#34;`,
		`&#34;integrity&#34;:&#34;sha384-abc&#34;`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "onload") {
		t.Errorf("an onload attribute was written into the page's markup: %s", got)
	}
	if !strings.Contains(got, `<p id="p" title="plain">`) {
		t.Errorf("an untouched element got an originals attribute: %s", got)
	}
}

func TestRewrite_BootstrapCarriesThePagesNonce(t *testing.T) {
	got := rewrite(t, `<html><head></head><body></body></html>`, func(cfg *Config) {
		cfg.InjectBootstrap = true
		cfg.ScriptNonce = `ab"c`
	})
	if strings.Count(got, `<script nonce="ab&#34;c"`) != 2 {
		t.Errorf("both bootstrap scripts need the nonce (escaped): %s", got)
	}
}

// An iframe's srcdoc is a document: its URLs are rewritten and it gets the
// runtime before its own scripts (ibm.com: tracking frames written as
// srcdoc fetched everything directly).
func TestRewrite_IframeSrcdoc(t *testing.T) {
	out := rewrite(t, `<html><head></head><body><iframe srcdoc="&lt;script src=&quot;https://t.example/a.js&quot;&gt;&lt;/script&gt;"></iframe></body></html>`, func(cfg *Config) {
		cfg.InjectBootstrap = true
	})
	i := strings.Index(out, `srcdoc="`)
	if i < 0 {
		t.Fatalf("no srcdoc: %s", out)
	}
	doc := out[i:]
	doc = doc[:strings.Index(doc, `></iframe>`)]
	boot, script := strings.Index(doc, "$rewriter_init"), strings.Index(doc, "/cyrano/https!js/t.example/a.js")
	if boot < 0 || script < 0 || boot > script {
		t.Errorf("srcdoc needs the runtime, then its script proxified (runtime at %d, script at %d):\n%s", boot, script, doc)
	}
	if strings.Contains(doc, "<script") {
		t.Errorf("srcdoc must stay escaped inside the attribute:\n%s", doc)
	}
}

// A preload link's imagesrcset is a srcset (zerohedge.com: Next.js image
// preloads escaped the proxy).
func TestRewrite_LinkImageSrcset(t *testing.T) {
	got := rewrite(t, `<link rel="preload" as="image" imagesrcset="a.webp 16w, https://cdn.example/b.webp 32w" imagesizes="50vw">`)
	for _, want := range []string{"/cyrano/https!set/cdn.example/b.webp 32w", "a.webp 16w"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
	if strings.Contains(got, `"https://cdn.example/b.webp`) || strings.Contains(got, ` https://cdn.example/b.webp`) {
		t.Errorf("an imagesrcset URL escaped: %s", got)
	}
}

// An iframe's allow naming the frame's origin: through the proxy the frame
// has the proxy's origin, and lost the feature. The page reads its own text.
func TestRewrite_IframeAllowOrigins(t *testing.T) {
	out := rewrite(t, `<iframe allow="camera https://meet.example; fullscreen" src="https://meet.example/r"></iframe>`, func(c *Config) { c.NoOriginals = false })
	if !strings.Contains(out, `allow="camera &#39;src&#39;; fullscreen"`) && !strings.Contains(out, `allow="camera 'src'; fullscreen"`) {
		t.Errorf("allow not rewritten: %s", out)
	}
	if !strings.Contains(out, `crn-o=`) || !strings.Contains(out, "camera https://meet.example") {
		t.Errorf("original allow not carried: %s", out)
	}
}

// A <style> whose text the rewriter changes carries the text as written
// ("#text" in the originals attribute), so the page reads its own CSS
// back: React's hydration compares a <style>'s textContent with what it
// renders, and the rewritten url() was a mismatch (21kschool.com, error
// #418). An unchanged style, and an SVG one, keep to the same rule.
func TestRewrite_StyleTextOriginal(t *testing.T) {
	// The CSS rewriter as a stand-in that changes url()s only.
	css := func(cfg *Config) {
		cfg.RewriteInlineCSS = func(src []byte) []byte { return bytes.ReplaceAll(src, []byte("url(/"), []byte("url(/cyrano/https/example.com/")) }
	}
	withOriginals := func(cfg *Config) { cfg.NoOriginals = false; css(cfg) }
	got := rewrite(t, `<html><head><style>p{color:red}</style></head><body><style media="x">b{background:url(/bg.png)}</style><svg><style>c{fill:url(/f.svg)}</style></svg></body></html>`, withOriginals)
	if !strings.Contains(got, `<style>p{color:red}</style>`) {
		t.Errorf("an unchanged style got an originals attribute:\n%s", got)
	}
	for _, want := range []string{
		`<style media="x" crn-o="{&#34;#text&#34;:&#34;b{background:url(/bg.png)}&#34;}">`,
		`<style crn-o="{&#34;#text&#34;:&#34;c{fill:url(/f.svg)}&#34;}">`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in:\n%s", want, got)
		}
	}
	// An attribute original and the text original in one object.
	got = rewrite(t, `<html><body><style integrity="x">b{background:url(/bg.png)}</style></body></html>`, withOriginals)
	if !strings.Contains(got, `&#34;#text&#34;:&#34;b{background:url(/bg.png)}&#34;}"`) || strings.Count(got, "crn-o=") != 1 {
		t.Errorf("one originals attribute with both expected:\n%s", got)
	}
	// Without originals, nothing is added.
	got = rewrite(t, `<html><body><style>b{background:url(/bg.png)}</style></body></html>`, func(cfg *Config) { cfg.NoOriginals = true; css(cfg) })
	if strings.Contains(got, "crn-o") {
		t.Errorf("originals written with NoOriginals:\n%s", got)
	}
}

// An event handler attribute's value is a function body the browser
// compiles: rewritten by the JS rules (spec/Attrs.agda handler), its
// original kept for read-back. A Lijit sync frame's
// `onload="q(location,document)"` (birdies.com) read the proxy's location;
// Basis' `onload="window.location.href='…'"` (guns.com) navigated to the
// origin. A value no rule touches, and a name that is no handler, stay.
func TestRewrite_EventHandlerAttributes(t *testing.T) {
	js := func(cfg *Config) {
		cfg.NoOriginals = false
		cfg.RewriteInlineJS = func(src []byte) []byte { return jsrewrite.Rewrite(src, jsrewrite.DefaultOptions()) }
	}
	got := rewrite(t, `<html><body onload="q(location,document)"><a onclick="return false" data-on="location" one-x="location">x</a><svg><rect onclick="top.location.href=u"/></svg></body></html>`, js)
	for _, want := range []string{
		`onload="q(/*` + "\x7f" + `*/$rewriter.wrap_get_location(`,
		`crn-o="{&#34;onload&#34;:&#34;q(location,document)&#34;}"`,
		`onclick="return false"`,
		`data-on="location"`,
		`one-x="location"`,
		`<rect onclick="/*` + "\x7f" + `*/$rewriter.wrap_`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Count(got, "crn-o=") != 2 {
		t.Errorf("want originals on the two rewritten handlers only:\n%s", got)
	}
}

// A relative <base href> is resolved against the document's URL, its own
// rewritten href too (multistate.us: <base href="../"> on
// /elections/results/x came out /elections/… one level too high).
func TestRewrite_RelativeBaseOnce(t *testing.T) {
	for _, c := range []struct{ href, want string }{
		{"../", "/cyrano/https/example.com/a/b/"},
		{"sub/", "/cyrano/https/example.com/a/b/c/sub/"},
		{"../../", "/cyrano/https/example.com/a/"},
		{"..", "/cyrano/https/example.com/a/b/"},
	} {
		got := rewrite(t, `<base href="`+c.href+`"><a href="rel">x</a>`, func(cfg *Config) { cfg.BaseURL = mustURL(t, "https://example.com/a/b/c/page") })
		if !strings.Contains(got, `<base href="http://localhost:9081`+c.want+`"`) {
			t.Errorf("%q: %s", c.href, got)
		}
	}
}

// A start tag the rules leave alone goes out as written, byte for byte: its
// line breaks (equip2adapt.com: the line numbers of inline scripts below
// one shifted), its attributes' references and bytes (a legacy-encoded
// page's &copy; and windows-1251 text came back as UTF-8), its spelling.
func TestRewrite_UnchangedTagAsWritten(t *testing.T) {
	in := "<div\n  class=\"a\"\n  title='&copy; \xef\xee'\n  data-x=&amp;>x</div><svg><foreignObject X=1></foreignObject></svg>"
	got := rewrite(t, in)
	if got != in {
		t.Errorf("got  %q\nwant %q", got, in)
	}
}

// A URL attribute holding a javascript: URL has its code rewritten by the JS
// rules with JSURL (spec/JsUrl.agda), written back percent-encoded where the
// URL parser would drop or trim; read back from the originals.
func TestRewrite_JavascriptURLs(t *testing.T) {
	js := func(cfg *Config) {
		cfg.NoOriginals = false
		cfg.RewriteJSURL = func(code string) string {
			o := jsrewrite.DefaultOptions()
			o.JSURL = true
			return string(jsrewrite.Unmarked(jsrewrite.Rewrite([]byte(code), o)))
		}
	}
	got := rewrite(t, `<html><body><iframe src="javascript:'&lt;b&gt;x&lt;/b&gt;'"></iframe><a href="javascript:void(0)">v</a><a href="https://e.com/">e</a></body></html>`, js)
	for _, want := range []string{
		`src="javascript:(typeof%20$rewriter!==&#34;undefined&#34;?$rewriter:parent.$rewriter).js_url_result(this,('&lt;b>x&lt;/b>'))"`,
		`href="javascript:void(0)"`,
		`crn-o="{&#34;src&#34;:&#34;javascript:'` + `\u003cb\u003ex\u003c/b\u003e'&#34;}"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}
