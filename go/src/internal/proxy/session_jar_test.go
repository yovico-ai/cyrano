package proxy

import (
	"testing"
	"time"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

func TestSessionJar_ChallengeOriginRoundtrip(t *testing.T) {
	j := NewSessionJar()

	// Unknown session → not found.
	if _, _, ok := j.ChallengeOrigin("sess-1"); ok {
		t.Fatal("expected no challenge origin before storing")
	}

	j.StoreChallengeOrigin("sess-1", "https", "claude.ai")
	scheme, host, ok := j.ChallengeOrigin("sess-1")
	if !ok || scheme != "https" || host != "claude.ai" {
		t.Fatalf("ChallengeOrigin = (%q, %q, %v), want (https, claude.ai, true)", scheme, host, ok)
	}

	// Latest write wins (a later challenge page replaces the origin).
	j.StoreChallengeOrigin("sess-1", "https", "www.example.com")
	if _, host, _ := j.ChallengeOrigin("sess-1"); host != "www.example.com" {
		t.Errorf("challenge origin not updated: got %q", host)
	}

	// Sessions are isolated.
	if _, _, ok := j.ChallengeOrigin("sess-2"); ok {
		t.Error("challenge origin leaked across sessions")
	}
}

func TestSessionJar_ChallengeOriginEmptySession(t *testing.T) {
	j := NewSessionJar()
	// Empty session ID is a no-op on store and never resolves on lookup.
	j.StoreChallengeOrigin("", "https", "claude.ai")
	if _, _, ok := j.ChallengeOrigin(""); ok {
		t.Error("empty session ID must not resolve a challenge origin")
	}
}

func stored(t *testing.T, page, setCookie string) (urlrewrite.StoredCookie, urlrewrite.SetCookie) {
	t.Helper()
	sc, ok := urlrewrite.ParseSetCookie(setCookie)
	if !ok {
		t.Fatalf("ParseSetCookie(%q) rejected", setCookie)
	}
	c, ok := urlrewrite.StoreCookie(false, page, sc)
	if !ok {
		t.Fatalf("StoreCookie(%q at %s) rejected", setCookie, page)
	}
	return c, sc
}

func TestSessionJar_StoreReplaceRemove(t *testing.T) {
	jar := NewSessionJar()
	a, _ := stored(t, "https://www.a.example/", "sid=1; HttpOnly")
	b, _ := stored(t, "https://www.a.example/", "tok=x; HttpOnly; Path=/app")
	jar.Store("s1", a, time.Time{})
	jar.Store("s1", b, time.Time{})
	a2, _ := stored(t, "https://www.a.example/", "sid=2; HttpOnly")
	jar.Store("s1", a2, time.Time{}) // same identity: replaced in place
	got := jar.Cookies("s1")
	if len(got) != 2 || got[0].Value != "2" || got[1].Name != "tok" {
		t.Fatalf("Cookies = %+v", got)
	}
	if len(jar.Cookies("s2")) != 0 || len(jar.Cookies("")) != 0 {
		t.Error("another session, or none, sees the cookies")
	}
	jar.Remove("s1", a)
	if got := jar.Cookies("s1"); len(got) != 1 || got[0].Name != "tok" {
		t.Fatalf("after Remove: %+v", got)
	}
}

func TestSessionJar_Expiry(t *testing.T) {
	jar := NewSessionJar()
	a, _ := stored(t, "https://a.example/", "old=1; HttpOnly")
	b, _ := stored(t, "https://a.example/", "live=1; HttpOnly")
	jar.Store("s", a, time.Now().Add(-time.Second))
	jar.Store("s", b, time.Now().Add(time.Hour))
	if got := jar.Cookies("s"); len(got) != 1 || got[0].Name != "live" {
		t.Fatalf("Cookies = %+v", got)
	}
}
