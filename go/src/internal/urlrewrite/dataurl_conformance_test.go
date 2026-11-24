package urlrewrite

// Conformance of ReadDataURL / Rewritable / Wrapped with spec/DataUrl.agda,
// asked live: a data: URL a script is given, as the browser reads it.

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_DataURL(t *testing.T) {
	oracle := specoracle.Need(t)
	schemes := []string{"data:", "DATA:", "Data:", " data:", "\tdata:", "dat:", "data", "\x01data:"}
	heads := []string{"", "text/javascript", "text/javascript;base64", "text/javascript; base64", "text/javascript ;  BASE64",
		";base64", "application/javascript;charset=utf-8", "text/javascript;charset=latin1", " text/javascript ", "text/javascript;base64 ",
		"text/java\tscript", "a?b", "text/javascript;xbase64", "base64", "é/x", "text/plain;charset=UTF-8;base64"}
	bodies := []string{"", "import(\"https://x.example/a.js\")", "YWI=", "YWI", "Y W I", "YQ==", "YQ=", "Y", "a%20b", "%zz", "%", "%4",
		"é", "ÿ", "#frag", "a#b,c", ",", "?q", "\n\t", "AA==", "AAA=", "YWJj+/8=", "@@", "w6k=", "/w==", "%C3%A9", "%FF"}
	rapid.Check(t, func(rt *rapid.T) {
		u := rapid.SampledFrom(schemes).Draw(rt, "scheme") + rapid.SampledFrom(heads).Draw(rt, "head")
		if rapid.IntRange(0, 5).Draw(rt, "comma") > 0 {
			u += ","
		}
		n := rapid.IntRange(0, 3).Draw(rt, "n")
		for i := 0; i < n; i++ {
			u += rapid.SampledFrom(bodies).Draw(rt, "body")
		}
		u += rapid.SampledFrom([]string{"", "", " ", "\n"}).Draw(rt, "trail")
		want, _, err := oracle.Ask("dataurl", u)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := "none"
		if d, ok := ReadDataURL(u); ok {
			flag := "0"
			if d.Rewritable() {
				flag = "1"
			}
			got = strings.Join([]string{flag, d.Head, hex.EncodeToString(d.Body), Wrapped(d.Head, d.Body)}, "\t")
		}
		if got != want {
			rt.Fatalf("ReadDataURL(%q) = %q, spec says %q", u, got, want)
		}
	})
}

func TestSpecConformance_DataDocument(t *testing.T) {
	oracle := specoracle.Need(t)
	schemes := []string{"data:", "DATA:", " data:", "dat:"}
	heads := []string{"", "text/html", "TEXT/HTML", " text/html ", "text/html;charset=utf-8", "text/html;base64", "text/html ; charset=latin1",
		"text/htmlx", "text/plain", "image/svg+xml", "application/xhtml+xml", "text/\thtml", ";base64"}
	bodies := []string{"", "<p>a", "PHA+YQ==", "%3Cp%3E", "é", "%FF", "#f", "<img src=x>"}
	rapid.Check(t, func(rt *rapid.T) {
		u := rapid.SampledFrom(schemes).Draw(rt, "scheme") + rapid.SampledFrom(heads).Draw(rt, "head")
		if rapid.IntRange(0, 5).Draw(rt, "comma") > 0 {
			u += ","
		}
		u += rapid.SampledFrom(bodies).Draw(rt, "body")
		want, _, err := oracle.Ask("datadoc", u)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := "no"
		if DataDocument(u) {
			got = "yes"
		}
		if got != want {
			rt.Fatalf("DataDocument(%q) = %s, spec %s", u, got, want)
		}
	})
}
