//go:build e2e

// Package e2e runs end-to-end tests against the full proxy stack.
// Gate: `go test -tags e2e ./internal/e2e/`
package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/server"
)

func fixturesDir() string {
	_, file, _, _ := runtime.Caller(0)
	// go/src/internal/e2e/ — up 4 levels — testdata/e2e/fixtures
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "testdata", "e2e", "fixtures")
}

func assetsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "assets")
}

// startFixtureServer starts a test upstream with these endpoints:
//
//	GET /echo-headers       — request headers seen by upstream, as JSON
//	GET /echo-cookies       — cookies seen by upstream, as JSON {name:value}
//	GET /brotli-page        — brotli-decode.html served with Content-Encoding:br
//	GET /rAnD0m/sEgMnt      — akamai-payload.js (Akamai-shaped URL)
//	GET /*                  — static files from testdata/e2e/fixtures/
func startFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/echo-headers", func(w http.ResponseWriter, r *http.Request) {
		out := make(map[string][]string)
		for k, v := range r.Header {
			out[strings.ToLower(k)] = v
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	mux.HandleFunc("/echo-cookies", func(w http.ResponseWriter, r *http.Request) {
		out := make(map[string]string)
		for _, c := range r.Cookies() {
			out[c.Name] = c.Value
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	mux.HandleFunc("/brotli-page", func(w http.ResponseWriter, r *http.Request) {
		src, err := os.ReadFile(filepath.Join(fixturesDir(), "brotli-decode.html"))
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Encoding", "br")
		bw := brotli.NewWriter(w)
		_, _ = bw.Write(src)
		_ = bw.Close()
	})

	// Akamai-shaped URL: all path segments [A-Za-z0-9_], no extension.
	// Caller appends ?v=<UUID> to trigger isChallengeScript detection.
	mux.HandleFunc("/rAnD0m/sEgMnt", func(w http.ResponseWriter, r *http.Request) {
		src, err := os.ReadFile(filepath.Join(fixturesDir(), "akamai-payload.js"))
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write(src)
	})

	mux.Handle("/", http.FileServer(http.Dir(fixturesDir())))

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// startInlineServer wraps an arbitrary handler in an httptest.Server.
func startInlineServer(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// startProxy starts a full cyrano server (server.New) in an httptest.Server.
// Binding the listener before building the config avoids any TOCTOU race on
// the port number and ensures PublicURL in the config matches the actual port.
func startProxy(t *testing.T) *httptest.Server {
	t.Helper()

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	proxyOrigin := fmt.Sprintf("http://127.0.0.1:%d", port)

	cfg := &config.File{
		Servers: []config.Server{{Port: port}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"127.0.0.1", "localhost", "fixture-a.test", "fixture-b.test"},
			Mode:              "webproxy",
			SecretCookieName:  "crnsct",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
			PublicURL:         proxyOrigin,
		}},
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := server.New(cfg, assetsDir(), logger)

	srv := httptest.NewUnstartedServer(s.Handler())
	srv.Listener = l
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

// gotoURL returns the proxy URL that fetches target through the proxy.
func gotoURL(proxy *httptest.Server, target string) string {
	u, err := url.Parse(target)
	if err != nil {
		panic(fmt.Sprintf("gotoURL: invalid target %q: %v", target, err))
	}
	fragment := u.Fragment
	u.Fragment = ""
	escapedPath := u.EscapedPath()
	if escapedPath == "" {
		escapedPath = "/"
	}
	path := "/cyrano/" + u.Scheme + "/" + u.Host + escapedPath
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	result := proxy.URL + path
	if fragment != "" {
		result += "#" + fragment
	}
	return result
}

// getVia GETs target through proxy; returns (statusCode, body).
func getVia(t *testing.T, proxy *httptest.Server, target string) (int, string) {
	t.Helper()
	resp, err := http.Get(gotoURL(proxy, target))
	if err != nil {
		t.Fatalf("getVia: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// getViaRaw GETs target through proxy; caller must close the response body.
func getViaRaw(t *testing.T, proxy *httptest.Server, target string) *http.Response {
	t.Helper()
	resp, err := http.Get(gotoURL(proxy, target))
	if err != nil {
		t.Fatalf("getViaRaw: %v", err)
	}
	return resp
}

// getViaWithCookie GETs target through proxy, sending cookieHeader in the
// Cookie request header (simulates the browser's cookie jar).
func getViaWithCookie(t *testing.T, proxy *httptest.Server, target, cookieHeader string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", gotoURL(proxy, target), nil)
	req.Header.Set("Cookie", cookieHeader)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("getViaWithCookie: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// getEchoHeaders GETs /echo-headers through proxy; returns the header map.
func getEchoHeaders(t *testing.T, proxy *httptest.Server, upstreamBase string) map[string][]string {
	t.Helper()
	_, body := getVia(t, proxy, upstreamBase+"/echo-headers")
	var out map[string][]string
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode echo-headers: %v\nbody: %q", err, body)
	}
	return out
}

// getEchoCookies GETs /echo-cookies through proxy with a simulated jar cookie.
// Returns the map of cookies the upstream saw (proxy already stripped the prefix).
func getEchoCookies(t *testing.T, proxy *httptest.Server, upstreamBase, jarCookie string) map[string]string {
	t.Helper()
	_, body := getViaWithCookie(t, proxy, upstreamBase+"/echo-cookies", jarCookie)
	var out map[string]string
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode echo-cookies: %v\nbody: %q", err, body)
	}
	return out
}

// fixtureURL returns the URL for srv under a different hostname. The fixture
// server always listens on 127.0.0.1; /etc/hosts maps fixture-a.test and
// fixture-b.test to the same loopback address.
// fixtureURL returns the URL for srv under a different hostname. The fixture
// server always listens on 127.0.0.1; /etc/hosts maps fixture-a.test and
// fixture-b.test to the same loopback address.
func fixtureURL(srv *httptest.Server, hostname string) string {
	u, _ := url.Parse(srv.URL)
	return fmt.Sprintf("http://%s:%s", hostname, u.Port())
}

// noCompressionClient returns an http.Client whose transport does not
// automatically add Accept-Encoding: gzip. Use this when a test needs to
// verify what Accept-Encoding the proxy sends to the upstream.
func noCompressionClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{DisableCompression: true},
	}
}

// getViaNoCompression GETs target through proxy using a client that does not
// auto-add Accept-Encoding, so we can inspect what the proxy sets.
func getViaNoCompression(t *testing.T, proxy *httptest.Server, target string) (int, string) {
	t.Helper()
	resp, err := noCompressionClient().Get(gotoURL(proxy, target))
	if err != nil {
		t.Fatalf("getViaNoCompression: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// getEchoHeadersNoCompression like getEchoHeaders but uses a client that
// doesn't auto-add Accept-Encoding so the test can assert the proxy's value.
func getEchoHeadersNoCompression(t *testing.T, proxy *httptest.Server, upstreamBase string) map[string][]string {
	t.Helper()
	_, body := getViaNoCompression(t, proxy, upstreamBase+"/echo-headers")
	var out map[string][]string
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode echo-headers: %v\nbody: %q", err, body)
	}
	return out
}
