package proxy

import (
	"net/http"
	"strings"
	"testing"

	"pgregory.net/rapid"

	"github.com/yovico/cyrano/internal/specoracle"
)

func TestVaryOnInitiator(t *testing.T) {
	h := http.Header{}
	h.Add("Vary", "Accept-Encoding")
	h.Add("Vary", "origin")
	varyOnInitiator(h)
	if got := strings.Join(h.Values("Vary"), ", "); got != "Accept-Encoding, origin, Crn-I" {
		t.Errorf("Vary = %q", got)
	}
	h = http.Header{"Vary": {"Accept-Encoding"}}
	varyOnInitiator(h)
	if got := strings.Join(h.Values("Vary"), ", "); got != "Accept-Encoding" {
		t.Errorf("Vary without Origin = %q", got)
	}
}

func TestSpecConformance_VaryForBrowser(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		toks := rapid.SliceOfN(rapid.SampledFrom([]string{"Origin", "origin", " ORIGIN ", "Accept-Encoding", "Crn-I", "crn-i", "*", "", "Origins", "\tOrigin"}), 0, 4).Draw(rt, "toks")
		v := strings.Join(toks, ",")
		want, _, err := oracle.Ask("varyforbrowser", v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := varyForBrowser(v); got != want {
			rt.Fatalf("varyForBrowser(%q) = %q, spec %q", v, got, want)
		}
	})
}
