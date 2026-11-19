package proxy

import (
	"net/http"
	"testing"
)

func TestTranslatePermissionsPolicy(t *testing.T) {
	h := http.Header{}
	h.Set("Permissions-Policy", `camera=(), sync-xhr=(), xr-spatial-tracking=*, geolocation=(self "https://maps.example" "https://x.example"), fullscreen=("https://a.example")`)
	h.Set("Feature-Policy", `camera 'none'; geolocation 'self' https://maps.example; fullscreen * junk`)
	translatePermissionsPolicy(h)
	if got, want := h.Get("Permissions-Policy"), `camera=(), sync-xhr=(), xr-spatial-tracking=*, geolocation=(self), fullscreen=(self)`; got != want {
		t.Errorf("Permissions-Policy:\n got  %s\n want %s", got, want)
	}
	// Origins become 'self' in place; an unknown word stays one Chromium
	// ignores (the old rule made it 'self', granting the feature).
	if got, want := h.Get("Feature-Policy"), `camera 'none'; geolocation 'self' 'self'; fullscreen * junk`; got != want {
		t.Errorf("Feature-Policy:\n got  %s\n want %s", got, want)
	}
}

// A bare string member names an origin as an inner list's does: it was
// left as written (an upstream origin: nothing on the proxy), and a
// header Chromium ignores whole was edited into one it reads.
func TestTranslatePermissionsPolicy_AsChromiumReadsIt(t *testing.T) {
	for in, want := range map[string]string{
		`fullscreen="https://a.example"`:            `fullscreen=(self)`,
		`geolocation="*", camera=("'self'" "self")`: `geolocation=*, camera=(self)`,
		`camera=(https://a.example)`:                `camera=()`,
		`Geolocation=("https://a.example")`:         `Geolocation=("https://a.example")`,
		`camera=(), , geolocation=*`:                `camera=(), , geolocation=*`,
	} {
		h := http.Header{}
		h.Set("Permissions-Policy", in)
		translatePermissionsPolicy(h)
		if got := h.Get("Permissions-Policy"); got != want {
			t.Errorf("%s:\n got  %s\n want %s", in, got, want)
		}
	}
}
