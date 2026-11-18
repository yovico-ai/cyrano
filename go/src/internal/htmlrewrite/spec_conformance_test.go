package htmlrewrite

// Conformance of rewriteSrcset with the Agda spec (spec/Srcset.agda),
// asked live. The spec writes each URL u as "[u]"; so does the test's
// rewriter, so only where each URL starts and ends is compared.

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

func TestSpecConformance_Srcset(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		v := specoracle.Srcset(rt)
		want, err := oracle.Srcset(v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := rewriteSrcset(v, func(u string) string { return "[" + u + "]" }); got != want {
			rt.Fatalf("rewriteSrcset(%q) = %q, spec says %q", v, got, want)
		}
	})
}
