package proxy

import (
	"net/http"
	"testing"
)

func TestTranslatePermissionsPolicy(t *testing.T) {
	h := http.Header{}
	h.Set("Permissions-Policy", `camera=(), sync-xhr=(), xr-spatial-tracking=*, geolocation=(self "https://maps.example" "https://x.example"), fullscreen=("https://a.example")`)
	h.Set("Feature-Policy", `camera 'none'; geolocation 'self' https://maps.example; fullscreen *`)
	translatePermissionsPolicy(h)
	if got, want := h.Get("Permissions-Policy"), `camera=(), sync-xhr=(), xr-spatial-tracking=*, geolocation=(self), fullscreen=(self)`; got != want {
		t.Errorf("Permissions-Policy:\n got  %s\n want %s", got, want)
	}
	if got, want := h.Get("Feature-Policy"), `camera 'none'; geolocation 'self'; fullscreen *`; got != want {
		t.Errorf("Feature-Policy:\n got  %s\n want %s", got, want)
	}
}
