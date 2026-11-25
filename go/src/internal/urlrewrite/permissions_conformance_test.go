package urlrewrite

// Conformance of TranslatePermissionsPolicy with spec/Permissions.agda
// translate (the spec against Chromium:
// ts/client/tests/spec/permissions-vs-chromium).

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_PermissionsPolicy(t *testing.T) {
	oracle := specoracle.Need(t)
	keys := []string{"geolocation", "camera", "fullscreen", "sync-xhr", "x-unknown", "Geolocation", "*k", "a.b-c_d"}
	members := []string{"*", "self", "src", "?1", "1", "-2.5", ":aGk=:", `"https://a.example"`, `"https://*.a.example"`, `"https://u@a.example:8443/p"`,
		`"not a url"`, `"data:x"`, `"*"`, `"self"`, `"'self'"`, `"'none'"`, `"'src'"`, `"a\"b"`, `"ws://h"`, `"https://[::1]"`, `"https://a.example\\"`, "self;a=1", "https://x.y"}
	rapid.Check(t, func(rt *rapid.T) {
		var lines []string
		for n := rapid.IntRange(1, 2).Draw(rt, "lines"); n > 0; n-- {
			var es []string
			for k := rapid.IntRange(1, 4).Draw(rt, "entries"); k > 0; k-- {
				key := rapid.SampledFrom(keys).Draw(rt, "key")
				switch rapid.IntRange(0, 2).Draw(rt, "form") {
				case 0:
					es = append(es, key)
				case 1:
					es = append(es, key+"="+rapid.SampledFrom(members).Draw(rt, "m"))
				default:
					ms := rapid.SliceOfN(rapid.SampledFrom(members), 0, 3).Draw(rt, "ms")
					sep := rapid.SampledFrom([]string{" ", "  ", ""}).Draw(rt, "isep")
					es = append(es, key+"=("+rapid.SampledFrom([]string{"", " "}).Draw(rt, "pad")+strings.Join(ms, sep)+")")
				}
			}
			lines = append(lines, strings.Join(es, rapid.SampledFrom([]string{", ", ",", " , ", "\t,", ",, "}).Draw(rt, "sep")))
		}
		want, _, err := oracle.Ask("pptranslate", strings.Join(lines, "\n"))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := strings.Join(TranslatePermissionsPolicy(lines), "\n"); got != want {
			rt.Fatalf("TranslatePermissionsPolicy(%q)\n got  %q\n spec %q", lines, got, want)
		}
		// the table a document's runtime is given (spec Permissions.table)
		wantT, _, err := oracle.Ask("pptable", strings.Join(lines, "\n"))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		gotT := "none"
		if tb, ok := PermissionsTable(lines); ok {
			rows := make([]string, len(tb))
			for i, r := range tb {
				rows[i] = strings.Join(r, "\x1f")
			}
			gotT = strings.Join(rows, "\n")
		}
		if gotT != wantT {
			rt.Fatalf("PermissionsTable(%q)\n got  %q\n spec %q", lines, gotT, wantT)
		}
	})
}

func TestSpecConformance_RewriteAllow(t *testing.T) {
	oracle := specoracle.Need(t)
	words := []string{"fullscreen", "camera", "Camera", "*", "'self'", "'SELF'", "'src'", "'none'", "self", "https://a.example", "https://a.example:8443/p?q",
		"http://u@h.example", "data:x", "junk", "https://*.a.example", "ws://h", "https://[::1]", "'self", "http:/x"}
	rapid.Check(t, func(rt *rapid.T) {
		var b strings.Builder
		for n := rapid.IntRange(1, 10).Draw(rt, "n"); n > 0; n-- {
			b.WriteString(rapid.SampledFrom(append(append([]string{}, words...), " ", "  ", "\t", "\n", "\f", "\r", ";", "; ", ";;")).Draw(rt, "piece"))
		}
		v := b.String()
		want, _, err := oracle.Ask("allowrewrite", v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := RewriteAllow(v); got != want {
			rt.Fatalf("RewriteAllow(%q)\n got  %q\n spec %q", v, got, want)
		}
	})
}

func TestSpecConformance_RewriteFeaturePolicy(t *testing.T) {
	oracle := specoracle.Need(t)
	words := []string{"geolocation", "camera", "*", "'self'", "'SELF'", "'src'", "'none'", "self", "https://a.example", "https://a.example:8443/p",
		"http://u@h.example", "data:x", "junk", "https://*.a.example", "HTTPS://*.A.EXAMPLE", "ws://h", "http:/x"}
	rapid.Check(t, func(rt *rapid.T) {
		var b strings.Builder
		for n := rapid.IntRange(1, 10).Draw(rt, "n"); n > 0; n-- {
			b.WriteString(rapid.SampledFrom(append(append([]string{}, words...), " ", "  ", "\t", ";", "; ", ";;")).Draw(rt, "piece"))
		}
		v := b.String()
		want, _, err := oracle.Ask("fprewrite", v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := RewriteFeaturePolicy(v); got != want {
			rt.Fatalf("RewriteFeaturePolicy(%q)\n got  %q\n spec %q", v, got, want)
		}
	})
}
