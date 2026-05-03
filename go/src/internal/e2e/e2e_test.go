//go:build e2e

package e2e

import (
	"net"
	"net/http"
	"strings"
	"testing"
)

// TestE2E_XForwardedFor — the proxy must strip X-Forwarded-For so it never
// reaches the upstream.
func TestE2E_XForwardedFor(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	hdrs := getEchoHeaders(t, proxy, fixture.URL)

	if _, present := hdrs["x-forwarded-for"]; present {
		t.Errorf("x-forwarded-for leaked to upstream: %v", hdrs["x-forwarded-for"])
	}
}

// TestE2E_AcceptEncoding — when a request arrives with no Accept-Encoding,
// the proxy must set a browser-realistic value (gzip + deflate + br).
// Uses a client with DisableCompression so Go's transport doesn't auto-add
// "Accept-Encoding: gzip" before the proxy sees the request.
func TestE2E_AcceptEncoding(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	hdrs := getEchoHeadersNoCompression(t, proxy, fixture.URL)

	ae := strings.Join(hdrs["accept-encoding"], ",")
	for _, want := range []string{"gzip", "deflate", "br"} {
		if !strings.Contains(ae, want) {
			t.Errorf("accept-encoding missing %q (full value: %q)", want, ae)
		}
	}
}

// TestE2E_BrotliDecode — the proxy must decompress Content-Encoding:br
// responses so the client receives plain HTML.
func TestE2E_BrotliDecode(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	status, body := getVia(t, proxy, fixture.URL+"/brotli-page")

	if status != 200 {
		t.Fatalf("status %d; body: %.200s", status, body)
	}
	if !strings.Contains(body, "brotli body decompressed correctly") {
		t.Errorf("brotli body not decoded; snippet: %.200s", body)
	}
}

// TestE2E_SetCookiePrefixed — Set-Cookie headers from the upstream must arrive
// at the browser with the site-namespace prefix on the cookie name.
func TestE2E_SetCookiePrefixed(t *testing.T) {
	upstream := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc123", Path: "/"})
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok"))
	})
	proxy := startProxy(t)

	resp := getViaRaw(t, proxy, upstream.URL+"/")
	resp.Body.Close()

	found := false
	for _, sc := range resp.Cookies() {
		if strings.HasPrefix(sc.Name, "__crn__") &&
			strings.HasSuffix(sc.Name, "__session") &&
			sc.Value == "abc123" {
			found = true
		}
	}
	if !found {
		t.Errorf("no prefixed Set-Cookie found; got: %v", resp.Cookies())
	}
}

// TestE2E_CookieIsolation — cookies namespaced for fixture-a.test must be
// forwarded when proxying to A, but not when proxying to B, and vice versa.
func TestE2E_CookieIsolation(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	// Both hostnames resolve to 127.0.0.1 via /etc/hosts (or skip if not set).
	aBase := fixtureURL(fixture, "fixture-a.test")
	bBase := fixtureURL(fixture, "fixture-b.test")

	if !resolvesTo127(t, "fixture-a.test") || !resolvesTo127(t, "fixture-b.test") {
		t.Skip("fixture-a.test / fixture-b.test not in /etc/hosts — add '127.0.0.1 fixture-a.test fixture-b.test'")
	}

	// Simulate browser jar: prefixed cookies for both sites.
	// cookieSiteKey replaces only dots, so fixture-a.test → fixture-a_test (hyphen kept).
	jar := "__crn__fixture-a_test__a_secret=for_a; __crn__fixture-b_test__b_secret=for_b"

	// Proxy request to site A: must see a_secret, must NOT see b_secret.
	cookiesA := getEchoCookies(t, proxy, aBase, jar)
	if cookiesA["a_secret"] != "for_a" {
		t.Errorf("site A: want a_secret=for_a, got %v", cookiesA)
	}
	if _, leaked := cookiesA["b_secret"]; leaked {
		t.Errorf("site A: b_secret leaked: %v", cookiesA)
	}

	// Proxy request to site B: must see b_secret, must NOT see a_secret.
	cookiesB := getEchoCookies(t, proxy, bBase, jar)
	if cookiesB["b_secret"] != "for_b" {
		t.Errorf("site B: want b_secret=for_b, got %v", cookiesB)
	}
	if _, leaked := cookiesB["a_secret"]; leaked {
		t.Errorf("site B: a_secret leaked: %v", cookiesB)
	}
}

// resolvesTo127 returns true if hostname resolves to a loopback address.
func resolvesTo127(t *testing.T, hostname string) bool {
	t.Helper()
	addrs, err := net.LookupHost(hostname)
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if strings.HasPrefix(a, "127.") || a == "::1" {
			return true
		}
	}
	return false
}
