package urlrewrite

// Conformance of MixedContent with spec/MixedContent.agda.

import (
	"net/url"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_MixedContent(t *testing.T) {
	oracle := specoracle.Need(t)
	ctxs := []string{"-", "https://site.example/p", "http://site.example/p", "wss://w.example/", "ws://w.example/", "HTTPS://Site.Example/", "http://localhost/"}
	targets := []string{"http://cdn.example/a.js", "https://cdn.example/a.js", "http://localhost/x", "http://127.0.0.1:8/x", "http://sub.localhost/x",
		"ws://cdn.example/s", "wss://cdn.example/s", "http://[::1]/x", "http://127.1.2.3/x", "http://10.0.0.1/x"}
	dests := []string{"-", "document", "Document", "image", "IMAGE", "audio", "video", "script", "style", "font", "iframe", "frame", "empty", "worker", "track", "object", "embed", ""}
	rapid.Check(t, func(rt *rapid.T) {
		c := rapid.SampledFrom(ctxs).Draw(rt, "ctx")
		tg := rapid.SampledFrom(targets).Draw(rt, "target")
		d := rapid.SampledFrom(dests).Draw(rt, "dest")
		want, _, err := oracle.Ask("mixed", c, tg, d)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		var cu *url.URL
		if c != "-" {
			cu, _ = url.Parse(c)
		}
		tu, _ := url.Parse(tg)
		if got := MixedContent(cu, tu, d, d != "-").String(); got != want {
			rt.Fatalf("MixedContent(%q, %q, %q) = %s, spec says %s", c, tg, d, got, want)
		}
	})
}
