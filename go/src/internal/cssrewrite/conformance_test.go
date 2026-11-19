package cssrewrite

// Conformance of the CSS rewriter with spec/Css.agda, asked live.

import (
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

// Fragments the tokenizer must get right (TS: tests/spec/css-conformance.test.ts).
// Valid UTF-8 only: the spec reads code points; invalid bytes, which the
// rewriter passes through as the origin sent them, cannot be a request field.
var cssPieces = []string{
	"url(a.png)", "url( b.png )", "URL(c.png)", `url("d.png")`, "url( 'e.png' )", `\75rl(f.png)`, `url(g\.png)`,
	`url(h\2e png)`, `url(i\(1\).png)`, "url(\"j\\\n.png\")", "url(bad k.png)", `url(l".png)`, "url(m(.png)",
	`image-set("n.png" 1x)`, `-webkit-image-set(url(o.png) 2x)`, `image-set("p" type("image/avif") 1x, "q" 2x)`,
	`@import"r.css";`, "@import url(s.css);", "@IMPORT 't.css';", `@import /* c */ "u.css";`,
	`content:"url(v.png)"`, "/* url(w.png) */", "1url(x.png)", "#url(y)", "-url(z)", "--x:url(aa.png)", "-->", "<!--",
	"url(data:image/png;base64,AA)", "url(#frag)", "url()", `url("")`, "url(http://ex.com/a b)", "url(https://cdn.example/q?a=1&b=2)",
	"url(\\\n)", "url(é.png)", `"str\"ing"`, "'unterminated\n", "{", "}", "(", ")", "[", "]", ";", ":", ",", " ", "\n", "\r\n", "\t",
	"a", "b-c", "1.5e3px", "+.5", "-.5", `url(\0 x.png)`, `url(\110000 y.png)`, `url(\`, `\`, "\x00",
}

func drawCSS(rt *rapid.T) string {
	return strings.Join(rapid.SliceOfN(rapid.SampledFrom(cssPieces), 0, 14).Draw(rt, "pieces"), "")
}

func TestSpecConformance_CSS(t *testing.T) {
	oracle := specoracle.Need(t)
	const proxy, base = "http://localhost:9081", "https://site.example/dir/page"
	baseURL, _ := url.Parse(base)
	cfg := urlrewrite.ProxyConfig{PublicURL: mustParse(proxy)}
	rapid.Check(t, func(rt *rapid.T) {
		text := drawCSS(rt)
		want, _, err := oracle.Ask("css", proxy, base, text)
		if err != nil {
			rt.Skip("oracle: " + err.Error()) // invalid UTF-8 cannot be a request field
		}
		got := RewriteText(text, func(u string) string { return urlrewrite.Rewrite(u, baseURL, cfg) })
		if got != want {
			rt.Fatalf("RewriteText(%q) = %q, spec says %q", text, got, want)
		}
		urls, _, _ := oracle.Ask("cssurls", text)
		if g := strings.Join(URLs(text), "\n"); g != urls {
			rt.Fatalf("URLs(%q) = %q, spec says %q", text, g, urls)
		}
	})
}

func mustParse(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}
