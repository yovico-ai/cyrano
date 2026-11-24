package urlrewrite

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_RewriteChallenge(t *testing.T) {
	oracle := specoracle.Need(t)
	pieces := []string{"Basic", "basic", "BASIC", "Digest", " ", "\t", "realm", "Realm", "=", " = ", `"r1"`, `"a\"b"`, `"a\\b"`, `"`, "r1", ",", ", ", "charset=UTF-8", "x", "é", "token68==", "Bearer"}
	rapid.Check(t, func(rt *rapid.T) {
		line := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 0, 9).Draw(rt, "pieces"), "")
		site := rapid.SampledFrom([]string{"https://a.example", "http://127.0.0.1:8"}).Draw(rt, "site")
		want, _, err := oracle.Ask("challenge", site, line)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := RewriteChallenge(site, line); got != want {
			rt.Fatalf("RewriteChallenge(%q, %q) = %q, spec %q", site, line, got, want)
		}
	})
	// The common forms, by hand.
	for _, c := range [][2]string{
		{`Basic realm="r1"`, `Basic realm="https://a.example r1"`},
		{`Basic realm=r1, charset="UTF-8"`, `Basic realm="https://a.example r1", charset="UTF-8"`},
		{`Basic charset="UTF-8", realm="x"`, `Basic charset="UTF-8", realm="https://a.example x"`},
		{`Digest realm="r1", nonce="n"`, `Digest realm="r1", nonce="n"`},
	} {
		if got := RewriteChallenge("https://a.example", c[0]); got != c[1] {
			t.Errorf("%q: got %q want %q", c[0], got, c[1])
		}
	}
}
