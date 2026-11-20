package htmlrewrite

// Conformance of the URL-attribute table and URL lists with
// spec/Attrs.agda, asked live; the namespace tracking the table is applied
// with (TS: tests/spec/attrs-conformance.test.ts).

import (
	"bytes"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

// AttrTags and AttrNames: the vocabulary both runtimes' tables are compared
// with the spec's over (every pair the spec names, and more).
var AttrTags = strings.Fields("a area audio base blockquote body button del embed form frame iframe image img input ins link object q script source table tbody td tfoot th thead tr track video use feimage svg div span p meta html applet portal fencedframe g rect path text pattern")
var AttrNames = strings.Fields("src href xlink:href action formaction data poster background ping attributionsrc srcset imagesrcset cite longdesc lowsrc codebase manifest archive classid usemap style id content dynsrc itemid clip-path cursor fill filter marker-start marker-mid marker-end mask stroke stroke-width opacity CLIP-PATH")

func TestSpecConformance_AttrKind(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, ns := range []string{"html", "svg"} {
		for _, tag := range AttrTags {
			for _, a := range AttrNames {
				want, _, err := oracle.Ask("attrkind", ns, tag, a)
				if err != nil {
					t.Fatalf("oracle: %v", err)
				}
				if got := URLAttrKind(ns == "svg", tag, a).String(); got != want {
					t.Errorf("URLAttrKind(%s, %s, %s) = %s, spec says %s", ns, tag, a, got, want)
				}
			}
		}
	}
}

func TestSpecConformance_URLList(t *testing.T) {
	oracle := specoracle.Need(t)
	pieces := []string{" ", "\t", "\n", "\f", "\r", "  ", "/a", "b/c", "https://x.example/p", "//h.example/", "?q", "#f", "http://[::1", "%zz", "é", "data:,x"}
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		v := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 0, 8).Draw(rt, "pieces"), "")
		want, _, err := oracle.Ask("urllist", proxy, base, v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		pu, _ := url.Parse(proxy)
		bu, _ := url.Parse(base)
		cfg := urlrewrite.ProxyConfig{PublicURL: pu}
		if got := RewriteURLList(v, func(u string) string { return urlrewrite.Rewrite(u, bu, cfg) }); got != want {
			rt.Fatalf("RewriteURLList(%q) = %q, spec says %q", v, got, want)
		}
	})
}

// Which elements the server takes for SVG: the table is applied by namespace.
func TestAttrNamespaces(t *testing.T) {
	base, _ := url.Parse("https://site.example/d/")
	cfg := Config{BaseURL: base, Proxy: urlrewrite.ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "p:1"}}, NoOriginals: true}
	P := "http://p:1/cyrano/https/site.example/"
	for _, c := range []struct{ in, want string }{
		{`<svg><image href="/i.png"></image></svg>`, `<svg><image href="` + P + `i.png"></image></svg>`},
		{`<svg><a xlink:href="/x">x</a></svg>`, `<svg><a xlink:href="` + P + `x">x</a></svg>`},
		{`<a xlink:href="/x">x</a>`, `<a xlink:href="/x">x</a>`},                  // HTML: not a URL
		{`<image src="/i.png">`, `<image src="` + P + `i.png">`},                  // HTML: an img
		{`<svg><img src="/i.png"></svg>`, `<svg><img src="` + P + `i.png"></svg>`}, // breaks out
		{`<svg><foreignObject><iframe src="/f"></iframe></foreignObject></svg>`, `<svg><foreignobject><iframe src="http://p:1/cyrano/https!frame/site.example/f"></iframe></foreignobject></svg>`}, // a frame's URL is marked
		{`<svg><use href="/u#x"/></svg><use href="/v">`, `<svg><use href="` + P + `u#x" /></svg><use href="/v">`},
		{`<a ping="/p1 /p2" attributionsrc="/r">a</a>`, `<a ping="` + P + `p1 ` + P + `p2" attributionsrc="` + P + `r">a</a>`},
		{`<q cite="c">q</q><td background="/b.png">`, `<q cite="c">q</q><td background="` + P + `b.png">`},
	} {
		var out bytes.Buffer
		if err := Rewrite(&out, strings.NewReader(c.in), cfg); err != nil {
			t.Fatal(err)
		}
		if out.String() != c.want {
			t.Errorf("%s\n got %s\nwant %s", c.in, out.String(), c.want)
		}
	}
}

func TestSpecConformance_URLDest(t *testing.T) {
	oracle := specoracle.Need(t)
	rels := []string{"", "stylesheet", "STYLESHEET", "alternate stylesheet", "preload", "prefetch", "modulepreload", "icon", "preload prefetch", "dns-prefetch"}
	ases := []string{"-", "script", "SCRIPT", "style", "font", "image", "", "fetch", "Fetch"}
	rapid.Check(t, func(rt *rapid.T) {
		ns := rapid.SampledFrom([]string{"html", "svg"}).Draw(rt, "ns")
		tag := rapid.SampledFrom([]string{"script", "link", "img", "a", "image", "use"}).Draw(rt, "tag")
		attr := rapid.SampledFrom([]string{"src", "href", "xlink:href", "srcset"}).Draw(rt, "attr")
		rel := rapid.SampledFrom(rels).Draw(rt, "rel")
		as := rapid.SampledFrom(ases).Draw(rt, "as")
		lrel := strings.ToLower(rel)
		want, _, err := oracle.Ask("urldest", ns, tag, attr, lrel, strings.ToLower(as))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := string(URLDest(ns == "svg", tag, attr, strings.Fields(lrel), strings.ToLower(as), as != "-"))
		if got == "" {
			got = "-"
		}
		if got != want {
			rt.Fatalf("URLDest(%s %s %s rel=%q as=%q) = %s, spec says %s", ns, tag, attr, rel, as, got, want)
		}
	})
}

func TestSpecConformance_Crossorigin(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		html := rapid.Bool().Draw(rt, "html")
		tag := rapid.SampledFrom([]string{"link", "script", "img", "image", "video"}).Draw(rt, "tag")
		rel := rapid.SampledFrom([]string{"", "preload", "Preload", "prefetch", "stylesheet", "modulepreload", "preload x"}).Draw(rt, "rel")
		as := rapid.SampledFrom([]string{"", "font", "FONT", "script", "style"}).Draw(rt, "as")
		b := "0"
		if html {
			b = "1"
		}
		want, _, err := oracle.Ask("crossorigin", b, tag, rel, as)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := "keep"
		if v, ok := crossoriginValue(html, tag, rel, as); ok {
			got = v
		}
		if got != want {
			rt.Fatalf("crossoriginValue(%v, %s, %q, %q) = %s, spec %s", html, tag, rel, as, got, want)
		}
	})
}
