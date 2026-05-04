package proxy

import (
	"net/http"
	"testing"
	"time"
)

func TestSessionJar_BasicRoundtrip(t *testing.T) {
	jar := NewSessionJar()
	sess := "testsession"
	upstream := "www.example.com"

	cookies := []*http.Cookie{
		{Name: "session", Value: "abc123", HttpOnly: true, Path: "/"},
		{Name: "cf_clearance", Value: "xyz789", HttpOnly: true, Path: "/"},
	}
	jar.StoreServerCookies(sess, upstream, cookies)

	got := jar.RetrieveForRequest(sess, upstream, "/")
	if len(got) != 2 {
		t.Fatalf("want 2 cookies, got %d", len(got))
	}
	names := map[string]string{}
	for _, c := range got {
		names[c.Name] = c.Value
	}
	if names["session"] != "abc123" {
		t.Errorf("session cookie: got %q", names["session"])
	}
	if names["cf_clearance"] != "xyz789" {
		t.Errorf("cf_clearance cookie: got %q", names["cf_clearance"])
	}
}

func TestSessionJar_DifferentSessionsIsolated(t *testing.T) {
	jar := NewSessionJar()
	jar.StoreServerCookies("sess-A", "example.com", []*http.Cookie{
		{Name: "token", Value: "aaa", HttpOnly: true},
	})
	jar.StoreServerCookies("sess-B", "example.com", []*http.Cookie{
		{Name: "token", Value: "bbb", HttpOnly: true},
	})

	a := jar.RetrieveForRequest("sess-A", "example.com", "/")
	b := jar.RetrieveForRequest("sess-B", "example.com", "/")

	if len(a) != 1 || a[0].Value != "aaa" {
		t.Errorf("sess-A: unexpected %v", a)
	}
	if len(b) != 1 || b[0].Value != "bbb" {
		t.Errorf("sess-B: unexpected %v", b)
	}
}

func TestSessionJar_SiteKeyScoping(t *testing.T) {
	// Cookies set by www.example.com should be visible to api.example.com
	// when the cookie has a Domain=.example.com attribute.
	jar := NewSessionJar()
	jar.StoreServerCookies("s", "www.example.com", []*http.Cookie{
		{Name: "shared", Value: "v1", HttpOnly: true, Domain: ".example.com", Path: "/"},
	})

	got := jar.RetrieveForRequest("s", "api.example.com", "/")
	if len(got) != 1 || got[0].Value != "v1" {
		t.Errorf("subdomain cookie not visible: %v", got)
	}
}

func TestSessionJar_ExactHostScoping(t *testing.T) {
	// No Domain attribute → cookie must only be sent to the exact setting host.
	jar := NewSessionJar()
	jar.StoreServerCookies("s", "www.example.com", []*http.Cookie{
		{Name: "exact", Value: "only-www", HttpOnly: true, Path: "/"},
	})

	got := jar.RetrieveForRequest("s", "api.example.com", "/")
	if len(got) != 0 {
		t.Errorf("exact-host cookie leaked to subdomain: %v", got)
	}
	got = jar.RetrieveForRequest("s", "www.example.com", "/")
	if len(got) != 1 {
		t.Errorf("exact-host cookie not returned for setting host: %v", got)
	}
}

func TestSessionJar_PathScoping(t *testing.T) {
	jar := NewSessionJar()
	jar.StoreServerCookies("s", "example.com", []*http.Cookie{
		{Name: "admin", Value: "x", HttpOnly: true, Path: "/admin"},
	})

	if got := jar.RetrieveForRequest("s", "example.com", "/admin/users"); len(got) != 1 {
		t.Errorf("/admin/users: want 1, got %d", len(got))
	}
	if got := jar.RetrieveForRequest("s", "example.com", "/"); len(got) != 0 {
		t.Errorf("/: want 0, got %d", len(got))
	}
	if got := jar.RetrieveForRequest("s", "example.com", "/admintools"); len(got) != 0 {
		t.Errorf("/admintools: want 0, got %d (path must be followed by /)", len(got))
	}
}

func TestSessionJar_Expiry(t *testing.T) {
	jar := NewSessionJar()
	jar.StoreServerCookies("s", "example.com", []*http.Cookie{
		{Name: "short", Value: "v", HttpOnly: true, MaxAge: -1}, // deleted immediately
	})
	got := jar.RetrieveForRequest("s", "example.com", "/")
	if len(got) != 0 {
		t.Errorf("MaxAge=-1 cookie should not be stored: %v", got)
	}
}

func TestSessionJar_MaxAgeExpiry(t *testing.T) {
	jar := NewSessionJar()
	// Store with a MaxAge that has already elapsed.
	entry := &http.Cookie{Name: "stale", Value: "v", HttpOnly: true, MaxAge: 1}
	jar.StoreServerCookies("s", "example.com", []*http.Cookie{entry})

	// Manually backdate the stored entry so it looks expired.
	jar.mu.Lock()
	for _, entries := range jar.entries["s"] {
		for _, e := range entries {
			if e.name == "stale" {
				e.expires = time.Now().Add(-time.Second)
			}
		}
	}
	jar.mu.Unlock()

	got := jar.RetrieveForRequest("s", "example.com", "/")
	if len(got) != 0 {
		t.Errorf("expired cookie should not be returned: %v", got)
	}
}

func TestSessionJar_Upsert(t *testing.T) {
	jar := NewSessionJar()
	jar.StoreServerCookies("s", "example.com", []*http.Cookie{
		{Name: "tok", Value: "old", HttpOnly: true, Path: "/"},
	})
	jar.StoreServerCookies("s", "example.com", []*http.Cookie{
		{Name: "tok", Value: "new", HttpOnly: true, Path: "/"},
	})
	got := jar.RetrieveForRequest("s", "example.com", "/")
	if len(got) != 1 || got[0].Value != "new" {
		t.Errorf("upsert should replace old value: %v", got)
	}
}

func TestSessionJar_Deletion(t *testing.T) {
	jar := NewSessionJar()
	jar.StoreServerCookies("s", "example.com", []*http.Cookie{
		{Name: "tok", Value: "v", HttpOnly: true, Path: "/"},
	})
	// Deletion directive via MaxAge=-1
	jar.StoreServerCookies("s", "example.com", []*http.Cookie{
		{Name: "tok", Value: "", HttpOnly: true, MaxAge: -1},
	})
	got := jar.RetrieveForRequest("s", "example.com", "/")
	if len(got) != 0 {
		t.Errorf("deleted cookie should not be returned: %v", got)
	}
}

func TestParseSetCookieHeader(t *testing.T) {
	cases := []struct {
		raw      string
		httpOnly bool
		name     string
		value    string
	}{
		{"session=abc; Path=/; HttpOnly; Secure", true, "session", "abc"},
		{"pref=dark; Path=/; SameSite=Lax", false, "pref", "dark"},
		{"cf_clearance=xyz; Path=/; Secure; HttpOnly; SameSite=None", true, "cf_clearance", "xyz"},
	}
	for _, tc := range cases {
		c := ParseSetCookieHeader(tc.raw)
		if c.HttpOnly != tc.httpOnly {
			t.Errorf("%q: HttpOnly=%v want %v", tc.raw, c.HttpOnly, tc.httpOnly)
		}
		if c.Name != tc.name || c.Value != tc.value {
			t.Errorf("%q: got %q=%q", tc.raw, c.Name, c.Value)
		}
	}
}

func TestJarMatchesPath(t *testing.T) {
	cases := []struct {
		req, cookie string
		want        bool
	}{
		{"/", "/", true},
		{"/any/path", "/", true},
		{"/admin/users", "/admin", true},
		{"/admin/users", "/admin/", true},
		{"/", "/admin", false},
		{"/admintools", "/admin", false}, // must be followed by /
	}
	for _, tc := range cases {
		got := jarMatchesPath(tc.req, tc.cookie)
		if got != tc.want {
			t.Errorf("jarMatchesPath(%q, %q) = %v; want %v", tc.req, tc.cookie, got, tc.want)
		}
	}
}
