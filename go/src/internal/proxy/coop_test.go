package proxy

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
)

// A non-secure document's opener policy is ignored natively; through the
// proxy (https) the browser would act on it, so it is told unsafe-none.
func TestNeutralizeCoop(t *testing.T) {
	for _, c := range []struct{ target, want string }{
		{"http://example.com/p", "unsafe-none"},
		{"https://example.com/p", "same-origin"},
		{"http://127.0.0.1:8080/p", "same-origin"},
		{"http://localhost/p", "same-origin"},
	} {
		u, _ := url.Parse(c.target)
		resp := &http.Response{Header: http.Header{"Cross-Origin-Opener-Policy": {"same-origin"}}, Request: &http.Request{URL: u}}
		neutralizeCoop(resp)
		if got := resp.Header.Get("Cross-Origin-Opener-Policy"); got != c.want {
			t.Errorf("%s: COOP %q, want %q", c.target, got, c.want)
		}
	}
}

func TestSpecConformance_SameOriginMode(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, m := range []string{"same-origin", "cors", "no-cors", "navigate", "SAME-ORIGIN"} {
		for _, c := range []string{"https://a.example", "null"} {
			for _, tg := range []string{"https://a.example", "https://b.example"} {
				want, _, err := oracle.Ask("sameoriginmode", strings.ToLower(m), c, tg)
				if err != nil {
					t.Fatal(err)
				}
				if got := sameOriginModeFails(m, c, tg); got != (want == "yes") {
					t.Errorf("sameOriginModeFails(%s, %s, %s) = %v, spec %s", m, c, tg, got, want)
				}
			}
		}
	}
}
