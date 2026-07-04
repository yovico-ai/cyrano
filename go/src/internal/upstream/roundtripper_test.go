package upstream

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

const chromeUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func newReq(t *testing.T, method, url string) *http.Request {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("User-Agent", chromeUA)
	return req
}

// TestRoundTripNegotiatesHTTP2 is the regression test for the core fix: the
// old tlsdial transport forced ALPN to http/1.1, so upstream connections spoke
// HTTP/1.1 despite advertising a Chrome ClientHello — a glaring contradiction.
// The impersonation client must now negotiate HTTP/2 like a real browser.
func TestRoundTripNegotiatesHTTP2(t *testing.T) {
	var gotUA, gotFoo, gotCookie string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		gotFoo = r.Header.Get("X-Foo")
		gotCookie = r.Header.Get("Cookie")
		w.Header().Set("Set-Cookie", "srv=1; Path=/")
		io.WriteString(w, "proto="+r.Proto)
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	rt := NewRoundTripper(true) // self-signed test cert

	req := newReq(t, "GET", srv.URL)
	req.Header.Set("X-Foo", "bar")
	req.Header.Set("Cookie", "a=b")

	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.ProtoMajor != 2 {
		t.Errorf("upstream protocol: got %s, want HTTP/2", resp.Proto)
	}
	body, _ := io.ReadAll(resp.Body)
	if got := string(body); !strings.Contains(got, "HTTP/2.0") {
		t.Errorf("server saw non-h2 request: body=%q", got)
	}
	if !strings.Contains(gotUA, "Chrome/131") {
		t.Errorf("User-Agent not forwarded verbatim: %q", gotUA)
	}
	if gotFoo != "bar" {
		t.Errorf("X-Foo not forwarded: %q", gotFoo)
	}
	if gotCookie != "a=b" {
		t.Errorf("Cookie not forwarded verbatim: %q", gotCookie)
	}
	if resp.Request != req {
		t.Error("resp.Request must be the original stdlib request (downstream reads its context)")
	}
	if resp.Header.Get("Set-Cookie") == "" {
		t.Error("Set-Cookie missing after header conversion")
	}
}

// TestNoCookieJar verifies the transport never stores or replays cookies: a
// Set-Cookie on one response must not appear on the next request. cyrano owns
// all cookie state; a jar here would bypass its site-namespacing/isolation.
func TestNoCookieJar(t *testing.T) {
	var seen []string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Cookie"))
		w.Header().Set("Set-Cookie", "planted=1; Path=/")
		io.WriteString(w, "ok")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	rt := NewRoundTripper(true)
	for range 2 {
		resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL))
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	if len(seen) != 2 {
		t.Fatalf("expected 2 requests, got %d", len(seen))
	}
	if seen[1] != "" {
		t.Errorf("cookie jar leaked cookie into 2nd request: %q", seen[1])
	}
}

// TestRedirectsNotFollowed verifies 3xx responses pass through unfollowed, so
// ReverseProxy can relay them to the browser (which re-navigates via the proxy).
func TestRedirectsNotFollowed(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redir" {
			http.Redirect(w, r, "/dest", http.StatusFound)
			return
		}
		io.WriteString(w, "final")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	rt := NewRoundTripper(true)
	resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL+"/redir"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Errorf("status: got %d, want 302 (redirect must not be followed)", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "/dest" {
		t.Errorf("Location: got %q, want /dest", loc)
	}
}

// TestPlaintextUsesStdlib verifies http targets go through the stdlib transport
// (no TLS, nothing to fingerprint) and still work end-to-end.
func TestPlaintextUsesStdlib(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "plain-"+r.Proto)
	}))
	defer srv.Close()

	rt := NewRoundTripper(false)
	resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.HasPrefix(string(body), "plain-HTTP/1.1") {
		t.Errorf("plaintext body: got %q", body)
	}
}

// TestRoundTripDoesNotAutoDecompress guards against fhttp's non-stdlib
// behaviour of auto-decompressing whenever the caller's Accept-Encoding
// contains "gzip". cyrano decodes bodies itself (it rewrites them), so the
// transport must hand back the raw compressed body with Content-Encoding
// intact. A regression here manifests as "magic number mismatch" when cyrano's
// decoder is handed already-decompressed bytes.
func TestRoundTripDoesNotAutoDecompress(t *testing.T) {
	const payload = "<html><body>compressed upstream payload</body></html>"
	var gzipped bytes.Buffer
	gw := gzip.NewWriter(&gzipped)
	if _, err := gw.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	raw := gzipped.Bytes()

	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Upstream advertises gzip content and writes pre-gzipped bytes.
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(raw)
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	rt := NewRoundTripper(true)
	req := newReq(t, "GET", srv.URL)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")

	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if ce := resp.Header.Get("Content-Encoding"); ce != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip preserved (transport must not decode)", ce)
	}
	got, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(got, raw) {
		t.Errorf("body was altered by the transport: got %d bytes, want the raw %d gzip bytes", len(got), len(raw))
	}
	if string(got) == payload {
		t.Error("transport auto-decompressed the body; cyrano would then double-decode it")
	}
}

// TestRoundTripDoesNotDuplicateContentLength guards the fix in RoundTrip's
// header-copy loop: fReq.ContentLength is already set from req.ContentLength
// as a dedicated struct field. Also copying the raw Content-Length header
// text produced a request declaring the header twice on the wire — a
// smuggling-adjacent signature that Cloudflare's edge rejected with a
// generic 400. This silently broke every POST while GETs (no body, no
// Content-Length) were unaffected.
func TestRoundTripDoesNotDuplicateContentLength(t *testing.T) {
	var gotCL []string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCL = r.Header.Values("Content-Length")
		io.Copy(io.Discard, r.Body)
		io.WriteString(w, "ok")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	rt := NewRoundTripper(true)
	body := "hello world"
	req := newReq(t, "POST", srv.URL)
	req.Body = io.NopCloser(strings.NewReader(body))
	req.ContentLength = int64(len(body))
	req.Header.Set("Content-Length", strconv.Itoa(len(body)))

	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if len(gotCL) > 1 {
		t.Errorf("Content-Length declared %d times on the wire: %v", len(gotCL), gotCL)
	}
}

// TestRoundTripSynthesizesClientHintsWhenAbsent guards the fix that adds
// Sec-Ch-Ua/-Mobile/-Platform when the incoming request lacks them. Real
// Chrome sends these low-entropy hints on every request unconditionally;
// some automation-driven browser configurations omit them even while
// claiming a Chrome User-Agent, which is itself a bot signal fingerprinting
// WAFs check for.
func TestRoundTripSynthesizesClientHintsWhenAbsent(t *testing.T) {
	var gotChUa, gotMobile, gotPlatform string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotChUa = r.Header.Get("Sec-Ch-Ua")
		gotMobile = r.Header.Get("Sec-Ch-Ua-Mobile")
		gotPlatform = r.Header.Get("Sec-Ch-Ua-Platform")
		io.WriteString(w, "ok")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()

	rt := NewRoundTripper(true)
	resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL)) // chromeUA, no Sec-Ch-Ua set
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if gotChUa == "" || !strings.Contains(gotChUa, `v="131"`) {
		t.Errorf("Sec-Ch-Ua not synthesized for Chrome/131 UA: got %q", gotChUa)
	}
	if gotMobile != "?0" {
		t.Errorf("Sec-Ch-Ua-Mobile = %q, want ?0", gotMobile)
	}
	if gotPlatform != `"Linux"` {
		t.Errorf("Sec-Ch-Ua-Platform = %q, want \"Linux\"", gotPlatform)
	}
}

func TestEnsureClientHints(t *testing.T) {
	h := fhttp.Header{}
	ensureClientHints(h, chromeUA)
	if got := h.Get("Sec-Ch-Ua"); !strings.Contains(got, `v="131"`) {
		t.Errorf("Sec-Ch-Ua = %q, want Chrome major 131", got)
	}
	if got := h.Get("Sec-Ch-Ua-Mobile"); got != "?0" {
		t.Errorf("Sec-Ch-Ua-Mobile = %q, want ?0", got)
	}
	if got := h.Get("Sec-Ch-Ua-Platform"); got != `"Linux"` {
		t.Errorf("Sec-Ch-Ua-Platform = %q, want \"Linux\"", got)
	}

	// Must not override values the caller (real browser) already sent.
	h2 := fhttp.Header{}
	h2.Set("Sec-Ch-Ua", `"custom"`)
	ensureClientHints(h2, chromeUA)
	if got := h2.Get("Sec-Ch-Ua"); got != `"custom"` {
		t.Errorf("existing Sec-Ch-Ua overwritten: got %q", got)
	}
}

func TestChromePlatform(t *testing.T) {
	cases := []struct{ ua, want string }{
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Windows"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "macOS"},
		{"Mozilla/5.0 (Linux; Android 13)", "Android"},
		{"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)", "Chrome OS"},
		{"Mozilla/5.0 (X11; Linux x86_64)", "Linux"},
	}
	for _, c := range cases {
		if got := chromePlatform(c.ua); got != c.want {
			t.Errorf("chromePlatform(%q) = %q, want %q", c.ua, got, c.want)
		}
	}
}

func TestSelectProfile(t *testing.T) {
	cases := []struct {
		ua      string
		wantKey string
	}{
		{"... Chrome/131.0.0.0 Safari/537.36", "chrome131"},
		{"... Chrome/124.0.0.0 ...", "chrome124"},
		{"... Chrome/121.0.0.0 ...", "chrome120"},
		{"... Chrome/139.0.0.0 ...", "chrome144"}, // 133..145 → current-tracking profile
		{"... Chrome/146.0.0.0 ...", "chrome146"}, // newest
		{"... Chrome/140.0.0.0 ...", "chrome144"},
		{"... Chrome/119.0.0.0 ...", "chrome146"}, // older than oldest → latest fallback
		{"Mozilla/5.0 ... Firefox/121.0", "chrome146"},
		{"", "chrome146"},
	}
	for _, c := range cases {
		gotKey, gotProfile := selectProfile(c.ua)
		if gotKey != c.wantKey {
			t.Errorf("selectProfile(%q) key = %q, want %q", c.ua, gotKey, c.wantKey)
		}
		// Sanity: the returned profile is a real Chrome one.
		if client := gotProfile.GetClientHelloId().Client; client != "Chrome" {
			t.Errorf("selectProfile(%q) returned non-Chrome profile %q", c.ua, client)
		}
	}
}
