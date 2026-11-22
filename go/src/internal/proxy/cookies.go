package proxy

// Cookies between the browser, the server jar and the upstream, by the
// rules of spec/Cookies.agda (urlrewrite: ParseSetCookie, StoreCookie,
// SelectCookies, the wire form).
//
// A script-visible cookie lives in the browser's own jar on the proxy
// origin under a wire name that carries its scope; an HttpOnly cookie stays
// in the server's SessionJar (or, without a jar, in the browser as a real
// HttpOnly cookie, which scripts cannot read either). Each upstream request
// gets exactly the cookies a direct browser would send it.

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// noCredentialsKey marks a request made without credentials.
type noCredentialsKey struct{}

// upstreamCookies sets the outgoing Cookie header: from the browser's jar
// (the incoming Cookie header) and the session jar, the cookies that match
// target — domain, path, Secure, SameSite — longer paths first.
func (h *Handler) upstreamCookies(req *http.Request, target *url.URL, sessionID string) {
	// A request the page made without credentials (fetch's "omit", or its
	// default to another origin) carries no cookies, and its response's
	// Set-Cookie is not stored (Fetch; spec/Fetch.agda includesCredentials).
	if strings.EqualFold(req.Header.Get(CredentialsHeader), "omit") {
		req.Header.Del("Cookie")
		*req = *req.WithContext(context.WithValue(req.Context(), noCredentialsKey{}, true))
		return
	}
	cookies := urlrewrite.JarCookies(strings.Join(req.Header.Values("Cookie"), "; "))
	if h.opts.CookieJar != nil {
		cookies = append(cookies, h.opts.CookieJar.Cookies(sessionID)...)
	}
	to := pageKey(target)

	// SameSite, against the original URLs: the browser saw only same-site
	// requests to the proxy. No initiator (a typed address, or a referrer
	// the page's policy withheld) counts as same-site.
	sameSiteReq := true
	if from := h.originalReferrer(req.Header.Get("Referer")); from != nil {
		sameSiteReq = urlrewrite.SecFetchSite(pageKey(from), to) != "cross-site"
	}
	topSafeNav := strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "navigate") &&
		strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "document") &&
		(req.Method == http.MethodGet || req.Method == http.MethodHead)

	var send []urlrewrite.StoredCookie
	for _, c := range urlrewrite.SelectCookies(false, to, cookies) {
		if urlrewrite.SameSiteAllows(c.SameSite, sameSiteReq, topSafeNav) {
			send = append(send, c)
		}
	}
	if len(send) == 0 {
		req.Header.Del("Cookie")
		return
	}
	req.Header.Set("Cookie", urlrewrite.CookieString(send))
}

// cookieExpiry is when sc expires, as the server jar needs it: Max-Age
// (capped at 400 days, as Chromium) before Expires; zero for a session
// cookie; gone reports a cookie that is already expired — a deletion.
func cookieExpiry(sc urlrewrite.SetCookie, now time.Time) (expires time.Time, gone bool) {
	const limit = 400 * 24 * time.Hour
	if sc.MaxAge != nil {
		n, err := strconv.ParseInt(*sc.MaxAge, 10, 64)
		if err != nil { // out of range: by its sign
			if strings.HasPrefix(*sc.MaxAge, "-") {
				return time.Time{}, true
			}
			return now.Add(limit), false
		}
		if n <= 0 {
			return time.Time{}, true
		}
		d := time.Duration(n) * time.Second
		if n > int64(limit/time.Second) {
			d = limit
		}
		return now.Add(d), false
	}
	if sc.Expires != nil {
		// net/http's own cookie-date reading (the spec leaves cookie-date
		// outside its model).
		hdr := http.Header{"Set-Cookie": {"x=y; Expires=" + *sc.Expires}}
		if cs := (&http.Response{Header: hdr}).Cookies(); len(cs) == 1 && !cs[0].Expires.IsZero() {
			e := cs[0].Expires
			if !e.After(now) {
				return time.Time{}, true
			}
			if e.After(now.Add(limit)) {
				e = now.Add(limit)
			}
			return e, false
		}
	}
	return time.Time{}, false
}

// browserSetCookie is the Set-Cookie that puts c in the browser's jar under
// its wire name. The expiry attributes go as the upstream wrote them: the
// browser applies its own cookie-date and Max-Age rules, as natively.
func browserSetCookie(c urlrewrite.StoredCookie, sc urlrewrite.SetCookie, httpOnly bool) string {
	out := c.WireName() + "=" + c.WireValue() + "; Path=/"
	if sc.Expires != nil {
		out += "; Expires=" + *sc.Expires
	}
	if sc.MaxAge != nil {
		out += "; Max-Age=" + *sc.MaxAge
	}
	if httpOnly {
		out += "; HttpOnly"
	}
	return out
}

// routeSetCookies stores each upstream Set-Cookie as a direct browser
// would — or not at all, when the browser would ignore it — and replaces
// the response's Set-Cookie headers with those for the browser's jar.
// A cookie that changes between HttpOnly and script-visible moves between
// the two stores. On first contact the proxy's session cookie is issued.
func (h *Handler) routeSetCookies(resp *http.Response) {
	if none, _ := resp.Request.Context().Value(noCredentialsKey{}).(bool); none {
		resp.Header.Del("Set-Cookie")
		return
	}
	target := pageKey(resp.Request.URL)
	jar := h.opts.CookieJar
	sessionID, _ := resp.Request.Context().Value(SessionContextKey{}).(string)
	newSession := jar != nil && sessionID == ""
	if newSession {
		sessionID = GenerateSessionID()
		ctx := contextWithSession(resp.Request, sessionID)
		resp.Request = resp.Request.WithContext(ctx)
	}

	now := time.Now()
	var forBrowser []string
	for _, raw := range resp.Header.Values("Set-Cookie") {
		sc, ok := urlrewrite.ParseSetCookie(raw)
		if !ok {
			continue
		}
		c, ok := urlrewrite.StoreCookie(false, target, sc)
		if !ok {
			continue
		}
		switch {
		case !c.HTTPOnly:
			if jar != nil {
				jar.Remove(sessionID, c)
			}
			forBrowser = append(forBrowser, browserSetCookie(c, sc, false))
		case jar == nil:
			forBrowser = append(forBrowser, browserSetCookie(c, sc, true))
		default:
			if expires, gone := cookieExpiry(sc, now); gone {
				jar.Remove(sessionID, c)
			} else {
				jar.Store(sessionID, c, expires)
			}
			// A script-visible cookie of the same identity is replaced.
			forBrowser = append(forBrowser, c.WireName()+"=; Path=/; Max-Age=0")
		}
	}
	resp.Header.Del("Set-Cookie")
	// Host mode: every origin's host reads the one jar, as the one host did.
	domain := ""
	if h.opts.ProxyCfg.Sites && h.opts.ProxyCfg.PublicURL != nil {
		domain = "; Domain=" + h.opts.ProxyCfg.PublicURL.Hostname()
	}
	for _, v := range forBrowser {
		resp.Header.Add("Set-Cookie", v+domain)
	}

	if newSession {
		sc := &http.Cookie{
			Name:     h.opts.SessionCookieName,
			Value:    sessionID,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   h.opts.ProxyCfg.PublicURL != nil && strings.EqualFold(h.opts.ProxyCfg.PublicURL.Scheme, "https"),
		}
		// Host mode: one session for every site's host (a domain cookie on
		// the proxy's name; its hosts are one site to the browser).
		if h.opts.ProxyCfg.Sites && h.opts.ProxyCfg.PublicURL != nil {
			sc.Domain = h.opts.ProxyCfg.PublicURL.Hostname()
		}
		resp.Header.Add("Set-Cookie", sc.String())
	}
}

func contextWithSession(req *http.Request, sessionID string) context.Context {
	return context.WithValue(req.Context(), SessionContextKey{}, sessionID)
}

// WebSocketCookies is the Cookie header a direct browser sends on the
// handshake of a WebSocket to target (ws: / wss:) opened by a page of
// pageOrigin: the cookies of target's http(s) equivalent — from the
// browser's jar (the incoming Cookie header, every proxied site's cookies
// under their prefixes) and the session jar — SameSite judged against the
// page's site, as upstreamCookies does for HTTP. "" for none.
//
// The handshake used to forward the browser's Cookie header as it came:
// every proxied site's cookies and the proxy's session cookie went to the
// socket's server (foxnews.com refused the handshake: "Request Header Or
// Cookie Too Large").
func WebSocketCookies(req *http.Request, target *url.URL, pageOrigin string, jar *SessionJar, sessionCookieName string) string {
	cookies := urlrewrite.JarCookies(strings.Join(req.Header.Values("Cookie"), "; "))
	if jar != nil && sessionCookieName != "" {
		if c, err := req.Cookie(sessionCookieName); err == nil {
			cookies = append(cookies, jar.Cookies(c.Value)...)
		}
	}
	httpTarget := *target
	switch strings.ToLower(target.Scheme) {
	case "wss":
		httpTarget.Scheme = "https"
	case "ws":
		httpTarget.Scheme = "http"
	}
	httpTarget.RawQuery, httpTarget.ForceQuery = "", false
	to := pageKey(&httpTarget)
	sameSite := pageOrigin == "" || urlrewrite.SecFetchSite(pageOrigin, to) != "cross-site"
	var send []urlrewrite.StoredCookie
	for _, c := range urlrewrite.SelectCookies(false, to, cookies) {
		if urlrewrite.SameSiteAllows(c.SameSite, sameSite, false) {
			send = append(send, c)
		}
	}
	if len(send) == 0 {
		return ""
	}
	return urlrewrite.CookieString(send)
}
