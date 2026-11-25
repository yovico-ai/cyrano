package proxy

// HTTPS-Upgrades, as Chrome does them: a main-frame navigation to an http://
// URL is tried over https first and falls back to http when the https load
// fails (no connection, a certificate for another name — times.com) or comes
// straight back to http. The page sees what it sees direct: the https page
// when there is one, else the http page at its http URL.
//
// A direct Chrome upgrades inside its network stack; through the proxy the
// browser is sent from /cyrano/http/… to /cyrano/https/… (a 307), and on
// failure back again, after which the host is remembered as http-only for
// the session (Chrome keeps such an allowlist too).

import (
	"context"
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

const (
	upgradePending  = 30 * time.Second // an upgrade's https load must start within this
	upgradeFallback = 7 * 24 * time.Hour
	upgradeStoreMax = 8192
)

type upgradeStore struct {
	mu       sync.Mutex
	pending  map[string]time.Time // session + "\x00" + host → when the upgrade was sent
	fallback map[string]time.Time // http-only hosts → when it was found
}

var upgrades upgradeStore

func (s *upgradeStore) mark(m *map[string]time.Time, key string) {
	if *m == nil {
		*m = make(map[string]time.Time)
	}
	if len(*m) >= upgradeStoreMax {
		for k := range *m {
			delete(*m, k)
			break
		}
	}
	(*m)[key] = upgradeClock()
}

// upgradeClock is the time the upgrade state is kept by (a test's own).
var upgradeClock = time.Now

func fresh(m map[string]time.Time, key string, ttl time.Duration) bool {
	t, ok := m[key]
	return ok && upgradeClock().Sub(t) < ttl
}

// upgradable reports whether Chrome would try a navigation to host over
// https (spec/Upgrades.agda upgradable): a name (not an IP literal, not
// localhost) on the default port that is unique — more than one label,
// the last a known ICANN TLD (Chromium IsHostnameNonUnique; a.example and
// x.test are not upgraded).
func upgradable(host string) bool {
	h, port, err := net.SplitHostPort(host)
	if err != nil {
		h, port = host, ""
	}
	if port != "" && port != "80" {
		return false
	}
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	if h == "" || net.ParseIP(strings.Trim(h, "[]")) != nil || !strings.Contains(h, ".") ||
		h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return false
	}
	return knownTLD(h)
}

// knownTLD: the name's last label is a top-level domain of the
// public-suffix list's ICANN section. With a second label this is what
// makes a name unique to Chromium (recorded in Chrome: co.uk and a.ck are
// upgraded though they are public suffixes; a.example is not).
func knownTLD(h string) bool {
	// Asked of a name under it: a TLD listed only by a wildcard (*.ck)
	// is no rule of its own.
	_, icann := publicsuffix.PublicSuffix("x." + h[strings.LastIndexByte(h, '.')+1:])
	return icann
}

func isMainFrameNavigation(r *http.Request) bool {
	return r.Method == http.MethodGet &&
		r.Header.Get("Sec-Fetch-Mode") == "navigate" &&
		r.Header.Get("Sec-Fetch-Dest") == "document"
}

func (h *Handler) sessionOf(r *http.Request) string {
	if h.opts.CookieJar == nil || h.opts.SessionCookieName == "" { // as makeDirector
		return ""
	}
	if c, err := r.Cookie(h.opts.SessionCookieName); err == nil {
		return c.Value
	}
	return ""
}

func upgradeKey(session, host string) string {
	h := strings.ToLower(host)
	if hh, port, err := net.SplitHostPort(h); err == nil && (port == "80" || port == "443") {
		h = hh
	}
	return session + "\x00" + h
}

// swapScheme is the proxied request's own URI with its target scheme
// replaced: /cyrano/<from>[!marks]/rest → /cyrano/<to>[!marks]/rest, every
// other byte kept (spec/Upgrades.agda swapScheme). A navigation carrying a
// referrer-policy mark (/cyrano/http!origin/…) is swapped like any other.
func swapScheme(r *http.Request, from, to string) (string, bool) {
	return swapSchemeTarget(r.RequestURI, from, to)
}

func swapSchemeTarget(uri, from, to string) (string, bool) {
	const prefix = "/cyrano/"
	if !strings.HasPrefix(uri, prefix) {
		return "", false
	}
	rest := uri[len(prefix):]
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return "", false
	}
	seg := rest[:slash]
	scheme, marks := seg, ""
	if i := strings.IndexByte(seg, '!'); i >= 0 {
		scheme, marks = seg[:i], seg[i:]
	}
	if scheme != from {
		return "", false
	}
	return prefix + to + marks + rest[slash:], true
}

// upgradeNavigation sends a main-frame http navigation to its https URL, as
// Chrome would, and reports whether it did. An http navigation that follows
// an upgrade just sent (the https page redirected back to http) is a
// fallback: the host is http-only from then on.
func (h *Handler) upgradeNavigation(w http.ResponseWriter, r *http.Request, host string) bool {
	if !isMainFrameNavigation(r) || !upgradable(host) {
		return false
	}
	key := upgradeKey(h.sessionOf(r), host)
	upgrades.mu.Lock()
	defer upgrades.mu.Unlock()
	if fresh(upgrades.fallback, key, upgradeFallback) {
		return false
	}
	if fresh(upgrades.pending, key, upgradePending) {
		delete(upgrades.pending, key)
		upgrades.mark(&upgrades.fallback, key)
		return false
	}
	to, ok := swapScheme(r, "http", "https")
	if !ok {
		return false
	}
	upgrades.mark(&upgrades.pending, key)
	w.Header().Set("Location", to)
	w.WriteHeader(http.StatusTemporaryRedirect)
	return true
}

// upgradeAttempt is how long an upgraded navigation's https load has to
// get its response before it falls back to http, as Chrome's
// HTTPS-Upgrades does (spec/Upgrades.agda fallbackAfter; measured: a 443
// that accepts and never answers, Chrome's http request at 3.0 s).
const upgradeAttempt = 3 * time.Second

type upgradeTimerKey struct{}

// upgradeDeadline gives an upgraded navigation's https request its
// attempt's limit: cancelled when no response came within it (the error
// then falls back, upgradeFailed); stopped by the response (modifyResponse).
func (h *Handler) upgradeDeadline(r *http.Request, target *url.URL) *http.Request {
	if target.Scheme != "https" || !isMainFrameNavigation(r) {
		return r
	}
	key := upgradeKey(h.sessionOf(r), target.Host)
	upgrades.mu.Lock()
	pending := fresh(upgrades.pending, key, upgradePending)
	upgrades.mu.Unlock()
	if !pending {
		return r
	}
	ctx, cancel := context.WithCancel(r.Context())
	timer := time.AfterFunc(upgradeAttempt, cancel)
	return r.WithContext(context.WithValue(ctx, upgradeTimerKey{}, timer))
}

// upgradeResponded stops an upgraded navigation's attempt timer.
func upgradeResponded(resp *http.Response) {
	if resp.Request == nil {
		return
	}
	if t, ok := resp.Request.Context().Value(upgradeTimerKey{}).(*time.Timer); ok {
		t.Stop()
	}
}

// upgradeLoaded ends an upgrade whose https navigation reached a page. A
// redirect keeps it pending: one back to http is the fallback case
// upgradeNavigation recognises.
func upgradeLoaded(resp *http.Response, sessionID string) {
	if resp.Request == nil || resp.Request.URL.Scheme != "https" || !isMainFrameNavigation(resp.Request) ||
		(resp.StatusCode >= 300 && resp.StatusCode < 400) {
		return
	}
	key := upgradeKey(sessionID, resp.Request.URL.Host)
	upgrades.mu.Lock()
	defer upgrades.mu.Unlock()
	delete(upgrades.pending, key)
}

// upgradeFailed falls back to http when an upgraded navigation's https load
// failed, and reports whether it did.
func (h *Handler) upgradeFailed(w http.ResponseWriter, r *http.Request, host string) bool {
	if !isMainFrameNavigation(r) {
		return false
	}
	key := upgradeKey(h.sessionOf(r), host)
	upgrades.mu.Lock()
	defer upgrades.mu.Unlock()
	if !fresh(upgrades.pending, key, upgradePending) {
		return false
	}
	to, ok := swapScheme(r, "https", "http")
	if !ok {
		return false
	}
	delete(upgrades.pending, key)
	upgrades.mark(&upgrades.fallback, key)
	w.Header().Set("Location", to)
	w.WriteHeader(http.StatusTemporaryRedirect)
	return true
}

// navigationError is the page a navigation gets when its origin cannot be
// reached — where a direct browser shows its own error page. An https
// failure offers the http URL (the case of times.com, whose certificate
// names another site).
func (h *Handler) navigationError(w http.ResponseWriter, r *http.Request, target *url.URL, err error) {
	var b strings.Builder
	b.WriteString(`<!doctype html><html><head><meta charset="utf-8"><title>`)
	b.WriteString(html.EscapeString(target.Host))
	b.WriteString(`</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em;color:#222}code{word-break:break-all;color:#555}</style></head><body><h1>This site can’t be reached</h1><p><b>`)
	b.WriteString(html.EscapeString(target.Host))
	b.WriteString(`</b> could not be loaded.</p><p><code>`)
	b.WriteString(html.EscapeString(err.Error()))
	b.WriteString(`</code></p>`)
	if to, ok := swapScheme(r, "https", "http"); ok {
		b.WriteString(`<p><a href="`)
		b.WriteString(html.EscapeString(to))
		b.WriteString(`">Open it over http</a></p>`)
	}
	b.WriteString(`</body></html>`)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadGateway)
	_, _ = w.Write([]byte(b.String()))
}
