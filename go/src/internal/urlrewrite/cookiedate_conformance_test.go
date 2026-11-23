package urlrewrite

// Conformance of CookieDate with spec/CookieDate.agda, asked live.

import (
	"strconv"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

var cookieDatePieces = []string{" ", "-", ",", "/", ".", "\t", "1", "15", "31", "29", "0", "00", "2027", "27", "99", "69", "70", "1999",
	"12345", "123456", "Feb", "jun", "Sept", "OCT", "x", "Mon", "GMT", "10:11:12", "1:2:3", "23:59:60", "24:0:0", "9:9", "123:4:5",
	"12x", ":", "é", "😀", "+0500"}

func TestSpecConformance_CookieDate(t *testing.T) {
	oracle := specoracle.Need(t)
	fixed := []string{"Wed, 21 Oct 2026 07:28:00 GMT", "30 Feb 2027 0:0:0", "29 Feb 2028 0:0:0", "1x Jan 2027 1:2:3x",
		"9:99:9 1:2:3 1 Jan 2027", "1 Jan 1969 0:0:0", "1é Jan 2027 0:0:0", "Janué 1 2027 0:0:0", "", "  ", "1 Jan 99999 0:0:0"}
	check := func(t interface{ Fatalf(string, ...any) }, s string) {
		want, _, err := oracle.Ask("cookiedate", s)
		if err != nil {
			t.Fatalf("oracle: %v", err)
		}
		got, ok := CookieDate(s)
		have := "none"
		if ok {
			have = strconv.FormatUint(got, 10)
		}
		if have != want {
			t.Fatalf("CookieDate(%q) = %s, spec %s", s, have, want)
		}
	}
	for _, s := range fixed {
		check(t, s)
	}
	rapid.Check(t, func(rt *rapid.T) {
		var b strings.Builder
		for _, p := range rapid.SliceOfN(rapid.SampledFrom(cookieDatePieces), 1, 9).Draw(rt, "pieces") {
			b.WriteString(p)
			if rapid.Bool().Draw(rt, "sp") {
				b.WriteByte(' ')
			}
		}
		check(rt, b.String())
	})
}
