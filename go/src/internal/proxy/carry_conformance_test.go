package proxy

// Conformance of the Crn-H writer with spec/Carry.agda, asked live (the
// spec against Chromium: ts/client/tests/spec/carry-vs-chromium).

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

// latin1 gives a byte string's bytes as code points (how the oracle and a
// script read them).
func latin1(s string) string {
	r := make([]rune, len(s))
	for i := 0; i < len(s); i++ {
		r[i] = rune(s[i])
	}
	return string(r)
}

func TestSpecConformance_CrnH(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		orig := map[string][]string{}
		n := rapid.IntRange(0, 4).Draw(rt, "n")
		for k := 0; k < n; k++ {
			name := rapid.SampledFrom([]string{"content-type", "x-a", "link", "server-timing", "csp", "x-\xe9"}).Draw(rt, "name")
			if rapid.Bool().Draw(rt, "null") {
				orig[name] = nil
				continue
			}
			var vs []string
			for j := rapid.IntRange(1, 3).Draw(rt, "nv"); j > 0; j-- {
				vs = append(vs, string(rapid.SliceOfN(rapid.SampledFrom([]byte{'a', ' ', '"', '\\', 0x01, 0x7f, 0x80, 0xe9, 0xc3, 0xa9, 0xff, '<', '&'}), 0, 6).Draw(rt, "v")))
			}
			orig[name] = vs
		}
		names := make([]string, 0, len(orig))
		for k := range orig {
			names = append(names, k)
		}
		sort.Strings(names)
		var lines []string
		for _, k := range names {
			if orig[k] == nil {
				lines = append(lines, latin1(k)+"\tn")
				continue
			}
			l := latin1(k) + "\tv"
			for _, v := range orig[k] {
				l += "\t" + latin1(v)
			}
			lines = append(lines, l)
		}
		want, _, err := oracle.Ask("crnh", strings.Join(lines, "\n"))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := CrnHValue(orig); got != want {
			rt.Fatalf("CrnHValue(%q)\n got  %s\n spec %s", orig, got, want)
		}
	})
}

// A Latin-1 byte reads back as itself: json.Marshal wrote U+FFFD.
func TestCrnHValue_BytesAsWritten(t *testing.T) {
	got := CrnHValue(map[string][]string{"x-name": {"caf\xe9"}, "added": nil})
	var m map[string][]string
	if err := json.Unmarshal([]byte(got), &m); err != nil {
		t.Fatal(err)
	}
	if m["x-name"][0] != "caf\u00e9" || got != `{"added":null,"x-name":["caf\u00e9"]}` {
		t.Errorf("CrnHValue = %s", got)
	}
}

// Conformance of parseAcceptCH with spec/Hints.agda acceptCH (the spec
// against Chromium: ts/client/tests/spec/hints-vs-chromium).
func TestSpecConformance_AcceptCH(t *testing.T) {
	oracle := specoracle.Need(t)
	names := []string{"sec-ch-ua-arch", "Sec-CH-UA-Model", "dpr", "x-unknown", "*", "a:b/c"}
	pieces := append(append([]string{}, names...), ", ", ",", " , ", "\t,", ";q=0.5", ";a", ";", "(", ")", "( a  b )", "\"s\"", "\"a\\\"b\"",
		"1", "-1.5", "1.", "?1", "?2", " ", ":aGk=:", ":a", ",,", ";k=\"v\"", ";K=1", ";k=?0")
	rapid.Check(t, func(rt *rapid.T) {
		var lines []string
		for k := rapid.IntRange(1, 2).Draw(rt, "lines"); k > 0; k-- {
			lines = append(lines, strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 0, 6).Draw(rt, "pieces"), ""))
		}
		want, _, err := oracle.Ask("acceptch", strings.Join(lines, "\n"))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		set, ok := parseAcceptCH(lines)
		got := "none"
		if ok {
			var ns []string
			seen := map[string]bool{}
			for _, l := range lines {
				_ = l
			}
			// The spec lists names in order, repeats kept; compare as sets.
			for n := range set {
				ns = append(ns, n)
			}
			sort.Strings(ns)
			got = strings.Join(ns, " ")
			_ = seen
		}
		if want != "none" {
			ws := strings.Fields(want)
			uniq := map[string]bool{}
			var u []string
			for _, w := range ws {
				if !uniq[w] {
					uniq[w] = true
					u = append(u, w)
				}
			}
			sort.Strings(u)
			want = strings.Join(u, " ")
		}
		if got != want {
			rt.Fatalf("parseAcceptCH(%q) = %q, spec %q", lines, got, want)
		}
	})
}

// The decision filterClientHints makes, against spec hintSent.
func TestSpecConformance_HintSent(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		hint := rapid.SampledFrom([]string{"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-arch", "dpr", "sec-ch-ua-model"}).Draw(rt, "hint")
		set := rapid.SliceOfN(rapid.SampledFrom([]string{"sec-ch-ua-arch", "dpr", "sec-ch-ua-full-version-list"}), 0, 3).Draw(rt, "set")
		secure, nav, same := rapid.Bool().Draw(rt, "secure"), rapid.Bool().Draw(rt, "nav"), rapid.Bool().Draw(rt, "same")
		b := func(v bool) string {
			if v {
				return "1"
			}
			return "0"
		}
		want, _, err := oracle.Ask("hintsent", hint, strings.Join(set, " "), b(secure), b(nav), b(same))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		allowed := map[string]bool{}
		for _, s := range set {
			allowed[s] = true
		}
		if got := hintSent(hint, allowed, secure, nav, same); (got && want != "yes") || (!got && want != "no") {
			rt.Fatalf("hintSent(%s, %v, %v %v %v) = %v, spec %s", hint, set, secure, nav, same, got, want)
		}
	})
}

// Chromium ignores an Accept-CH with a string member; the loose reading
// sent sec-ch-ua-arch upstream on it.
func TestParseAcceptCH_InvalidCountsForNothing(t *testing.T) {
	for _, v := range []string{`sec-ch-ua-arch, "sec-ch-ua-model"`, "sec-ch-ua-arch,,dpr", "sec-ch-ua-arch,", "sec-ch-ua-arch;", "a b", "(a b)"} {
		if set, ok := parseAcceptCH([]string{v}); ok {
			t.Errorf("parseAcceptCH(%q) = %v, want none", v, set)
		}
	}
	if set, ok := parseAcceptCH([]string{"Sec-CH-UA-Arch;q=0.5, (dpr)"}); !ok || !set["sec-ch-ua-arch"] || !set["dpr"] {
		t.Errorf("valid list: %v %v", set, ok)
	}
}
