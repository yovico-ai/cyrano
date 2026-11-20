package urlrewrite

// Conformance of FrameDest with spec/Frames.agda frameDest, asked live.

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_FrameDest(t *testing.T) {
	oracle := specoracle.Need(t)
	tokens := []string{"allow-scripts", "ALLOW-SCRIPTS", "Allow-Scripts", "allow-same-origin", "allow-forms", "allow-scriptsx", "xallow-scripts", "allow", "scripts", "allow-scripts,", ""}
	seps := []string{" ", "  ", "\t", "\n", "\f", "\r", "\v", ","}
	rapid.Check(t, func(rt *rapid.T) {
		has := rapid.Bool().Draw(rt, "has")
		var b strings.Builder
		for i, n := 0, rapid.IntRange(0, 4).Draw(rt, "n"); i < n; i++ {
			b.WriteString(rapid.SampledFrom(seps).Draw(rt, "sep"))
			b.WriteString(rapid.SampledFrom(tokens).Draw(rt, "tok"))
		}
		b.WriteString(rapid.SampledFrom(append([]string{""}, seps...)).Draw(rt, "tail"))
		sandbox := b.String()
		h := "0"
		if has {
			h = "1"
		}
		want, _, err := oracle.Ask("framedest", h, sandbox)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := string(FrameDest(sandbox, has)); got != want {
			rt.Fatalf("FrameDest(%q, %v) = %s, spec %s", sandbox, has, got, want)
		}
	})
}
