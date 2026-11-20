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

// An SVG presentation attribute that takes a <url> is CSS (spec/Attrs.agda
// cssValue), rewritten by the inline-CSS rewriter as a style attribute is,
// on any SVG element — Google Charts' clip-path="url(<page URL>#id)". Not
// on HTML elements, and not other attributes.
func TestRewrite_SVGPresentationURLAttrs(t *testing.T) {
	in := `<svg><g clip-path="url(https://site.example/page#c)" fill="url(#g)" stroke="red" opacity="url(x)"><rect mask="url(m.svg#m)" marker-start="url(#a)"/></g></svg>` +
		`<div fill="url(https://site.example/page#c)" clip-path="url(x)"></div>`
	out := rewrite(t, in, withBaseURL("https://site.example/page"), func(cfg *Config) {
		cfg.RewriteInlineCSS = func(src []byte) []byte { return []byte("CSS[" + string(src) + "]") }
	})
	for _, want := range []string{`clip-path="CSS[url(https://site.example/page#c)]"`, `fill="CSS[url(#g)]"`, `stroke="CSS[red]"`,
		`opacity="url(x)"`, `mask="CSS[url(m.svg#m)]"`, `marker-start="CSS[url(#a)]"`, `<div fill="url(https://site.example/page#c)" clip-path="url(x)">`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
}

// An iframe sandboxed without allow-scripts is marked inert (spec
// Frames.frameDest): its document gets no runtime. Other frames: frame.
func TestRewrite_FrameMarks(t *testing.T) {
	out := rewrite(t, `<iframe src="/a"></iframe><iframe sandbox src="/b"></iframe><iframe sandbox="allow-forms" src="/c"></iframe>`+
		`<iframe sandbox="allow-same-origin ALLOW-SCRIPTS" src="/d"></iframe><embed src="/e"><object data="/f"></object>`, withBaseURL("https://site.example/page"))
	for _, want := range []string{"/cyrano/https!frame/site.example/a", "/cyrano/https!inert/site.example/b", "/cyrano/https!inert/site.example/c",
		"/cyrano/https!frame/site.example/d", "/cyrano/https!frame/site.example/e", "/cyrano/https!frame/site.example/f"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
}
