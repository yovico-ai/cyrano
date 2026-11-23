package urlrewrite

// Conformance of RewriteSpeculationRules with spec/Speculation.agda.

import (
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_SpeculationRules(t *testing.T) {
	oracle := specoracle.Need(t)
	members := []string{`"/rules.json"`, `"https://static.cdn-website.com/speculations/rules/prerender-1.0.3.json"`, `"/cdn-cgi/speculation"`,
		`"rel/x.json"`, `"//h.example/r"`, `"http://[::1"`, `"a\"b"`, `"a\\b"`, `tok`, `?1`, `42`, `:YQ==:`, `("/in" "/ner")`, `"x";p=1`,
		`"unterminated`, `"é"`, `""`, `"?q"`}
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		ms := rapid.SliceOfN(rapid.SampledFrom(members), 0, 4).Draw(rt, "members")
		h := rapid.SampledFrom([]string{"", " "}).Draw(rt, "lead") +
			strings.Join(ms, rapid.SampledFrom([]string{",", ", ", " ,", ",,"}).Draw(rt, "sep")) +
			rapid.SampledFrom([]string{"", " ", "\t"}).Draw(rt, "trail")
		want, _, err := oracle.Ask("specrules", proxy, base, h)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		if got := RewriteSpeculationRules(h, baseURL, proxyConfig(rt, proxy)); got != want {
			rt.Fatalf("RewriteSpeculationRules(%q) on %s\n got  %q\n spec %q", h, base, got, want)
		}
	})
}
