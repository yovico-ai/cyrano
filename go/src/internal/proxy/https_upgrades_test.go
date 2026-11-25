package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func navigation(path, session string) *http.Request {
	r := httptest.NewRequest("GET", path, nil)
	r.Header.Set("Sec-Fetch-Mode", "navigate")
	r.Header.Set("Sec-Fetch-Dest", "document")
	r.AddCookie(&http.Cookie{Name: "crnsct", Value: session})
	return r
}

func upgradeHandler() *Handler {
	return New(Options{CookieJar: NewSessionJar(), SessionCookieName: "crnsct"})
}

// times.com: https answers with another site's certificate, http works.
// The navigation goes to https first and falls back to http, once.
func TestHTTPSUpgrade_FallsBackWhenHTTPSFails(t *testing.T) {
	h := upgradeHandler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, navigation("/cyrano/http/no-https.com/a?b=1", "s1"))
	if rec.Code != http.StatusTemporaryRedirect || rec.Header().Get("Location") != "/cyrano/https/no-https.com/a?b=1" {
		t.Fatalf("http navigation: %d %q; want 307 to the https URL", rec.Code, rec.Header().Get("Location"))
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, navigation("/cyrano/https/no-https.com/a?b=1", "s1"))
	if rec.Code != http.StatusTemporaryRedirect || rec.Header().Get("Location") != "/cyrano/http/no-https.com/a?b=1" {
		t.Fatalf("failed https load: %d %q; want 307 back to http", rec.Code, rec.Header().Get("Location"))
	}
	if h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/no-https.com/", "s1"), "no-https.com") {
		t.Fatal("an http-only host was upgraded again")
	}
	// Another session has not learnt it.
	if !h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/no-https.com/", "s2"), "no-https.com") {
		t.Fatal("another session's navigation was not upgraded")
	}
}

// An https page that redirects straight back to http: http it is.
func TestHTTPSUpgrade_RedirectBackToHTTPIsFallback(t *testing.T) {
	h := upgradeHandler()
	if !h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/back.com/", "s"), "back.com") {
		t.Fatal("not upgraded")
	}
	if h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/back.com/", "s"), "back.com") {
		t.Fatal("the http navigation after the upgrade was upgraded again (loop)")
	}
}

// An upgrade that reached its page is over: a later http link is upgraded.
func TestHTTPSUpgrade_LoadedClearsPending(t *testing.T) {
	h := upgradeHandler()
	h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/ok.com/", "s"), "ok.com")
	out := navigation("/", "s")
	out.URL = &url.URL{Scheme: "https", Host: "ok.com", Path: "/"}
	upgradeLoaded(&http.Response{StatusCode: 200, Request: out}, "s")
	if !h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/ok.com/x", "s"), "ok.com") {
		t.Fatal("a later http navigation was not upgraded")
	}
}

func TestHTTPSUpgrade_OnlyMainFrameNavigationsToNames(t *testing.T) {
	h := upgradeHandler()
	sub := httptest.NewRequest("GET", "/cyrano/http/img.example/a.png", nil)
	sub.Header.Set("Sec-Fetch-Mode", "no-cors")
	sub.Header.Set("Sec-Fetch-Dest", "image")
	if h.upgradeNavigation(httptest.NewRecorder(), sub, "img.example") {
		t.Error("a subresource was upgraded")
	}
	for _, host := range []string{"127.0.0.1", "[::1]", "localhost", "intranet", "a.example:8080", "x.localhost"} {
		if h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/"+host+"/", "s"), host) {
			t.Errorf("%s was upgraded", host)
		}
	}
	if !h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/a.com:80/", "s"), "a.com:80") {
		t.Error("a.com:80 was not upgraded")
	}
}

// A navigation that cannot reach its origin (and was no upgrade) gets an
// error page, as a direct browser shows one; an https one offers http.
func TestNavigationError_Page(t *testing.T) {
	h := upgradeHandler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, navigation("/cyrano/https/unreachable.invalid/p", "s"))
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), `href="/cyrano/http/unreachable.invalid/p"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// hangingTransport never answers: a 443 that accepts and says nothing.
type hangingTransport struct{}

func (hangingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	<-r.Context().Done()
	return nil, r.Context().Err()
}

// An upgraded navigation whose https load gets no response falls back to
// http after Chrome's limit (measured: 3.0 s), not the upstream's timeout.
func TestHTTPSUpgrade_FallsBackAfterTheAttemptsLimit(t *testing.T) {
	h := New(Options{CookieJar: NewSessionJar(), SessionCookieName: "crnsct", Transport: hangingTransport{}})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, navigation("/cyrano/http/slow-https.com/", "s1"))
	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("http navigation: %d; want the upgrade", rec.Code)
	}
	start := time.Now()
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, navigation("/cyrano/https/slow-https.com/", "s1"))
	took := time.Since(start)
	if rec.Code != http.StatusTemporaryRedirect || rec.Header().Get("Location") != "/cyrano/http/slow-https.com/" {
		t.Fatalf("hanging https load: %d %q; want 307 back to http", rec.Code, rec.Header().Get("Location"))
	}
	if took < upgradeAttempt-100*time.Millisecond || took > upgradeAttempt+time.Second {
		t.Fatalf("fell back after %v; want about %v", took, upgradeAttempt)
	}
}
