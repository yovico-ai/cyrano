package server

// Conformance of responseKind with spec/Disposition.agda, asked live: what
// a response's body is rewritten as, by its URL's mark, Sec-Fetch-Dest,
// Content-Type and sniffing. The Content-Type is never changed.

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

func TestSpecConformance_Disposition(t *testing.T) {
	oracle := specoracle.Need(t)
	dests := []string{"script", "Script", "style", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet", "document",
		"iframe", "frame", "embed", "object", "empty", "image", "font", "manifest", "track", "video", "report", ""}
	cts := []string{"text/javascript", "text/plain", "TEXT/HTML; charset=utf-8", " text/html ", "application/xhtml+xml", "text/css",
		"text/css;x", "application/javascript", "application/x-javascript", "text/jscript", "application/json", "image/png",
		"application/octet-stream", "", "text/htmlx", "text/javascript1.5", "\ttext/css\t"}
	rapid.Check(t, func(rt *rapid.T) {
		mark := rapid.SampledFrom([]string{"-", "-", "js", "css"}).Draw(rt, "mark")
		has := rapid.Bool().Draw(rt, "has")
		sfd := rapid.SampledFrom(dests).Draw(rt, "sfd")
		hasCT := rapid.Bool().Draw(rt, "hasCT")
		ct := rapid.SampledFrom(cts).Draw(rt, "ct")
		sniffed := rapid.Bool().Draw(rt, "sniffed")
		b := func(v bool) string {
			if v {
				return "1"
			}
			return "0"
		}
		want, _, err := oracle.Ask("disposition", mark, b(has), sfd, b(hasCT), ct, b(sniffed))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		m := urlrewrite.Dest("")
		if mark != "-" {
			m = urlrewrite.Dest(mark)
		}
		if got := responseKind(m, sfd, has, ct, hasCT, func() bool { return sniffed }).String(); got != want {
			rt.Fatalf("responseKind(%q, %q/%v, %q/%v, %v) = %s, spec says %s", mark, sfd, has, ct, hasCT, sniffed, got, want)
		}
	})
}
