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
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
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
	(*m)[key] = time.Now()
}

func fresh(m map[string]time.Time, key string, ttl time.Duration) bool {
	t, ok := m[key]
	return ok && time.Since(t) < ttl
}

// upgradable reports whether Chrome would try a navigation to host over
// https: a name (not an IP literal, not localhost, not a single label) on
// the default port.
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
	return true
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
// replaced: /cyrano/<from>/rest → /cyrano/<to>/rest, every other byte kept.
func swapScheme(r *http.Request, from, to string) (string, bool) {
	uri := r.RequestURI
	prefix := "/cyrano/" + from + "/"
	if !strings.HasPrefix(uri, prefix) {
		return "", false
	}
	return "/cyrano/" + to + "/" + uri[len(prefix):], true
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
