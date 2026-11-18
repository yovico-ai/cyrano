package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// SessionJar keeps, per session, the cookies page scripts must never see:
// HttpOnly ones. They are scoped and chosen by the same rules as every
// other cookie (spec/Cookies.agda; urlrewrite.StoredCookie). Script-visible
// cookies live in the browser's own jar under their wire names.
type SessionJar struct {
	mu               sync.Mutex
	entries          map[string][]jarEntry // sessionID → cookies, in creation order
	challengeOrigins map[string][2]string  // sessionID → [scheme, host] of last challenge page
}

type jarEntry struct {
	c       urlrewrite.StoredCookie
	expires time.Time // zero = a session cookie
}

// NewSessionJar returns an empty in-memory jar.
func NewSessionJar() *SessionJar {
	return &SessionJar{
		entries:          make(map[string][]jarEntry),
		challengeOrigins: make(map[string][2]string),
	}
}

// StoreChallengeOrigin records the origin (scheme + host) of the challenge
// page most recently served to sessionID. Used to route bare-path
// /cdn-cgi/challenge-platform/ requests from blob workers (which have no
// Referer) back to the correct upstream.
func (j *SessionJar) StoreChallengeOrigin(sessionID, scheme, host string) {
	if sessionID == "" {
		return
	}
	j.mu.Lock()
	j.challengeOrigins[sessionID] = [2]string{scheme, host}
	j.mu.Unlock()
}

// ChallengeOrigin returns the scheme and host stored by StoreChallengeOrigin
// for sessionID. Returns ("", "", false) when none is found.
func (j *SessionJar) ChallengeOrigin(sessionID string) (scheme, host string, ok bool) {
	if sessionID == "" {
		return "", "", false
	}
	j.mu.Lock()
	v, found := j.challengeOrigins[sessionID]
	j.mu.Unlock()
	if !found {
		return "", "", false
	}
	return v[0], v[1], true
}

// GenerateSessionID returns a cryptographically random 128-bit hex session ID.
func GenerateSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// sameIdentity: the RFC's cookie identity — name, domain, path, host-only.
func sameIdentity(a, b urlrewrite.StoredCookie) bool {
	return a.Name == b.Name && a.Domain == b.Domain && a.Path == b.Path && a.HostOnly == b.HostOnly
}

// Store keeps c for the session, replacing a cookie of the same identity
// (in its place: creation order is the first creation's). expires zero is a
// session cookie.
func (j *SessionJar) Store(sessionID string, c urlrewrite.StoredCookie, expires time.Time) {
	if sessionID == "" {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	es := j.entries[sessionID]
	for i := range es {
		if sameIdentity(es[i].c, c) {
			es[i] = jarEntry{c, expires}
			return
		}
	}
	j.entries[sessionID] = append(es, jarEntry{c, expires})
}

// Remove drops the cookie with c's identity, if the session has one.
func (j *SessionJar) Remove(sessionID string, c urlrewrite.StoredCookie) {
	j.mu.Lock()
	defer j.mu.Unlock()
	es := j.entries[sessionID]
	for i := range es {
		if sameIdentity(es[i].c, c) {
			j.entries[sessionID] = append(es[:i:i], es[i+1:]...)
			return
		}
	}
}

// Cookies returns the session's live cookies in creation order, evicting
// expired ones.
func (j *SessionJar) Cookies(sessionID string) []urlrewrite.StoredCookie {
	if sessionID == "" {
		return nil
	}
	now := time.Now()
	j.mu.Lock()
	defer j.mu.Unlock()
	es := j.entries[sessionID]
	live := es[:0]
	out := make([]urlrewrite.StoredCookie, 0, len(es))
	for _, e := range es {
		if !e.expires.IsZero() && !e.expires.After(now) {
			continue
		}
		live = append(live, e)
		out = append(out, e.c)
	}
	j.entries[sessionID] = live
	return out
}
