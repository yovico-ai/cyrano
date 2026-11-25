package urlrewrite

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_JSURL(t *testing.T) {
	oracle := specoracle.Need(t)
	heads := []string{"javascript:", "JavaScript:", " \x01javascript:", "java\tscript:", "javascript", "jav", "http:", "\njavascript:", "JAVASCRIPT:"}
	bodies := []string{"x", "'<b>x</b>'", "%27x%27", "a%2", "%E2%82%AC x", "éx", "x\n y", "x y", "x%25", "x#y", "%FFx", "no", "x ", "%C3%28x", "%F0%9F%98%80x", "%00x", "x\x7f", ""}
	rapid.Check(t, func(rt *rapid.T) {
		u := rapid.SampledFrom(heads).Draw(rt, "head") + rapid.SampledFrom(bodies).Draw(rt, "body") + rapid.SampledFrom([]string{"", " ", "\x02"}).Draw(rt, "tail")
		want, _, err := oracle.Ask("jsurl", u)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := RewriteJSURL(u, func(c string) string {
			if strings.Contains(c, "x") {
				return "J(" + c + ")"
			}
			return c
		})
		if got != want {
			rt.Fatalf("RewriteJSURL(%q) = %q, spec %q", u, got, want)
		}
	})
}
