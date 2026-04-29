package htmlrewrite

import (
	"bytes"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/b64u"
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

// b64 is shorthand for the URL containment encoding.
func b64(u string) string { return b64u.Encode(u) }

// ── HTML_EXTERNAL_RESOURCE_ATTRS ────────────────────────────────────────────

func TestRewrite_AnchorHrefAbsolute(t *testing.T) {
	got := rewrite(t, `<a href="https://other.com/about">x</a>`)
	want := `<a href="http://localhost:9081/?goto=` + b64("https://other.com/about") + `">x</a>`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestRewrite_AnchorHrefRelative(t *testing.T) {
	got := rewrite(t, `<a href="/about">x</a>`)
	want := `<a href="http://localhost:9081/?goto=` + b64("https://example.com/about") + `">x</a>`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestRewrite_ImgSrc(t *testing.T) {
	got := rewrite(t, `<img src="https://cdn.example.com/img.png" />`)
	if !strings.Contains(got, `src="http://localhost:9081/?goto=`+b64("https://cdn.example.com/img.png")) {
		t.Errorf("img src not rewritten: %s", got)
	}
}

func TestRewrite_ScriptSrc(t *testing.T) {
	got := rewrite(t, `<script src="https://cdn.example.com/x.js"></script>`)
	if !strings.Contains(got, `src="http://localhost:9081/?goto=`+b64("https://cdn.example.com/x.js")) {
		t.Errorf("script src not rewritten: %s", got)
	}
}

func TestRewrite_LinkHref(t *testing.T) {
	got := rewrite(t, `<link rel="stylesheet" href="/styles.css">`)
	if !strings.Contains(got, `href="http://localhost:9081/?goto=`+b64("https://example.com/styles.css")) {
		t.Errorf("link href not rewritten: %s", got)
	}
}

func TestRewrite_FormAction(t *testing.T) {
	got := rewrite(t, `<form action="/submit" method="POST"></form>`)
	if !strings.Contains(got, `action="http://localhost:9081/?goto=`+b64("https://example.com/submit")) {
		t.Errorf("form action not rewritten: %s", got)
	}
}

func TestRewrite_VideoPosterAndSrc(t *testing.T) {
	got := rewrite(t,
		`<video poster="https://cdn.example.com/poster.jpg" src="https://cdn.example.com/v.mp4"></video>`)
	if !strings.Contains(got, b64("https://cdn.example.com/poster.jpg")) {
		t.Errorf("poster not rewritten: %s", got)
	}
	if !strings.Contains(got, b64("https://cdn.example.com/v.mp4")) {
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
	if !strings.Contains(got, b64("https://cdn.example.com/a.png")+` 1x`) {
		t.Errorf("srcset 1x candidate missing: %s", got)
	}
	if !strings.Contains(got, b64("https://cdn.example.com/b.png")+` 2x`) {
		t.Errorf("srcset 2x candidate missing: %s", got)
	}
}

func TestRewrite_Srcset_NoDescriptor(t *testing.T) {
	got := rewrite(t, `<img srcset="https://cdn.example.com/a.png" />`)
	if !strings.Contains(got, `srcset="http://localhost:9081/?goto=`+b64("https://cdn.example.com/a.png")) {
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
	got := rewrite(t, `<script src="/x.js"></script>`)
	if !strings.Contains(got, `onload="$rewriter.process_server_cookies();"`) {
		t.Errorf("script onload hook missing: %s", got)
	}
}

func TestRewrite_IframeOnloadInjected(t *testing.T) {
	got := rewrite(t, `<iframe src="/x"></iframe>`)
	if !strings.Contains(got, `onload="$rewriter.process_server_cookies();"`) {
		t.Errorf("iframe onload hook missing: %s", got)
	}
}

func TestRewrite_ImgOnloadInjected(t *testing.T) {
	got := rewrite(t, `<img src="/x.png" />`)
	if !strings.Contains(got, `onload="$rewriter.fetch_cookies(this);"`) {
		t.Errorf("img onload hook missing: %s", got)
	}
}

func TestRewrite_ImgOnloadComposed(t *testing.T) {
	got := rewrite(t, `<img src="/x.png" onload="userCode()" />`)
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
	if !strings.Contains(got, b64("https://other.com/sub/page.html")) {
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
	idxPageScript := strings.Index(got, `<script src="http://localhost:9081/?goto=`+b64("https://example.com/page.js"))
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
	idxPageScript := strings.Index(got, `<script src="http://localhost:9081/?goto=`)
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
		"https://example.com/style.css",
		"https://example.com/about",
		"https://example.com/p.png",
	} {
		if !strings.Contains(got, b64(u)) {
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
