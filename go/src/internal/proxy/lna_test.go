package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// A public document's subresource request to a loopback (or private)
// address is refused before it is sent; a navigation is not judged, nor a
// loopback document's request (spec/Lna.agda).
func TestLNA_PublicDocumentToLoopback(t *testing.T) {
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/res") {
			hits.Add(1)
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<p>x")
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	port := u.Port()
	// 127.0.0.1 plays a public host, localhost the loopback one.
	spaceOf := func(host string) (urlrewrite.AddressSpace, bool) {
		if host == "localhost" {
			return urlrewrite.SpaceLoopback, true
		}
		return urlrewrite.SpacePublic, true
	}
	front := httptest.NewServer(nil)
	defer front.Close()
	pubURL, _ := url.Parse(front.URL)
	// A session, as every real request has: the page's space is kept under it.
	front.Config.Handler = New(Options{LNASpaceOf: spaceOf, ProxyCfg: urlrewrite.ProxyConfig{PublicURL: pubURL}, CookieJar: NewSessionJar(), SessionCookieName: "crnsct"})
	get := func(path, referer, dest, mode string) (int, error) {
		req, _ := http.NewRequest("GET", front.URL+path, nil)
		if referer != "" {
			req.Header.Set("Referer", referer)
		}
		req.Header.Set("Sec-Fetch-Dest", dest)
		req.AddCookie(&http.Cookie{Name: "crnsct", Value: "0123456789abcdef0123456789abcdef"})
		req.Header.Set("Sec-Fetch-Mode", mode)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, err
		}
		_, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	pub := "http://127.0.0.1:" + port + "/page"
	loop := "http://localhost:" + port + "/page"
	for _, doc := range []string{pub, loop} {
		if _, err := get(cyranoPath(doc), "", "document", "navigate"); err != nil {
			t.Fatal(err)
		}
	}
	res := "http://localhost:" + port + "/res"
	if _, err := get(cyranoPath(res), front.URL+cyranoPath(pub), "image", "no-cors"); err == nil {
		t.Fatalf("public document → loopback image: delivered")
	}
	if hits.Load() != 0 {
		t.Fatalf("the refused request reached the target")
	}
	if _, err := get(cyranoPath(res), front.URL+cyranoPath(pub), "document", "navigate"); err != nil {
		t.Fatalf("navigation refused: %v", err)
	}
	if _, err := get(cyranoPath(res), front.URL+cyranoPath(loop), "image", "no-cors"); err != nil {
		t.Fatalf("loopback document → loopback refused: %v", err)
	}
}
