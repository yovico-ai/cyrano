package htmlrewrite

import (
	"strings"
	"testing"
)

// An element's referrerpolicy: its URLs carry the policy (the proxy
// applies it) and the browser is told unsafe-url; the page reads back what
// it wrote (crn-o). An invalid value is no policy.
func TestRewrite_ElementReferrerPolicy(t *testing.T) {
	got := rewrite(t, `<iframe referrerpolicy="Origin" src="https://ad.example/f"></iframe><img referrerpolicy="bogus" src="https://cdn.example/x.png">`,
		withBaseURL("https://site.example/page"), func(c *Config) { c.NoOriginals = false })
	for _, want := range []string{
		`src="http://localhost:9081/cyrano/https!origin/ad.example/f"`,
		`referrerpolicy="unsafe-url"`,
		`&#34;referrerpolicy&#34;:&#34;Origin&#34;`,
		`src="http://localhost:9081/cyrano/https/cdn.example/x.png"`,
		`referrerpolicy="bogus"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in\n%s", want, got)
		}
	}
}
