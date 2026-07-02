package htmlrewrite

import (
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
		BaseURL:           mustURL(t, "https://example.com/"),
		Proxy:             devProxy,
		RewriterJSPath:      "/rewriter.js",
		HeadInjectionPath: "/head-injection",
		InjectBootstrap:   false,
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
	if !strings.Contains(got, `src="http://localhost:9081/cyrano/https/cdn.example.com/x.js"`) {
		t.Errorf("script src not rewritten: %s", got)
	}
}

func TestRewrite_LinkHref(t *testing.T) {
	got := rewrite(t, `<link rel="stylesheet" href="/styles.css">`)
	if !strings.Contains(got, `href="http://localhost:9081/cyrano/https/example.com/styles.css"`) {
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
	if !strings.Contains(got, "localhost:9081/cyrano/https/cdn.example.com/a.png 1x") {
		t.Errorf("srcset 1x candidate missing: %s", got)
	}
	if !strings.Contains(got, "localhost:9081/cyrano/https/cdn.example.com/b.png 2x") {
		t.Errorf("srcset 2x candidate missing: %s", got)
	}
}

func TestRewrite_Srcset_NoDescriptor(t *testing.T) {
	got := rewrite(t, `<img srcset="https://cdn.example.com/a.png" />`)
	if !strings.Contains(got, `srcset="http://localhost:9081/cyrano/https/cdn.example.com/a.png"`) {
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

// ── HTML_METATAG (CSP) ───────────────────────────────────────────────────────

func TestRewrite_DropsCspMeta(t *testing.T) {
	got := rewrite(t, `<meta http-equiv="content-security-policy" content="default-src 'self'">`)
	if strings.Contains(got, "content-security-policy") || strings.Contains(got, "default-src") {
		t.Errorf("CSP meta should be neutralized: %s", got)
	}
}

func TestRewrite_KeepsOtherMeta(t *testing.T) {
	got := rewrite(t, `<meta name="viewport" content="width=device-width">`)
	if !strings.Contains(got, `viewport`) || !strings.Contains(got, `width=device-width`) {
		t.Errorf("non-CSP meta should pass through: %s", got)
	}
}

// ── HTML_SANDBOX ─────────────────────────────────────────────────────────────

func TestRewrite_IframeSandboxAddsAllowSameOrigin(t *testing.T) {
	got := rewrite(t, `<iframe src="/x" sandbox="allow-scripts"></iframe>`)
	if !strings.Contains(got, `sandbox="allow-scripts allow-same-origin"`) {
		t.Errorf("sandbox not augmented: %s", got)
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

// ── HTML_PROCESS_SERVER_COOKIES / HTML_FETCH_COOKIES ─────────────────────────

func TestRewrite_ScriptOnloadInjected(t *testing.T) {
	got := rewrite(t, `<script src="/x.js"></script>`, withInject)
	if !strings.Contains(got, `onload="$rewriter.process_server_cookies();"`) {
		t.Errorf("script onload hook missing: %s", got)
	}
}

func TestRewrite_IframeOnloadInjected(t *testing.T) {
	got := rewrite(t, `<iframe src="/x"></iframe>`, withInject)
	if !strings.Contains(got, `$rewriter.process_server_cookies();`) {
		t.Errorf("iframe onload hook missing: %s", got)
	}
}

func TestRewrite_ImgOnloadInjected(t *testing.T) {
	got := rewrite(t, `<img src="/x.png" />`, withInject)
	if !strings.Contains(got, `onload="$rewriter.fetch_cookies(this);"`) {
		t.Errorf("img onload hook missing: %s", got)
	}
}

func TestRewrite_ImgOnloadComposed(t *testing.T) {
	got := rewrite(t, `<img src="/x.png" onload="userCode()" />`, withInject)
	if !strings.Contains(got, "fetch_cookies") || !strings.Contains(got, "userCode()") {
		t.Errorf("img onload should compose with existing handler: %s", got)
	}
}

func TestRewrite_ScriptOnloadDoesNotDoubleInject(t *testing.T) {
	got := rewrite(t, `<script src="/x.js" onload="$rewriter.process_server_cookies();"></script>`)
	if strings.Count(got, "process_server_cookies") != 1 {
		t.Errorf("onload double-injected: %s", got)
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
	idxPageScript := strings.Index(got, `<script src="http://localhost:9081/cyrano/https/example.com/page.js"`)
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
	count := strings.Count(got, "$rewriter_init")
	if count != 1 {
		t.Errorf("bootstrap injected %d times, want exactly 1: %s", count, got)
	}
}

func TestRewrite_BootstrapSetCookiesInjected(t *testing.T) {
	// PageCookies must be emitted as $rewriter.set_cookies([...]) in the
	// inline bootstrap script, after set_location.
	withCookies := func(cfg *Config) {
		cfg.InjectBootstrap = true
		cfg.PageCookies = []string{"session=tok123; Path=/", "pref=dark; Path=/"}
	}
	got := rewrite(t, `<html><head></head><body></body></html>`, withCookies)
	if !strings.Contains(got, `$rewriter.set_cookies(`) {
		t.Errorf("set_cookies call missing: %s", got)
	}
	if !strings.Contains(got, `session=tok123`) {
		t.Errorf("session cookie missing in set_cookies: %s", got)
	}
	if !strings.Contains(got, `pref=dark`) {
		t.Errorf("pref cookie missing in set_cookies: %s", got)
	}
	// set_cookies must come AFTER set_location.
	idxLoc := strings.Index(got, "set_location")
	idxCookies := strings.Index(got, "set_cookies")
	if idxLoc < 0 || idxCookies < 0 {
		t.Fatalf("set_location=%d set_cookies=%d", idxLoc, idxCookies)
	}
	if idxCookies < idxLoc {
		t.Errorf("set_cookies emitted before set_location")
	}
}

func TestRewrite_BootstrapSetCookiesOmittedWhenEmpty(t *testing.T) {
	// No PageCookies → no set_cookies call (keeps bootstrap compact).
	got := rewrite(t, `<html><head></head><body></body></html>`, withInject)
	if strings.Contains(got, "set_cookies") {
		t.Errorf("set_cookies should not appear when PageCookies is empty: %s", got)
	}
}

// ── End-to-end: full page round-trip ────────────────────────────────────────

func TestRewrite_FullPage(t *testing.T) {
	in := `<!doctype html><html><head><title>X</title>` +
		`<meta http-equiv="content-security-policy" content="x">` +
		`<link rel="stylesheet" href="/style.css" integrity="sha-x">` +
		`</head><body><a href="/about">about</a><img src="/p.png"/></body></html>`
	got := rewrite(t, in, withInject)

	// CSP meta gone
	if strings.Contains(got, "content-security-policy") {
		t.Errorf("CSP not stripped: %s", got)
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
		"localhost:9081/cyrano/https/example.com/style.css",
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

// ── HTML_IFRAME_INJECTION ────────────────────────────────────────────────────

func TestRewrite_IframeInjectionOnloadAppended(t *testing.T) {
	got := rewrite(t, `<iframe src="/embed"></iframe>`, withInject)
	if !strings.Contains(got, `$rewriter.append_rewrite_script_into_iframe(this)`) {
		t.Errorf("iframe injection hook missing: %s", got)
	}
}

func TestRewrite_IframeInjectionComposesWithCookieHook(t *testing.T) {
	got := rewrite(t, `<iframe src="/embed"></iframe>`, withInject)
	if !strings.Contains(got, `$rewriter.process_server_cookies()`) {
		t.Errorf("cookie hook missing from iframe onload: %s", got)
	}
	if !strings.Contains(got, `$rewriter.append_rewrite_script_into_iframe(this)`) {
		t.Errorf("injection hook missing from iframe onload: %s", got)
	}
	// cookie hook runs first so $rewriter state is ready before injection
	cookieIdx := strings.Index(got, "process_server_cookies")
	injectionIdx := strings.Index(got, "append_rewrite_script_into_iframe")
	if cookieIdx > injectionIdx {
		t.Errorf("cookie hook must appear before injection hook: %s", got)
	}
}

func TestRewrite_IframeInjectionPreservesUserOnload(t *testing.T) {
	got := rewrite(t, `<iframe src="/embed" onload="userHandler()"></iframe>`, withInject)
	if !strings.Contains(got, "userHandler()") {
		t.Errorf("user onload handler lost: %s", got)
	}
	if !strings.Contains(got, `$rewriter.append_rewrite_script_into_iframe(this)`) {
		t.Errorf("injection hook missing when user onload present: %s", got)
	}
}

func TestRewrite_IframeInjectionNoDoubleInject(t *testing.T) {
	got := rewrite(t, `<iframe src="/embed" onload="$rewriter.append_rewrite_script_into_iframe(this);"></iframe>`)
	if strings.Count(got, "append_rewrite_script_into_iframe") != 1 {
		t.Errorf("injection hook double-injected: %s", got)
	}
}

func TestRewrite_IframeInjectionNotAddedWithoutSrc(t *testing.T) {
	// iframes without src= (e.g. srcdoc or JS-populated) — no onload injection
	got := rewrite(t, `<iframe srcdoc="<p>hello</p>"></iframe>`)
	if strings.Contains(got, "append_rewrite_script_into_iframe") {
		t.Errorf("injection hook should not be added to iframe without src: %s", got)
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
			out[len(src)] = 0 // simulate the tdewolff NUL sentinel
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

// ── <noscript> content rewriting ─────────────────────────────────────────

func TestRewrite_Noscript_URLsRewritten(t *testing.T) {
	in := `<html><head><noscript><link rel="stylesheet" href="//example.com/noscript.css"></noscript></head></html>`
	got := rewrite(t, in)
	if strings.Contains(got, "//example.com/") {
		t.Errorf("noscript link href was not rewritten:\n%s", got)
	}
	if !strings.Contains(got, "localhost:9081") {
		t.Errorf("noscript link href not proxified:\n%s", got)
	}
}

func TestRewrite_Noscript_AbsoluteURLRewritten(t *testing.T) {
	in := `<html><head><noscript><link rel="stylesheet" href="https://example.com/a.css"></noscript></head></html>`
	got := rewrite(t, in)
	if strings.Contains(got, "https://example.com/") {
		t.Errorf("absolute URL inside noscript was not rewritten:\n%s", got)
	}
}

func TestRewrite_Noscript_StructurePreserved(t *testing.T) {
	in := `<html><head><noscript><link rel="stylesheet" href="//example.com/a.css"></noscript><title>T</title></head></html>`
	got := rewrite(t, in)
	if !strings.Contains(got, "<noscript>") || !strings.Contains(got, "</noscript>") {
		t.Errorf("<noscript> tags not preserved:\n%s", got)
	}
	if !strings.Contains(got, "<title>T</title>") {
		t.Errorf("content after </noscript> missing:\n%s", got)
	}
}

// ── ChallengePathPrefix injection ────────────────────────────────────────

func TestRewrite_ChallengePathPrefix_InjectsScript(t *testing.T) {
	// ChallengePathPrefix causes a tiny inline script to be injected right
	// after <head> so challenge pages can load orchestrate scripts through
	// the proxy without the full $rewriter bootstrap.
	in := `<html><head><title>challenge</title></head><body></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.ChallengePathPrefix = "/cyrano/https/claude.ai"
	})
	if !strings.Contains(got, `HTMLScriptElement.prototype`) {
		t.Errorf("challenge path fix script not injected: %s", got)
	}
	if !strings.Contains(got, `"/cyrano/https/claude.ai"`) {
		t.Errorf("challenge path prefix not present in injected script: %s", got)
	}
}

func TestRewrite_ChallengePathPrefix_InjectedBeforePageContent(t *testing.T) {
	// The script must appear before the page's own inline scripts so the
	// src setter is patched before the challenge JS runs.
	in := `<html><head><script>var x=1;</script></head><body></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.ChallengePathPrefix = "/cyrano/https/claude.ai"
	})
	fixIdx := strings.Index(got, "HTMLScriptElement.prototype")
	pageIdx := strings.Index(got, "var x=1")
	if fixIdx == -1 {
		t.Fatalf("challenge fix script not found in output: %s", got)
	}
	if fixIdx > pageIdx {
		t.Errorf("challenge fix script must appear before page inline scripts: fix@%d page@%d", fixIdx, pageIdx)
	}
}

func TestRewrite_ChallengePathPrefix_NoBsotrapOnloadHooks(t *testing.T) {
	// When only ChallengePathPrefix is set (no InjectBootstrap), $rewriter.*
	// onload hooks must NOT be added — $rewriter is undefined on challenge pages.
	in := `<html><head></head><body><script src="/x.js"></script><iframe src="/f"></iframe><img src="/i.png" /></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.ChallengePathPrefix = "/cyrano/https/claude.ai"
	})
	if strings.Contains(got, "$rewriter.process_server_cookies") {
		t.Errorf("process_server_cookies hook must not be added without InjectBootstrap: %s", got)
	}
	if strings.Contains(got, "$rewriter.fetch_cookies") {
		t.Errorf("fetch_cookies hook must not be added without InjectBootstrap: %s", got)
	}
	if strings.Contains(got, "$rewriter.append_rewrite_script_into_iframe") {
		t.Errorf("iframe injection hook must not be added without InjectBootstrap: %s", got)
	}
}

func TestRewrite_ChallengePathPrefix_WrapsWindowLocation(t *testing.T) {
	// The injected script must define window.$rewriter with wrap_get_location
	// returning a fake location (_wl) that exposes upstream hostname/href/etc.
	// Location.prototype patching is not used — Location properties are
	// non-configurable own getters on the instance and cannot be overridden at
	// runtime. The JS AST rewriter transforms every location.* access into
	// $rewriter.wrap_get_location(location).* so the shim's return value is
	// the interception point.
	in := `<html><head><title>cf challenge</title></head><body></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.ChallengePathPrefix = "/cyrano/https/claude.ai"
	})
	if !strings.Contains(got, `wrap_get_location`) {
		t.Errorf("wrap_get_location not present in injected script: %s", got)
	}
	// wrap_location must return {location:_wl} so that the AST-rewritten form
	// of `window.location.hostname` — which is
	// `$rewriter.wrap_location({obj:window}).location.hostname` — resolves
	// through _wl rather than through the real proxy location.
	if !strings.Contains(got, `{location:_wl}`) {
		t.Errorf("wrap_location must return {location:_wl}: %s", got)
	}
	if !strings.Contains(got, `window.$rewriter`) {
		t.Errorf("$rewriter shim not defined in injected script: %s", got)
	}
	if !strings.Contains(got, `_hostname`) {
		t.Errorf("upstream hostname not referenced in injected script: %s", got)
	}
	if !strings.Contains(got, `document,'URL'`) {
		t.Errorf("document.URL patch not injected: %s", got)
	}
	if !strings.Contains(got, `document,'baseURI'`) {
		t.Errorf("document.baseURI patch not injected: %s", got)
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

func TestRewrite_ChallengePathPrefix_PatchesDocumentCookie(t *testing.T) {
	// When ChallengeCookiePrefix is set the challenge shim must patch
	// document.cookie: setter prepends the prefix so the Director's existing
	// prefix-strip logic forwards the plain cookie name to the upstream; getter
	// strips the prefix so page JS sees cookie names as they appear on the
	// real site.
	in := `<html><head></head><body></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.ChallengePathPrefix = "/cyrano/https/claude.ai"
		cfg.ChallengeCookiePrefix = "__crn__claude_ai__"
	})
	if !strings.Contains(got, `"__crn__claude_ai__"`) {
		t.Errorf("cookie prefix not embedded in injected script: %s", got)
	}
	if !strings.Contains(got, `document,'cookie'`) {
		t.Errorf("document.cookie patch not injected: %s", got)
	}
	// Getter must strip the prefix; setter must prepend it.
	if !strings.Contains(got, `_cp+v`) {
		t.Errorf("cookie setter must prepend prefix (_cp+v): %s", got)
	}
	if !strings.Contains(got, `t.slice(_cp.length)`) {
		t.Errorf("cookie getter must strip prefix (t.slice(_cp.length)): %s", got)
	}
}

func TestRewrite_ChallengePathPrefix_NoCookiePatchWithoutPrefix(t *testing.T) {
	// When ChallengeCookiePrefix is empty, no document.cookie patch must be
	// injected — patching with an empty prefix would corrupt all cookie names.
	in := `<html><head></head><body></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.ChallengePathPrefix = "/cyrano/https/claude.ai"
		// ChallengeCookiePrefix intentionally not set
	})
	if strings.Contains(got, `document,'cookie'`) {
		t.Errorf("document.cookie patch must not be injected without ChallengeCookiePrefix: %s", got)
	}
}

func TestRewrite_ChallengePathPrefix_FProxiesCrossOriginURL(t *testing.T) {
	// _f must route any http/https URL through the proxy, not just same-upstream
	// and absolute-path URLs. Turnstile api.js is loaded from
	// challenges.cloudflare.com — a completely different origin than the page
	// upstream. The shim must rewrite it to go through the proxy.
	in := `<html><head></head><body></body></html>`
	got := rewrite(t, in, func(cfg *Config) {
		cfg.ChallengePathPrefix = "/cyrano/https/claude.ai"
	})
	// The _f function must contain the general http/https proxifier logic.
	// Check for the host comparison guard that prevents double-proxying.
	if !strings.Contains(got, `_fh!==_rl.host`) {
		t.Errorf("_f missing cross-origin proxifier (_fh!==_rl.host guard): %s", got)
	}
	// And the /cyrano/ path construction from _rl.origin.
	if !strings.Contains(got, `_rl.origin+'/cyrano/'`) {
		t.Errorf("_f missing cross-origin proxifier (_rl.origin+'/cyrano/'): %s", got)
	}
}
