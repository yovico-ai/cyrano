package htmlrewrite

import (
	"strings"
	"testing"
)

// SVG elements that refer by href / xlink:href are rewritten as the client
// does (svgUrlAttrs in ts/client/src/patches/url-attribute-map.ts); a
// fragment-only reference stays as written.
func TestRewrite_SVGHref(t *testing.T) {
	in := `<svg><image xlink:href="https://cdn.example/a.png"/><image href="/b.png"/><use href="#icon"/>` +
		`<feImage href="https://cdn.example/f.png"/><a xlink:href="https://other.example/">x</a></svg>`
	out := rewrite(t, in, withBaseURL("https://site.example/page"))
	for _, want := range []string{"/cyrano/https/cdn.example/a.png", "/cyrano/https/site.example/b.png", `href="#icon"`,
		"/cyrano/https/cdn.example/f.png", "/cyrano/https/other.example/"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
}
