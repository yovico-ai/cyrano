package server

// Conformance of responseKind with spec/Disposition.agda, asked live: what
// a response's body is rewritten as, by its URL's mark, Sec-Fetch-Dest,
// Content-Type and sniffing. The Content-Type is never changed.

import (
	"strings"
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
		"application/octet-stream", "", "text/htmlx", "text/javascript1.5", "\ttext/css\t", "unknown/unknown", "Application/Unknown", "*/*", "foo",
		"te xt/html", "text/html,", "foo,text/html", "text/html,*/*", "text/html, text/plain", "/html", "text/", "text/html x", "text/plain;a=b, unknown/unknown",
		"image/svg+xml", "image/svg+xml; charset=utf-8", "IMAGE/SVG+XML", "text/xml", "application/xml", "application/rss+xml", "foo/bar+xml",
		"a/+xml", "/x+xml", "a/b+xm", "a b/c+xml", "text/xml,text/html", "text/html,image/svg+xml", "application/xhtml+xml; q=1",
		"application/atom+xml", "APPLICATION/RSS+XML", "text/foo+xml", "text/foo+XML", "text/x/y+xml", "text/+xml", "text/{a}+xml", "text/a=b+xml"}
	rapid.Check(t, func(rt *rapid.T) {
		mark := rapid.SampledFrom([]string{"-", "-", "js", "css", "frame"}).Draw(rt, "mark")
		has := rapid.Bool().Draw(rt, "has")
		sfd := rapid.SampledFrom(dests).Draw(rt, "sfd")
		hasCT := rapid.Bool().Draw(rt, "hasCT")
		ct := rapid.SampledFrom(cts).Draw(rt, "ct")
		sniffed := rapid.Bool().Draw(rt, "sniffed")
		xmlMagic := rapid.Bool().Draw(rt, "xmlMagic")
		b := func(v bool) string {
			if v {
				return "1"
			}
			return "0"
		}
		want, _, err := oracle.Ask("disposition", mark, b(has), sfd, b(hasCT), ct, b(sniffed), b(xmlMagic))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		m := urlrewrite.Dest("")
		if mark != "-" {
			m = urlrewrite.Dest(mark)
		}
		if got := responseKind(m, sfd, has, ct, hasCT, func() sniffResult { return sniffResult{sniffed, xmlMagic} }).String(); got != want {
			rt.Fatalf("responseKind(%q, %q/%v, %q/%v, %v %v) = %s, spec says %s", mark, sfd, has, ct, hasCT, sniffed, xmlMagic, got, want)
		}
	})
}

// Chromium's HTML sniff, against spec/Disposition.agda sniffHtml.
func TestSpecConformance_SniffHTML(t *testing.T) {
	oracle := specoracle.Need(t)
	pieces := []string{"<p", "<P", "<b", "<bx", "<x", "<h1", "<h2", "<!--", "<!doctype html", "<!DOCTYPE HTM", "<script", "<scrip", "<?xml ?>", "hello",
		" ", "\f", "\r", "\v", strings.Repeat(" ", 300), "<a", "<br", "<body", "<span", ">", "x"}
	rapid.Check(t, func(rt *rapid.T) {
		body := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 1, 5).Draw(rt, "pieces"), "")
		want, _, err := oracle.Ask("sniffhtml", body)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := sniffHTMLBytes([]byte(body)); got != (want == "yes") {
			rt.Fatalf("sniffHTMLBytes(%q) = %v, spec %s", body, got, want)
		}
	})
}

// A document served as unknown/unknown, */*, or a type without "/" is
// sniffed by Chromium as one with none: its HTML was passed unrewritten,
// and its URLs went straight to the origins. "<bx" is HTML to Chromium,
// not to Go's DetectContentType.
func TestResponseKind_SniffsUntakenTypes(t *testing.T) {
	for _, ct := range []string{"unknown/unknown", "*/*", "foo", "", "te xt/html"} {
		if k := responseKind("", "document", true, ct, true, func() sniffResult { return sniffResult{HTML: true} }); k != kindHTML {
			t.Errorf("%q: %s, want html", ct, k)
		}
	}
	if k := responseKind("", "document", true, "foo, text/html", true, func() sniffResult { return sniffResult{} }); k != kindHTML {
		t.Errorf("the last type taken: %s", k)
	}
	if !sniffHTMLBytes([]byte("\v<bx")) || sniffHTMLBytes([]byte("\ufeff<p>")) {
		t.Error("sniff")
	}
}

// The destination a request is judged by: a prefetch for no destination
// is a navigation's (spec/Disposition.agda judgedDest; togaze.com).
func TestSpecConformance_JudgedDest(t *testing.T) {
	oracle := specoracle.Need(t)
	dests := []string{"empty", "Empty", "EMPTY", "document", "script", "image", "", " empty"}
	purposes := []string{"prefetch", "prefetch;prerender", "prefetch;anonymous-client-ip", " prefetch ", "\tprefetch", "Prefetch", "prefetch, x",
		"prerender", "", "pre fetch", "prefetchx", "x, prefetch", ";prefetch", "prefetch\t;a"}
	rapid.Check(t, func(rt *rapid.T) {
		has, hasP := rapid.Bool().Draw(rt, "has"), rapid.Bool().Draw(rt, "hasP")
		sfd, p := rapid.SampledFrom(dests).Draw(rt, "sfd"), rapid.SampledFrom(purposes).Draw(rt, "p")
		b := func(v bool) string {
			if v {
				return "1"
			}
			return "0"
		}
		want, _, err := oracle.Ask("judgeddest", b(has), sfd, b(hasP), p)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		d, ok := judgedDest(sfd, has, p, hasP)
		got := "nothing"
		if ok {
			got = "just " + d
		}
		if got != want {
			rt.Fatalf("judgedDest(%q/%v, %q/%v) = %s, spec says %s", sfd, has, p, hasP, got, want)
		}
	})
}

// What a body sniffs as — HTML, XML's magic — against spec/Disposition.agda sniffOf.
func TestSpecConformance_Sniff(t *testing.T) {
	oracle := specoracle.Need(t)
	pieces := []string{"<?xml", "<?XML", "<?xml version=\"1.0\"?>", " ", "\n", "\v", "\f", "\r", "\t", "<!DOCTYPE rss>", "<!doctype html", "<rss", "<RSS version=\"2.0\">", "<feed",
		"<Feed xmlns=\"http://www.w3.org/2005/Atom\">", "<svg", "<!--", "<p", "x", "<", strings.Repeat("a", 290), "<?pi?>", "<b"}
	rapid.Check(t, func(rt *rapid.T) {
		body := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 0, 6).Draw(rt, "pieces"), "")
		want, _, err := oracle.Ask("sniff", body)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		r := sniffBytes([]byte(body))
		f := func(v bool) string {
			if v {
				return "1"
			}
			return "0"
		}
		if got := f(r.HTML) + f(r.XML); got != want {
			rt.Fatalf("sniffBytes(%q) = %s, spec says %s", body, got, want)
		}
	})
}
