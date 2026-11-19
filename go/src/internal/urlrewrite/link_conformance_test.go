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
	want := `<http://p:1/cyrano/https!js/cdn.example/E.js>; rel=modulepreload; as=script; crossorigin=use-credentials; nonce=N; nopush, <http://p:1/cyrano/https/shop.app/f.woff2>; rel=preload; as=font; crossorigin=anonymous`
	if got := RewriteLinkHeader(in, base, cfg); got != want {
		t.Errorf("\n got  %s\n want %s", got, want)
	}
}

// Conformance of RewriteRefresh with spec/Refresh.agda (the spec against
// Chromium: ts/client/tests/spec/refresh-vs-chromium).
func TestSpecConformance_Refresh(t *testing.T) {
	oracle := specoracle.Need(t)
	times := []string{"0", "0.", ".", "0.7", " 0", "00", "", "x", "0x", "-0", ".5", "0.5.5", "+0", "\f0", "5"}
	seps := []string{"", ";", ",", " ", " ; ", ";;", "\t,", "; ,"}
	urls := []string{"url=/t/a", "URL = '/t/b' tail", "ux/t/c", "url /t/e", "'/t/f'", "\"/t/g", "/t/h\"x", "urL=\"/t/i\"", "",
		"  ", "url=", "url='", "url=?q", "//other.example/k", "'/t/l'x'", "''", "url\f=/t/n", "https://x.example/p q", "url=\"https://y.example/\""}
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		v := rapid.SampledFrom(times).Draw(rt, "t") + rapid.SampledFrom(seps).Draw(rt, "s") + rapid.SampledFrom(urls).Draw(rt, "u")
		want, _, err := oracle.Ask("refresh", proxy, base, v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		if got := RewriteRefresh(v, baseURL, proxyConfig(rt, proxy)); got != want {
			rt.Fatalf("RewriteRefresh(%q) on %s\n got  %q\n spec %q", v, base, got, want)
		}
	})
}

// Conformance of SplitWSOrigin with spec/WsOrigin.agda split (TS:
// tests/spec/ws-origin-conformance.test.ts checks the runtime's marker,
// and the round trip on the spec itself).
func TestSpecConformance_WSOrigin(t *testing.T) {
	oracle := specoracle.Need(t)
	pieces := []string{"a=1", "&", "b=", "__cyrano_ws_origin=", "__cyrano_ws_origin=https%3A%2F%2Fs.example", "x__cyrano_ws_origin=1",
		"https%3A%2F%2Fo.example%3A8443", "%26", "=", "c", "__cyrano_ws_origin", "__cyrano_ws_origin=ftp%3A%2F%2Fx", "__cyrano_ws_origin=%zz"}
	rapid.Check(t, func(rt *rapid.T) {
		q := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 0, 5).Draw(rt, "pieces"), "")
		want, _, err := oracle.Ask("wssplit", q)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		rest, origin, had := SplitWSOrigin(q)
		if want == "none" {
			if rest != q || origin != "" || !had {
				rt.Fatalf("SplitWSOrigin(%q) = %q %q %v, spec: no marker", q, rest, origin, had)
			}
			return
		}
		f := strings.SplitN(want, "\t", 3)
		wantOrigin := ""
		if v, err := url.QueryUnescape(f[2]); err == nil {
			if a, res := parseRef(nil, v); res == parsedURL && (a.scheme == "http" || a.scheme == "https") {
				wantOrigin = a.originText()
			}
		}
		if rest != f[1] || had != (f[0] == "1") || origin != wantOrigin {
			rt.Fatalf("SplitWSOrigin(%q) = %q %q %v, spec %q", q, rest, origin, had, want)
		}
	})
}

// Conformance of UnproxyQueryValues with spec/Query.agda.
func TestSpecConformance_UnproxyQuery(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		enc := func(s string) string { return url.QueryEscape(s) }
		values := []string{
			enc(proxy + "/cyrano/https/a.example/p?q=1"), proxy + "/cyrano/https/a.example/x", enc(proxy + "/cyrano/https!js/b.example/s.js"),
			enc(proxy + "/cyrano/http/c.example/%C3%A9"), enc(proxy + "/cyrano/https/d.example/é"), "plain", "a+b", "%zz", "%", "",
			enc("https://e.example/cyrano/https/f.example/"), enc(proxy + "/other"), enc(proxy + "/cyrano/https/"), "cyrano",
			strings.ReplaceAll(enc(proxy+"/cyrano/https/g.example/a b"), "+", "%20"),
		}
		var parts []string
		for k := rapid.IntRange(0, 4).Draw(rt, "n"); k > 0; k-- {
			switch rapid.IntRange(0, 3).Draw(rt, "form") {
			case 0:
				parts = append(parts, "u="+rapid.SampledFrom(values).Draw(rt, "v"))
			case 1:
				parts = append(parts, rapid.SampledFrom(values).Draw(rt, "bare"))
			case 2:
				parts = append(parts, "")
			default:
				parts = append(parts, "n="+rapid.SampledFrom(values).Draw(rt, "v2")+"="+rapid.SampledFrom(values).Draw(rt, "v3"))
			}
		}
		q := strings.Join(parts, "&")
		want, _, err := oracle.Ask("unproxyquery", proxy, q)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := UnproxyQueryValues(q, proxyConfig(rt, proxy)); got != want {
			rt.Fatalf("UnproxyQueryValues(%q)\n got  %q\n spec %q", q, got, want)
		}
	})
}
