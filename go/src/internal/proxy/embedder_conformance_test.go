package proxy

// Conformance of embedderOf (frame_ancestors.go) with spec/Frames.agda
// embedderOf, asked live.

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_EmbedderOf(t *testing.T) {
	oracle := specoracle.Need(t)
	docs := []string{"https://a.example/p", "https://login.example/authorize?x=1", "http://b.example:8080/", "https://a.example/"}
	rapid.Check(t, func(rt *rapid.T) {
		marked := rapid.Bool().Draw(rt, "marked")
		recorded := rapid.SampledFrom(append([]string{""}, docs...)).Draw(rt, "recorded")
		referer := rapid.SampledFrom(docs).Draw(rt, "referer")
		m, r := "0", recorded
		if marked {
			m = "1"
		}
		if r == "" {
			r = "-"
		}
		want, _, err := oracle.Ask("embedder", m, r, referer)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := embedderOf(marked, recorded, referer); got != want {
			rt.Fatalf("embedderOf(%v, %q, %q) = %q, spec %q", marked, recorded, referer, got, want)
		}
	})
}

func TestSpecConformance_InertFrame(t *testing.T) {
	oracle := specoracle.Need(t)
	b := func(v bool) string {
		if v {
			return "1"
		}
		return "0"
	}
	for _, mi := range []bool{false, true} {
		for _, m := range []bool{false, true} {
			for _, r := range []bool{false, true} {
				want, _, err := oracle.Ask("inertframe", b(mi), b(m), b(r))
				if err != nil {
					t.Fatalf("oracle: %v", err)
				}
				if got := inertFrame(mi, m, r); got != (want == "yes") {
					t.Errorf("inertFrame(%v, %v, %v) = %v, spec %s", mi, m, r, got, want)
				}
			}
		}
	}
}
