package proxy

// Conformance of the CORS check (cors.go) with spec/Fetch.agda, asked live.

import (
	"errors"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

// One oracle for the package's conformance tests (none without it: skipped,
// or failed under CYRANO_REQUIRE_ORACLE).
func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

func TestSpecConformance_CORSCheck(t *testing.T) {
	oracle := specoracle.Need(t)
	const origin = "https://a.example"
	originVals := []string{"*", origin, " " + origin + " ", "\t" + origin, origin + "/", "https://A.example", "null", "",
		"*, " + origin, origin + "\v", " " + origin, "https://a.example:443"}
	credVals := []string{"true", " true\t", "True", "false", "", "true, true", "true\v"}
	rapid.Check(t, func(rt *rapid.T) {
		ao := rapid.SliceOfN(rapid.SampledFrom(originVals), 0, 2).Draw(rt, "allowOrigin")
		ac := rapid.SliceOfN(rapid.SampledFrom(credVals), 0, 2).Draw(rt, "allowCredentials")
		cred := rapid.Bool().Draw(rt, "credentialed")
		// An empty value line and no line decide alike (spec/Fetch.agda), and
		// the oracle field cannot tell them apart: draw no lone empty line.
		if len(ao) == 1 && ao[0] == "" || len(ac) == 1 && ac[0] == "" {
			rt.Skip("lone empty line")
		}
		c := "nocred"
		if cred {
			c = "cred"
		}
		out, _, err := oracle.Ask("cors", origin, c, strings.Join(ao, "\n"), strings.Join(ac, "\n"))
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := corsCheck(ao, ac, origin, cred); got != (out == "yes") {
			rt.Fatalf("corsCheck(%q, %q, %v) = %v; spec says %s", ao, ac, cred, got, out)
		}
	})
}
