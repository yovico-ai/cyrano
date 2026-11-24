package urlrewrite

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_EncodeQuery(t *testing.T) {
	oracle := specoracle.Need(t)
	pieces := []string{"a", "q=", "é", "ü", "€", "中", " ", "\"", "#", "<", ">", "'", "&", "%", "\x01", "\x7f", "ÿ", "😀"}
	rapid.Check(t, func(rt *rapid.T) {
		q := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 0, 8).Draw(rt, "q"), "")
		special := rapid.Bool().Draw(rt, "special")
		sp := "other"
		if special {
			sp = "special"
		}
		want, _, err := oracle.Ask("encquery", sp, q)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := EncodeQuery(Latin1, special, q); got != want {
			rt.Fatalf("EncodeQuery(%q, %v) = %q, spec %q", q, special, got, want)
		}
	})
}
