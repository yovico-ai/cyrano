package proxy

// Conformance of chromePriority with spec/Priority.agda (the spec against
// Chromium over HTTP/2: ts/client/tests/spec/priority-vs-chromium).

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_Priority(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		dest := rapid.SampledFrom([]string{"document", "iframe", "frame", "embed", "object", "style", "font", "script", "json", "image", "video", "audio", "track",
			"worker", "sharedworker", "serviceworker", "empty", "manifest", "report", "xslt", "audioworklet", "paintworklet", "webidentity", "", "Script", "EMPTY", "worKer", "scrip"}).Draw(rt, "dest")
		mode := rapid.SampledFrom([]string{"navigate", "cors", "no-cors", "same-origin", "NO-CORS", "websocket", ""}).Draw(rt, "mode")
		method := rapid.SampledFrom([]string{"GET", "POST", "post", "PUT", "HEAD"}).Draw(rt, "method")
		purpose := rapid.SampledFrom([]string{"", "prefetch", "Prefetch", "prefetch;prerender", "prefetch;anonymous-client-ip"}).Draw(rt, "purpose")
		want, _, err := oracle.Ask("priority", dest, mode, method, purpose)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := chromePriority(dest, mode, method, purpose)
		if got == "" {
			got = "none"
		}
		if got != want {
			rt.Fatalf("priority(%q, %q, %q, %q) = %q, spec %q", dest, mode, method, purpose, got, want)
		}
	})
}

// Recorded from Chromium over HTTP/2: a no-cors fetch is "u=1, i"; the
// table said "u=4, i", which is a beacon's (a no-cors POST) and a
// prefetch's.
func TestChromePriority_NoCorsFetch(t *testing.T) {
	for _, c := range [][5]string{{"empty", "no-cors", "GET", "", "u=1, i"}, {"empty", "no-cors", "POST", "", "u=4, i"}, {"empty", "no-cors", "GET", "prefetch", "u=4, i"}, {"json", "cors", "GET", "", "u=1"}, {"object", "navigate", "GET", "", "u=0, i"}} {
		if got := chromePriority(c[0], c[1], c[2], c[3]); got != c[4] {
			t.Errorf("%v: %q", c, got)
		}
	}
}
