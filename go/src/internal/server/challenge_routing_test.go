package server

import (
	"net/http"
	"testing"

	"github.com/yovico/cyrano/internal/proxy"
)

func TestIsChallengeplatformPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1", true},
		{"/cdn-cgi/challenge-platform/scripts/jsd/main.js", true},
		{"/CDN-CGI/Challenge-Platform/h/g/cv/result", true}, // case-insensitive
		{"/cdn-cgi/trace", false},
		{"/static/app.js", false},
		{"/", false},
	}
	for _, c := range cases {
		if got := isChallengeplatformPath(c.path); got != c.want {
			t.Errorf("isChallengeplatformPath(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

// TestChallengeOriginFromSession covers the blob-worker routing lookup: a
// bare-path challenge request carries only the session cookie, from which we
// recover the upstream origin recorded when the challenge page was served.
func TestChallengeOriginFromSession(t *testing.T) {
	const sessName = "crnsct"
	jar := proxy.NewSessionJar()
	jar.StoreChallengeOrigin("sid-123", "https", "claude.ai")

	newReqWithCookie := func(name, val string) *http.Request {
		r, _ := http.NewRequest("GET", "http://localhost:9081/cdn-cgi/challenge-platform/x", nil)
		if name != "" {
			r.AddCookie(&http.Cookie{Name: name, Value: val})
		}
		return r
	}

	t.Run("resolves origin from session cookie", func(t *testing.T) {
		scheme, host, ok := challengeOriginFromSession(newReqWithCookie(sessName, "sid-123"), jar, sessName)
		if !ok || scheme != "https" || host != "claude.ai" {
			t.Fatalf("got (%q, %q, %v), want (https, claude.ai, true)", scheme, host, ok)
		}
	})

	t.Run("unknown session ID → not found", func(t *testing.T) {
		if _, _, ok := challengeOriginFromSession(newReqWithCookie(sessName, "nope"), jar, sessName); ok {
			t.Error("unknown session must not resolve an origin")
		}
	})

	t.Run("no session cookie → not found", func(t *testing.T) {
		if _, _, ok := challengeOriginFromSession(newReqWithCookie("", ""), jar, sessName); ok {
			t.Error("missing session cookie must not resolve an origin")
		}
	})

	t.Run("nil jar → not found", func(t *testing.T) {
		if _, _, ok := challengeOriginFromSession(newReqWithCookie(sessName, "sid-123"), nil, sessName); ok {
			t.Error("nil jar must not resolve an origin")
		}
	})

	t.Run("empty session name → not found", func(t *testing.T) {
		if _, _, ok := challengeOriginFromSession(newReqWithCookie(sessName, "sid-123"), jar, ""); ok {
			t.Error("empty session cookie name must not resolve an origin")
		}
	})
}
