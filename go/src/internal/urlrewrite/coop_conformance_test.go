package urlrewrite

// Conformance of CoopToken with spec/Coop.agda coopToken (the spec against
// Chromium: coop-vs-chromium).

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_CoopToken(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		vals := rapid.SliceOfN(rapid.SampledFrom([]string{"same-origin", "same-origin-allow-popups", "unsafe-none", "noopener-allow-popups",
			"same-origin; report-to=\"x\"", "\"same-origin\"", "same-origin, unsafe-none", "", " same-origin ", "Same-Origin", "?1", "nonsense"}), 0, 2).Draw(rt, "lines")
		pr, v := "0", ""
		if len(vals) > 0 {
			pr, v = "1", strings.Join(vals, ", ")
		}
		want, has, err := oracle.Ask("cooptoken", pr, v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if !has {
			want = ""
		}
		if got := CoopToken(vals); got != want {
			rt.Fatalf("CoopToken(%q) = %q, spec %q", vals, got, want)
		}
	})
}
