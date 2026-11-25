package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/yovico/cyrano/internal/cookiejar"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// SessionJar keeps, per session, every cookie of the proxied sites — the
// script-visible ones too — in a cookiejar.Jar (spec/CookieJar.agda: the
// jar with Chromium's limits per registrable domain). The browser's own jar
// carries only the channel: outbox entries (a script's write) and inbox
// entries (a change scripts see), so it never nears its own limit.
//
// A jar outlives the server: it is kept in dir, one file per session,
// written soon after it changes and read when the session is first seen.
// The browser session is recorded with it: when a request names another
// (the browser was restarted), the session cookies are gone, as natively.
type SessionJar struct {
	mu               sync.Mutex
	dir              string
	sessions         map[string]*session
	challengeOrigins map[string][2]string // sessionID → [scheme, host] of last challenge page
	dirty            map[string]bool
	flushing         bool
}

type session struct {
	Jar            cookiejar.Jar `json:"jar"`
	BrowserSession string        `json:"bs"`
	Issued         int64         `json:"bsAt"` // when the marker was issued (unix seconds)
	MarkerSeen     bool          `json:"bsSeen"` // a request has come with it: the browser has it
	Micro          bool          `json:"us"`     // the jar's times are µs (before 2026-11-25: ms)
	undelivered    []string      // inbox entries of failed responses, for the next one
}

// NewSessionJar returns a jar kept in dir ("" keeps it in memory only).
func NewSessionJar(dir ...string) *SessionJar {
	j := &SessionJar{
		sessions:         make(map[string]*session),
		challengeOrigins: make(map[string][2]string),
		dirty:            make(map[string]bool),
	}
	if len(dir) > 0 && dir[0] != "" {
		j.dir = dir[0]
		_ = os.MkdirAll(j.dir, 0o700)
	}
	return j
}

// DefaultCookieDir is where jars are kept unless CYRANO_COOKIE_DIR says.
func DefaultCookieDir() string {
	if d := os.Getenv("CYRANO_COOKIE_DIR"); d != "" {
		return d
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "cyrano", "cookies")
}

func validSessionID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

// get is the session's state, read from disk on first use; j.mu held.
func (j *SessionJar) get(id string) *session {
	if s, ok := j.sessions[id]; ok {
		return s
	}
	s := &session{Micro: true}
	if j.dir != "" && validSessionID(id) {
		if b, err := os.ReadFile(filepath.Join(j.dir, id+".json")); err == nil {
			_ = json.Unmarshal(b, s)
		}
		if !s.Micro {
			s.Jar.ToMicro() // a jar written in ms
		}
	}
	j.sessions[id] = s
	return s
}

// changed marks the session for writing out; j.mu held.
func (j *SessionJar) changed(id string) {
	if j.dir == "" || !validSessionID(id) {
		return
	}
	j.dirty[id] = true
	if !j.flushing {
		j.flushing = true
		time.AfterFunc(time.Second, j.flush)
	}
}

func (j *SessionJar) flush() {
	j.mu.Lock()
	out := make(map[string][]byte, len(j.dirty))
	for id := range j.dirty {
		if b, err := json.Marshal(j.sessions[id]); err == nil {
			out[id] = b
		}
	}
	j.dirty = make(map[string]bool)
	j.flushing = false
	j.mu.Unlock()
	for id, b := range out {
		p := filepath.Join(j.dir, id+".json")
		tmp := p + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, p)
		}
	}
}

// With runs f on the session's jar, under the jar's lock; the jar is then
// written out.
func (j *SessionJar) With(sessionID string, f func(*cookiejar.Jar)) {
	if sessionID == "" {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	f(&j.get(sessionID).Jar)
	j.changed(sessionID)
}

// NoteBrowserSession takes a request of sessionID's browser-session marker
// ("" when it came without one) and gives the marker the response must
// set ("" for none). A request without one is the first of a browser
// session (the marker is a session cookie: the browser was restarted): the
// session cookies end, as natively, and a new marker is issued — the same
// one to a request without a marker in the next 30 seconds while none has
// come with it yet (they were sent before the browser had it; once one has
// come with it, a request without one is a restart). A request with a
// marker other than the jar's is taken at its word.
func (j *SessionJar) NoteBrowserSession(sessionID, marker string) string {
	if sessionID == "" {
		return ""
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.get(sessionID)
	if marker != "" {
		if s.BrowserSession != marker || !s.MarkerSeen {
			s.BrowserSession, s.MarkerSeen = marker, true
			j.changed(sessionID)
		}
		return ""
	}
	now := time.Now().Unix()
	if s.BrowserSession != "" && !s.MarkerSeen && now-s.Issued < 30 {
		return s.BrowserSession
	}
	s.Jar.EndSession()
	s.BrowserSession, s.Issued, s.MarkerSeen = GenerateSessionID(), now, false
	j.changed(sessionID)
	return s.BrowserSession
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

// unixNow is the jar's clock: µs after the epoch (Chromium's cookie clock).
func unixNow() uint64 { return uint64(time.Now().UnixMicro()) }

// Store keeps c for the session (expires zero: a session cookie), as a
// response's Set-Cookie would; site is its registrable domain.
func (j *SessionJar) Store(sessionID string, c urlrewrite.StoredCookie, expires time.Time) {
	e := cookiejar.Expiry{Session: expires.IsZero()}
	if !e.Session {
		e.Until = uint64(expires.UnixMicro())
	}
	j.With(sessionID, func(jar *cookiejar.Jar) {
		jar.Put(false, unixNow(), cookieSite(c.Domain), cookiejar.Change{Cookie: c, Expiry: e})
	})
}

// Remove drops the cookie with c's identity, if the session has one.
func (j *SessionJar) Remove(sessionID string, c urlrewrite.StoredCookie) {
	j.With(sessionID, func(jar *cookiejar.Jar) {
		jar.Put(false, unixNow(), cookieSite(c.Domain), cookiejar.Change{Cookie: c, Gone: true})
	})
}

// Cookies returns the session's live cookies in creation order.
func (j *SessionJar) Cookies(sessionID string) []urlrewrite.StoredCookie {
	if sessionID == "" {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.get(sessionID).Jar.Live(unixNow())
}

// Snapshot is what a document at pageURL is given of the session's jar
// (spec CookieJar.snapshot): the script-visible cookies shown there, as
// inbox entries of the jar's generation, and that generation. The runtime
// keeps them in memory; the channel keeps them current.
// Only what the document's context lists (spec Cookies.inCtx), and the
// context itself ("x": cross-site, "k": its partition key) for the
// runtime's own writes and reads.
func (j *SessionJar) Snapshot(sessionID, pageURL string, cx urlrewrite.CookieCtx) map[string]any {
	entries := []string{}
	var gen uint64
	if sessionID != "" {
		j.mu.Lock()
		jar := &j.get(sessionID).Jar
		gen = jar.Gen
		now := unixNow()
		for _, e := range jar.Entries {
			if !e.Expiry.Alive(now) || e.Cookie.HTTPOnly || !urlrewrite.MatchesURL(true, pageURL, e.Cookie) || !urlrewrite.InCtx(true, cx, e.Cookie) {
				continue
			}
			ch := cookiejar.Change{Cookie: e.Cookie, Expiry: e.Expiry}
			a := jar.LastApplied(e.Cookie)
			entries = append(entries, cookiejar.ChanName(true, ch), cookiejar.ChanValue(ch, gen, &a))
		}
		j.mu.Unlock()
	}
	return map[string]any{"g": gen, "e": entries, "x": cx.Cross, "k": cx.Key()}
}

// KeepUndelivered keeps inbox entries a failed response could not carry.
func (j *SessionJar) KeepUndelivered(sessionID string, entries []string) {
	if sessionID == "" || len(entries) == 0 {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.get(sessionID)
	s.undelivered = append(s.undelivered, entries...)
	if len(s.undelivered) > 64 {
		s.undelivered = s.undelivered[len(s.undelivered)-64:]
	}
}

// TakeUndelivered hands them to the session's next response.
func (j *SessionJar) TakeUndelivered(sessionID string) []string {
	if sessionID == "" {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.get(sessionID)
	out := s.undelivered
	s.undelivered = nil
	return out
}
