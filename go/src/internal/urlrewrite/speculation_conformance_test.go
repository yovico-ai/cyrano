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

// A rule set's content (spec rewriteRuleSet): list rules' "urls" proxified.
func TestSpecConformance_RuleSet(t *testing.T) {
	oracle := specoracle.Need(t)
	urls := []string{`"https://www.immi-usa.com/blog/"`, `"/about-us/"`, `"rel/x"`, `"//h.example/r"`, `"mailto:a@b"`, `"a\"b"`, `"été"`, `""`, `"?q"`, `"#f"`}
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		list := strings.Join(rapid.SliceOfN(rapid.SampledFrom(urls), 0, 3).Draw(rt, "urls"), rapid.SampledFrom([]string{",", ", ", " ,\n"}).Draw(rt, "sep"))
		key := rapid.SampledFrom([]string{`"urls"`, `"urls" `, `"url"`, `"where"`}).Draw(rt, "key")
		rule := rapid.SampledFrom([]string{
			`{"source":"list",` + key + `:[` + list + `],"eagerness":"immediate"}`,
			`{"source":"document","where":{"href_matches":"/*"}}`,
			`{"source":"list",` + key + `:[[` + list + `]]}`,
			`{"tag":"urls",` + key + `:[` + list + `]}`,
		}).Draw(rt, "rule")
		text := rapid.SampledFrom([]string{`{"prefetch":[` + rule + `]}`, ` {"prerender": [ ` + rule + ` ] } `, `{"prefetch":[` + rule + `]`, `{urls:["/x"]}`, `[` + list + `]`}).Draw(rt, "text")
		want, _, err := oracle.Ask("ruleset", proxy, base, text)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		if got := string(RewriteRuleSet([]byte(text), baseURL, proxyConfig(rt, proxy))); got != want {
			rt.Fatalf("RewriteRuleSet(%q) on %s\n got  %q\n spec %q", text, base, got, want)
		}
	})
}
