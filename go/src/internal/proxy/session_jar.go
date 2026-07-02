package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SessionJar stores HttpOnly cookies server-side, keyed by session ID and
// eTLD+1. HttpOnly cookies cannot be read by page JS anyway; keeping them
// here instead of in the browser eliminates cookie pollution across proxied
// sites and prevents upstream session tokens from accumulating in browser
// storage forever.
type SessionJar struct {
	mu               sync.Mutex
	entries          map[string]map[string][]*jarEntry // sessionID → siteKey → entries
	challengeOrigins map[string][2]string              // sessionID → [scheme, host] of last challenge page
}

type jarEntry struct {
	name    string
	value   string
	path    string    // defaults to "/"
	domain  string    // lowercase, no leading dot
	exact   bool      // true iff no Domain attr → scope to setHost only
	setHost string    // bare host that issued the cookie
	expires time.Time // zero = session cookie (no expiry)
}

// NewSessionJar returns an empty in-memory jar.
func NewSessionJar() *SessionJar {
	return &SessionJar{
		entries:          make(map[string]map[string][]*jarEntry),
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

// StoreServerCookies processes HttpOnly Set-Cookie entries from an upstream
// response and persists them under sessionID. Deletion directives (MaxAge < 0
// or an Expires already in the past) remove the matching entry.
func (j *SessionJar) StoreServerCookies(sessionID, upstreamHost string, cookies []*http.Cookie) {
	if sessionID == "" || len(cookies) == 0 {
		return
	}
	bh := jarBareHost(upstreamHost)
	siteKey := cookieSiteKey(upstreamHost)
	now := time.Now()

	j.mu.Lock()
	defer j.mu.Unlock()

	if j.entries[sessionID] == nil {
		j.entries[sessionID] = make(map[string][]*jarEntry)
	}
	entries := j.entries[sessionID][siteKey]

	for _, c := range cookies {
		// Deletion directive: MaxAge < 0 takes precedence over everything.
		// Also honour an Expires in the past when no MaxAge is set.
		isDeletion := c.MaxAge < 0 ||
			(c.MaxAge == 0 && !c.Expires.IsZero() && c.Expires.Before(now))
		if isDeletion {
			entries = removeJarEntry(entries, c.Name, bh, jarCanonDomain(c.Domain))
			continue
		}
		ent := &jarEntry{
			name:    c.Name,
			value:   c.Value,
			path:    c.Path,
			setHost: bh,
		}
		if ent.path == "" {
			ent.path = "/"
		}
		if c.Domain == "" {
			ent.exact = true
		} else {
			ent.domain = jarCanonDomain(c.Domain)
		}
		if c.MaxAge > 0 {
			ent.expires = now.Add(time.Duration(c.MaxAge) * time.Second)
		} else if !c.Expires.IsZero() {
			ent.expires = c.Expires
		}
		entries = upsertJarEntry(entries, ent)
	}
	j.entries[sessionID][siteKey] = entries
}

// RetrieveForRequest returns all non-expired jar cookies applicable to
// (sessionID, host, path). Expired entries are evicted as a side effect.
func (j *SessionJar) RetrieveForRequest(sessionID, host, path string) []*http.Cookie {
	if sessionID == "" {
		return nil
	}
	siteKey := cookieSiteKey(host)
	bh := jarBareHost(host)
	if path == "" {
		path = "/"
	}
	now := time.Now()

	j.mu.Lock()
	defer j.mu.Unlock()

	entries, ok := j.entries[sessionID][siteKey]
	if !ok {
		return nil
	}

	// Filter in-place: keep live entries, collect matching ones for caller.
	live := entries[:0]
	var result []*http.Cookie
	for _, ent := range entries {
		if !ent.expires.IsZero() && ent.expires.Before(now) {
			continue // expired — evict
		}
		live = append(live, ent)
		if jarMatchesDomain(bh, ent) && jarMatchesPath(path, ent.path) {
			result = append(result, &http.Cookie{Name: ent.name, Value: ent.value})
		}
	}
	j.entries[sessionID][siteKey] = live
	return result
}

// ForPageCookies returns all non-expired cookies applicable to (sessionID,
// host) as Set-Cookie-style strings — without the HttpOnly/Secure/Domain
// attributes — for injection into the page bootstrap script. Path and
// Max-Age are preserved so the client's in-memory store can apply them.
// Path filtering is intentionally omitted here; the client filters at read
// time based on the current upstream URL's pathname.
func (j *SessionJar) ForPageCookies(sessionID, host string) []string {
	if sessionID == "" {
		return nil
	}
	siteKey := cookieSiteKey(host)
	bh := jarBareHost(host)
	now := time.Now()

	j.mu.Lock()
	defer j.mu.Unlock()

	entries, ok := j.entries[sessionID][siteKey]
	if !ok {
		return nil
	}

	live := entries[:0]
	var result []string
	for _, ent := range entries {
		if !ent.expires.IsZero() && ent.expires.Before(now) {
			continue // expired — evict
		}
		live = append(live, ent)
		if !jarMatchesDomain(bh, ent) {
			continue
		}
		s := ent.name + "=" + ent.value
		if ent.path != "" {
			s += "; Path=" + ent.path
		} else {
			s += "; Path=/"
		}
		if !ent.expires.IsZero() {
			if remaining := int(time.Until(ent.expires).Seconds()); remaining > 0 {
				s += "; Max-Age=" + strconv.Itoa(remaining)
			}
		}
		result = append(result, s)
	}
	j.entries[sessionID][siteKey] = live
	return result
}

// ParseSetCookieHeader parses a single Set-Cookie header string into an
// *http.Cookie using the standard library's own parser.
func ParseSetCookieHeader(raw string) *http.Cookie {
	h := http.Header{}
	h.Add("Set-Cookie", raw)
	if cookies := (&http.Response{Header: h}).Cookies(); len(cookies) > 0 {
		return cookies[0]
	}
	return &http.Cookie{}
}

// ── internal helpers ────────────────────────────────────────────────────────

func jarCanonDomain(d string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(d)), ".")
}

func jarBareHost(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

func jarMatchesDomain(host string, ent *jarEntry) bool {
	if ent.exact {
		return strings.EqualFold(host, ent.setHost)
	}
	h := strings.ToLower(host)
	return h == ent.domain || strings.HasSuffix(h, "."+ent.domain)
}

// jarMatchesPath implements RFC 6265 §5.1.4.
func jarMatchesPath(reqPath, cookiePath string) bool {
	if cookiePath == "" || cookiePath == "/" {
		return true
	}
	if reqPath == cookiePath {
		return true
	}
	if strings.HasPrefix(reqPath, cookiePath) {
		return cookiePath[len(cookiePath)-1] == '/' || reqPath[len(cookiePath)] == '/'
	}
	return false
}

// upsertJarEntry replaces an existing entry with the same (name, scope, path)
// or appends ent if no match is found. Cookie identity per RFC 6265: name +
// domain + path.
func upsertJarEntry(entries []*jarEntry, ent *jarEntry) []*jarEntry {
	for i, e := range entries {
		if e.name == ent.name && e.path == ent.path &&
			e.exact == ent.exact && e.setHost == ent.setHost && e.domain == ent.domain {
			entries[i] = ent
			return entries
		}
	}
	return append(entries, ent)
}

func removeJarEntry(entries []*jarEntry, name, host, domain string) []*jarEntry {
	out := entries[:0]
	for _, e := range entries {
		match := e.name == name &&
			((e.exact && strings.EqualFold(e.setHost, host)) ||
				(!e.exact && e.domain == domain))
		if !match {
			out = append(out, e)
		}
	}
	return out
}
