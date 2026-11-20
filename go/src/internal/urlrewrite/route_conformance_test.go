package urlrewrite

// Conformance of RefererRoute with spec/Route.agda refererRoute.

import (
	"net/url"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_RefererRoute(t *testing.T) {
	oracle := specoracle.Need(t)
	proxies := []string{"http://localhost:9081", "https://p.example", "http://P.Example:8080"}
	referers := []string{
		"/cyrano/https/github.com/", "/cyrano/http/h.example:8080/a/b?q#f", "/cyrano/https/u:p@H.example:443/page", "/cyrano/https!origin/h.example/x",
		"/cyrano/https!js/cdn.example/a.js", "/cyrano/wss/h.example/", "/cyrano/ws/h.example/", "/cyrano/file/etc/passwd", "/cyrano/", "/", "/cyrano/https/",
		"/cyrano/https/%5B::1%5D:81/", "/cyrano/https/./x", "/cyrano/https/h%2Eexample/", "/cyrano/https/bad host/", "/cyrano/HTTPS/h.example/",
	}
	rapid.Check(t, func(rt *rapid.T) {
		p := rapid.SampledFrom(proxies).Draw(rt, "proxy")
		origin := rapid.SampledFrom([]string{p, "http://evil.example", "https://localhost:9081", "http://LOCALHOST:9081"}).Draw(rt, "referer origin")
		ref := origin + rapid.SampledFrom(referers).Draw(rt, "referer path")
		if rapid.IntRange(0, 9).Draw(rt, "empty") == 0 {
			ref = rapid.SampledFrom([]string{"", "nonsense", "http://"}).Draw(rt, "odd referer")
		}
		path := rapid.SampledFrom([]string{"/chunk.js", "/", "", "/a/%2e%2e/b", "/100%25.js", "/%7Ex", "/a//b", "/cdn-cgi/challenge-platform/h/b/x.js", "/%"}).Draw(rt, "path")
		query := rapid.SampledFrom([]string{"", "?", "?a=b", "?a=%2F&b"}).Draw(rt, "query")
		want, _, err := oracle.Ask("refererroute", p, ref, path, query)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		pu, _ := url.Parse(p)
		got := RefererRoute(ref, path, query, ProxyConfig{PublicURL: pu})
		if got == "" {
			got = "none"
		}
		if got != want {
			rt.Fatalf("RefererRoute(%q, %q, %q) under %s\n got  %q\n spec %q", ref, path, query, p, got, want)
		}
	})
}
