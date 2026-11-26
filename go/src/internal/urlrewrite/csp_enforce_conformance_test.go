package urlrewrite

import (
	"errors"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

// The proxy's enforcement of a page's fetch directives (spec Csp.cspRefuses).
func TestSpecConformance_CSPRefuses(t *testing.T) {
	oracle := specoracle.Need(t)
	names := []string{"script-src", "script-src-elem", "default-src", "img-src", "style-src", "connect-src", "frame-src", "child-src", "worker-src", "font-src", "media-src", "object-src", "Script-Src"}
	srcs := []string{"'self'", "*", "'none'", "https://cdn.example", "cdn.example", "*.example", "https://*.example:443", "http://a.example:8080/p/", "https:", "data:", "'unsafe-inline'", "'nonce-abc'", "'sha256-abc='", "'strict-dynamic'", "wss:", "a.example/path", "*:*"}
	rapid.Check(t, func(rt *rapid.T) {
		var pols []string
		for n := rapid.IntRange(1, 2).Draw(rt, "pols"); n > 0; n-- {
			var ds []string
			for k := rapid.IntRange(1, 3).Draw(rt, "dirs"); k > 0; k-- {
				ds = append(ds, rapid.SampledFrom(names).Draw(rt, "name")+" "+strings.Join(rapid.SliceOfN(rapid.SampledFrom(srcs), 0, 3).Draw(rt, "srcs"), " "))
			}
			pols = append(pols, strings.Join(ds, "; "))
		}
		dest := rapid.SampledFrom([]string{"script", "style", "image", "font", "empty", "iframe", "worker", "video", "object", "document", "websocket"}).Draw(rt, "dest")
		self := rapid.SampledFrom([]string{"https://a.example/page", "http://a.example:8080/x"}).Draw(rt, "self")
		target := rapid.SampledFrom([]string{"https://a.example/s.js", "https://cdn.example/x", "https://b.cdn.example/x", "http://a.example:8080/p/x", "wss://a.example/ws", "https://cdn.example:8443/x", "http://cdn.example/x"}).Draw(rt, "target")
		want, _, err := oracle.Ask("csprefuses", strings.Join(pols, "\n"), dest, self, target)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := CSPRefuses(pols, dest, self, target); got != (want == "yes") {
			rt.Fatalf("CSPRefuses(%q, %s, %s, %s) = %v, spec %s", pols, dest, self, target, got, want)
		}
	})
}
