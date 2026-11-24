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
		set := rapid.Bool().Draw(rt, "set")
		args := []string{c, tg, d}
		if set {
			args = append(args, "set")
		}
		want, _, err := oracle.Ask("mixed", args...)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		var cu *url.URL
		if c != "-" {
			cu, _ = url.Parse(c)
		}
		tu, _ := url.Parse(tg)
		if got := MixedContent(cu, tu, d, d != "-", set).String(); got != want {
			rt.Fatalf("MixedContent(%q, %q, %q, set %v) = %s, spec says %s", c, tg, d, set, got, want)
		}
	})
}

func TestSpecConformance_UpgradeInsecureRequests(t *testing.T) {
	oracle := specoracle.Need(t)
	ctxs := []string{"-", "https://site.example/p", "http://site.example/p", "http://site.example:80/q", "https://cdn.example/"}
	targets := []string{"http://cdn.example/a.js", "https://cdn.example/a.js", "http://site.example/x", "http://site.example:8080/x", "ws://cdn.example/s", "wss://cdn.example/s", "HTTP://SITE.example/y"}
	dests := []string{"-", "document", "DOCUMENT", "iframe", "image", "script", "empty", ""}
	rapid.Check(t, func(rt *rapid.T) {
		c := rapid.SampledFrom(ctxs).Draw(rt, "ctx")
		tg := rapid.SampledFrom(targets).Draw(rt, "target")
		d := rapid.SampledFrom(dests).Draw(rt, "dest")
		want, _, err := oracle.Ask("uir", c, tg, d)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		var cu *url.URL
		if c != "-" {
			cu, _ = url.Parse(c)
		}
		tu, _ := url.Parse(tg)
		got := "no"
		if UIRUpgrades(cu, tu, d, d != "-") {
			got = "yes"
		}
		if got != want {
			rt.Fatalf("UIRUpgrades(%q, %q, %q) = %s, spec says %s", c, tg, d, got, want)
		}
	})
}
