package cssrewrite

import (
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/b64u"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

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

func rewrite(t *testing.T, src string) string {
	t.Helper()
	return string(Rewrite([]byte(src), Options{
		BaseURL: mustURL(t, "https://example.com/"),
		Proxy:   devProxy,
	}))
}

func b64(s string) string { return b64u.Encode(s) }

func TestUrlAbsoluteDoubleQuoted(t *testing.T) {
	got := rewrite(t, `body { background: url("https://cdn.example.com/img.png"); }`)
	want := b64("https://cdn.example.com/img.png")
	if !strings.Contains(got, want) {
		t.Errorf("got %s\nwant containing %s", got, want)
	}
	if !strings.Contains(got, `url("http://localhost:9081/?goto=`) {
		t.Errorf("quoting not preserved: %s", got)
	}
}

func TestUrlAbsoluteSingleQuoted(t *testing.T) {
	got := rewrite(t, `.x { background: url('https://cdn.example.com/a.png'); }`)
	if !strings.Contains(got, `url('http://localhost:9081/?goto=`) {
		t.Errorf("single-quote rewrite missing: %s", got)
	}
}

func TestUrlAbsoluteUnquoted(t *testing.T) {
	got := rewrite(t, `.x { background: url(https://cdn.example.com/a.png); }`)
	if !strings.Contains(got, b64("https://cdn.example.com/a.png")) {
		t.Errorf("unquoted url not rewritten: %s", got)
	}
	// Must not gain spurious quoting
	if strings.Contains(got, `url("`) || strings.Contains(got, `url('`) {
		t.Errorf("rewrite added quotes to unquoted url: %s", got)
	}
}

func TestUrlRelative(t *testing.T) {
	got := rewrite(t, `.x { background: url("/local.png"); }`)
	if !strings.Contains(got, b64("https://example.com/local.png")) {
		t.Errorf("relative url not resolved+rewritten: %s", got)
	}
}

func TestImportString(t *testing.T) {
	got := rewrite(t, `@import "https://fonts.example.com/font.css";`)
	if !strings.Contains(got, b64("https://fonts.example.com/font.css")) {
		t.Errorf("@import string url not rewritten: %s", got)
	}
}

func TestImportUrlForm(t *testing.T) {
	got := rewrite(t, `@import url(https://fonts.example.com/font2.css);`)
	if !strings.Contains(got, b64("https://fonts.example.com/font2.css")) {
		t.Errorf("@import url() not rewritten: %s", got)
	}
}

func TestImportSingleQuote(t *testing.T) {
	got := rewrite(t, `@import 'https://x.example.com/y.css';`)
	if !strings.Contains(got, `'http://localhost:9081/?goto=`) {
		t.Errorf("@import single-quote rewrite missing: %s", got)
	}
}

func TestNonImportStringLeftAlone(t *testing.T) {
	// String tokens not following @import (e.g. inside content:) shouldn't
	// be rewritten — they're not URLs.
	got := rewrite(t, `.x::before { content: "https://example.com/x"; }`)
	if strings.Contains(got, `localhost:9081/?goto=`) {
		t.Errorf("string content shouldn't be rewritten: %s", got)
	}
	if !strings.Contains(got, `"https://example.com/x"`) {
		t.Errorf("string content was unexpectedly modified: %s", got)
	}
}

func TestPreservesSurroundingDeclarations(t *testing.T) {
	in := `body { color: red; background: url("https://cdn.example.com/img.png") repeat-x #fff; }`
	got := rewrite(t, in)
	for _, snippet := range []string{
		"color: red",
		"repeat-x",
		"#fff",
		"body {",
	} {
		if !strings.Contains(got, snippet) {
			t.Errorf("expected %q in output: %s", snippet, got)
		}
	}
}

func TestMultipleUrls(t *testing.T) {
	in := `.a { background: url("https://x.example.com/1.png"); }
.b { background: url("https://x.example.com/2.png"); }`
	got := rewrite(t, in)
	if !strings.Contains(got, b64("https://x.example.com/1.png")) ||
		!strings.Contains(got, b64("https://x.example.com/2.png")) {
		t.Errorf("not all urls rewritten: %s", got)
	}
}

func TestEmptyInput(t *testing.T) {
	got := rewrite(t, ``)
	if got != "" {
		t.Errorf("empty input should produce empty output, got %q", got)
	}
}

func TestPlainCssNoUrls(t *testing.T) {
	in := `body { color: #333; font-size: 14px; }
.x:hover { opacity: 0.5; }`
	got := rewrite(t, in)
	if got != in {
		t.Errorf("URL-free CSS should pass through verbatim:\n in:  %s\n out: %s", in, got)
	}
}

func TestUrlWithSpaces(t *testing.T) {
	in := `.x { background: url(  "/a.png"  ); }`
	got := rewrite(t, in)
	if !strings.Contains(got, b64("https://example.com/a.png")) {
		t.Errorf("spaced url() not rewritten: %s", got)
	}
}

func TestDataUrlLeftAlone(t *testing.T) {
	// data: URLs aren't network-bound; urlrewrite passes them through.
	in := `.x { background: url("data:image/png;base64,iVBOR..."); }`
	got := rewrite(t, in)
	if !strings.Contains(got, "data:image/png") {
		t.Errorf("data URL stripped: %s", got)
	}
	if strings.Contains(got, `localhost:9081/?goto=`) {
		t.Errorf("data URL should not be proxified: %s", got)
	}
}

func TestAnchorLeftAlone(t *testing.T) {
	// Just an anchor reference, not a network URL.
	in := `.x { fill: url(#myFilter); }`
	got := rewrite(t, in)
	if !strings.Contains(got, "url(#myFilter)") {
		t.Errorf("anchor url() rewritten unexpectedly: %s", got)
	}
}
