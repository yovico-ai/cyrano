package upstream

// Conformance of SecChUa with spec/Hints.agda secChUa (the spec against
// Chromium: ts/client/tests/spec/hints-vs-chromium).

import (
	"strconv"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

func TestSpecConformance_SecChUa(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		major := rapid.IntRange(100, 200).Draw(rt, "major")
		product := rapid.SampledFrom([]string{"Google Chrome", "HeadlessChrome", "Microsoft Edge"}).Draw(rt, "product")
		want, _, err := oracle.Ask("secchua", strconv.Itoa(major), product)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := SecChUa(major, product); got != want {
			rt.Fatalf("SecChUa(%d, %s)\n got  %s\n spec %s", major, product, got, want)
		}
	})
}

// Chrome 139 sends this (recorded); the fixed GREASE brand did not.
func TestSecChUa_Chrome139(t *testing.T) {
	if got := SecChUa(139, "Google Chrome"); got != `"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"` {
		t.Errorf("SecChUa(139) = %s", got)
	}
}
