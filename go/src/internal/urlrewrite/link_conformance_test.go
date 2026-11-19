package urlrewrite

// Conformance of RewriteLinkHeader with spec/Link.agda, asked live (the
// spec against Chromium: ts/client/tests/spec/link-vs-chromium).

import (
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

// The pieces of link-vs-chromium's headers, and more.
var linkParams = []string{"; rel=preload", `;rel="preload"`, "; REL=PRELOAD", `; rel="prefetch preload"`, "; rel=prefetch", "; rel=modulepreload",
	"; as=image", `; AS="IMAGE"`, `; as="im\age"`, "; as=font", "; as=script", `; title="a, </i/x>; rel=preload; as=image"`, "; title=a b",
	`; title="x\"y,z"`, ";", ";;", "; =x", `; x="unterminated`, "; integrity=sha384-AAAA", `; Integrity="sha384-B"`, "; crossorigin=anonymous",
	"; crossorigin", `; crossorigin = "anonymous"`, `; imagesrcset="/s/1 1x, https://cdn.example/s2 2x"`, "; imagesrcset=c.jpg", "; imagesizes=50vw",
	" ; rel = preload ", "; title='a,b'", `; t="q"junk`, "; nonce=abc==", "; nopush"}

func TestSpecConformance_LinkHeader(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		n := rapid.IntRange(1, 4).Draw(rt, "n")
		var vs []string
		for k := 0; k < n; k++ {
			lead := rapid.SampledFrom([]string{"", " ", "x", "\t"}).Draw(rt, "lead")
			target := rapid.SampledFrom([]string{"/i/1", " /i/2 ", "https://cdn.example/a.js", "rel/x.css", "//h.example/p", "http://[::1", "?q"}).Draw(rt, "target")
			trail := rapid.SampledFrom([]string{"", "x", " "}).Draw(rt, "trail")
			ps := strings.Join(rapid.SliceOfN(rapid.SampledFrom(linkParams), 0, 5).Draw(rt, "params"), "")
			vs = append(vs, lead+"<"+target+">"+trail+ps)
		}
		h := strings.Join(vs, rapid.SampledFrom([]string{",", ", ", " ,"}).Draw(rt, "sep"))
		want, _, err := oracle.Ask("link", proxy, base, h)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		if got := RewriteLinkHeader(h, baseURL, proxyConfig(rt, proxy)); got != want {
			rt.Fatalf("RewriteLinkHeader(%q) on %s\n got  %q\n spec %q", h, base, got, want)
		}
	})
}

// Shop Pay: a modulepreload's integrity named the origin's bytes, not the
// proxied ones, and the module was blocked; its crossorigin mismatched the
// <script>'s use-credentials.
func TestRewriteLinkHeader_IntegrityAndCrossorigin(t *testing.T) {
	cfg := ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "p:1"}}
	base, _ := url.Parse("https://shop.app/accounts/pre_auth")
	in := `<https://cdn.example/E.js>; rel=modulepreload; as=script; crossorigin=anonymous; integrity=sha384-UWWf; nonce=N; nopush, </f.woff2>; rel=preload; as=font; crossorigin=anonymous`
	want := `<http://p:1/cyrano/https/cdn.example/E.js>; rel=modulepreload; as=script; crossorigin=use-credentials; nonce=N; nopush, <http://p:1/cyrano/https/shop.app/f.woff2>; rel=preload; as=font; crossorigin=anonymous`
	if got := RewriteLinkHeader(in, base, cfg); got != want {
		t.Errorf("\n got  %s\n want %s", got, want)
	}
}
