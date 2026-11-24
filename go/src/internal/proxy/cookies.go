package proxy

// Cookies between the browser, the server jar and the upstream, by the
// rules of spec/Cookies.agda and spec/CookieJar.agda.
//
// Every cookie of a session lives in its SessionJar (cookiejar.Jar), the
// script-visible ones too, under Chromium's limits per registrable domain.
// The browser's own jar is a channel: a script's write arrives as an outbox
// entry on the next request (applied once, in order), and a change scripts
// must see goes back as an inbox entry on the response (cookies/jar.ts
// absorbs it). Each upstream request gets exactly the cookies a direct
// browser would send it. Cookies of the old wire form (__crn!…) still in a
// browser's jar are read too, until the jar holds their identity.

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"

	"github.com/yovico/cyrano/internal/cookiejar"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// cookieSite is the key of a cookie's domain for the jar's limit: its
// registrable domain, else the domain itself (an IP, a single label).
func cookieSite(domain string) string {
	d := strings.TrimSuffix(strings.ToLower(domain), ".")
	if net.ParseIP(strings.Trim(d, "[]")) != nil {
		return d
	}
	if s, err := publicsuffix.EffectiveTLDPlusOne(d); err == nil {
		return s
	}
	return d
}

// InboxLife is how long an inbox entry stays in the browser's jar: long
// enough for any runtime of the session to absorb it (a live one does at
// once: cookieStore's change event), short enough never to pile up.
const InboxLife = 60

// inboxKey carries, from the request to its response, the changes the
// request's outbox entries made and the old-form cookies to clear.
type inboxKey struct{}

type pendingCookies struct {
	inbox  []string // Set-Cookie values for the browser
	legacy map[string]bool
}

func pendingOf(req *http.Request) *pendingCookies {
	p, _ := req.Context().Value(inboxKey{}).(*pendingCookies)
	return p
}

// inboxSetCookie is the Set-Cookie that puts change n in the browser's jar.
func inboxSetCookie(n cookiejar.Numbered, applied uint64) string {
	return cookiejar.ChanName(true, n.Change) + "=" + cookiejar.ChanValue(n.Change, n.N, &applied) + channelAttrs(InboxLife)
}

// browserPairs reads the browser's Cookie header: the outbox's writes
// (every record of every slot, with its writer), the old wire form, and
// the names of the latter.
func browserPairs(header string) (outbox []cookiejar.Numbered, writers map[string]uint64, legacy []urlrewrite.StoredCookie, legacyNames map[string]bool) {
	legacyNames, writers = map[string]bool{}, map[string]uint64{}
	for _, p := range strings.Split(header, ";") {
		n, v, _ := strings.Cut(strings.TrimLeft(p, " \t"), "=")
		if rest, ok := strings.CutPrefix(n, cookiejar.OutboxPrefix); ok {
			tab, _, _ := strings.Cut(rest, "!")
			for _, w := range cookiejar.OutboxOf(v) {
				outbox = append(outbox, w)
				writers[tab] = max(writers[tab], w.N)
			}
			continue
		}
		if c, ok := urlrewrite.Unwire(n, v); ok {
			legacy = append(legacy, c)
			legacyNames[n] = true
		}
	}
	sort.SliceStable(outbox, func(i, j int) bool { return outbox[i].N < outbox[j].N })
	return outbox, writers, legacy, legacyNames
}

// channelAttrs: every entry of the channel is short-lived and of low
// priority — if the browser's jar ever fills, they go before the session.
func channelAttrs(maxAge int) string {
	return "; Path=/; Max-Age=" + strconv.Itoa(maxAge) + "; Priority=Low"
}

// failedCookies stores the cookies of a response the proxy fails (ORB, the
// CORS check) — the browser would have, before either check — and keeps
// the inbox entries scripts must see for the session's next response.
func (h *Handler) failedCookies(resp *http.Response, routed bool) {
	if h.opts.CookieJar == nil || resp.Request == nil {
		return
	}
	if !routed {
		h.routeSetCookies(resp)
	}
	sid, _ := resp.Request.Context().Value(SessionContextKey{}).(string)
	var keep []string
	for _, v := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(v, cookiejar.InboxPrefix) {
			keep = append(keep, v)
		}
	}
	h.opts.CookieJar.KeepUndelivered(sid, keep)
}

// noCredentialsKey marks a request made without credentials.
type noCredentialsKey struct{}

// browserSessionKey carries a browser-session marker the response must set:
// the request came without one (a browser restarted).
type browserSessionKey struct{}

// noteBrowserSession reads a request's browser-session marker
// (SessionJar.NoteBrowserSession): a request without one starts a browser
// session; the response sets the marker.
func (h *Handler) noteBrowserSession(req *http.Request, sessionID string) {
	if h.opts.CookieJar == nil || sessionID == "" {
		return
	}
	marker := ""
	if c, err := req.Cookie(h.opts.SessionCookieName + "b"); err == nil {
		marker = c.Value
	}
	if issue := h.opts.CookieJar.NoteBrowserSession(sessionID, marker); issue != "" {
		*req = *req.WithContext(context.WithValue(req.Context(), browserSessionKey{}, issue))
	}
}

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
	cx := h.cookieCtx(req, target, sessionID)
	*req = *req.WithContext(context.WithValue(req.Context(), cookieCtxKey{}, cx))
	outbox, writers, legacy, legacyNames := browserPairs(strings.Join(req.Header.Values("Cookie"), "; "))
	var cookies []urlrewrite.StoredCookie
	created := map[string]uint64{} // scope → when made (ms): Lax-allowing-unsafe
	jar := h.opts.CookieJar
	if jar != nil && sessionID != "" {
		pend := &pendingCookies{legacy: legacyNames}
		now := unixNow()
		var gen uint64
		jar.With(sessionID, func(j *cookiejar.Jar) {
			// A script's writes first: they are on this request. Each writer
			// is told, in one ack, how far the server read.
			for _, o := range outbox {
				j.ApplyOutbox(now, cookieSite(o.Cookie.Domain), o.Change, o.N)
			}
			gen = j.Gen
			cookies = j.Live(now)
			for _, c := range cookies {
				if t, ok := j.Created(now, c); ok {
					created[c.Scope()] = t
				}
			}
		})
		for tab, k := range writers {
			// The highest number read, and the jar's generation then: what
			// the writes are as of (spec CookieJar.ack).
			pend.inbox = append(pend.inbox, cookiejar.AckPrefix+tab+"="+strconv.FormatUint(k, 10)+"!"+strconv.FormatUint(gen, 10)+channelAttrs(InboxLife))
		}
		*req = *req.WithContext(context.WithValue(req.Context(), inboxKey{}, pend))
		// The old wire form, where the jar holds nothing of the identity.
		for _, c := range legacy {
			held := false
			for _, k := range cookies {
				if cookiejar.SameID(c, k) {
					held = true
					break
				}
			}
			if !held {
				cookies = append(cookies, c)
			}
		}
	} else {
		cookies = legacy
		if jar != nil {
			cookies = append(cookies, jar.Cookies(sessionID)...)
		}
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

	topNav := strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "navigate") &&
		strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "document")
	nowMs := unixNow()
	var send []urlrewrite.StoredCookie
	for _, c := range urlrewrite.SelectCookies(false, to, cookies) {
		age := uint64(1 << 62) // the old wire form's: its age is not known
		if t, ok := created[c.Scope()]; ok && t <= nowMs {
			age = nowMs - t
		}
		if urlrewrite.InCtx(false, cx, c) && urlrewrite.SameSiteAllows(c.SameSite, sameSiteReq, topSafeNav, topNav, age) {
			send = append(send, c)
		}
	}
	if jar != nil && sessionID != "" && len(send) > 0 {
		jar.With(sessionID, func(j *cookiejar.Jar) {
			j.Touch(unixNow(), func(c urlrewrite.StoredCookie) bool {
				for _, x := range send {
					if cookiejar.SameID(c, x) {
						return true
					}
				}
				return false
			})
		})
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
		// As Chromium reads the date (spec/CookieDate.agda).
		if secs, ok := urlrewrite.CookieDate(*sc.Expires); ok {
			e := time.Unix(int64(min(secs, uint64(1)<<40)), 0)
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
		// The browser session starts with the session: its marker first,
		// so that it ends nothing this response stores.
		ctx = context.WithValue(ctx, browserSessionKey{}, jar.NoteBrowserSession(sessionID, ""))
		resp.Request = resp.Request.WithContext(ctx)
	}

	var forBrowser []string
	if jar == nil {
		// No jar: script-visible cookies in the browser's own jar, under
		// their wire names; HttpOnly ones there as real HttpOnly cookies.
		for _, raw := range resp.Header.Values("Set-Cookie") {
			sc, ok := urlrewrite.ParseSetCookie(raw)
			if !ok {
				continue
			}
			if c, ok := urlrewrite.StoreCookie(false, target, sc); ok {
				forBrowser = append(forBrowser, browserSetCookie(c, sc, c.HTTPOnly))
			}
		}
	} else {
		document := false
		cx := CookieCtxOf(resp.Request)
		pend := pendingOf(resp.Request)
		if pend != nil {
			forBrowser = append(forBrowser, pend.inbox...)
		}
		// Changes a failed response made (ORB, CORS: its headers never
		// reached the browser) ride this one.
		forBrowser = append(forBrowser, jar.TakeUndelivered(sessionID)...)
		now := unixNow()
		// The requesting page's site, and whether this is a document's own
		// response (spec CookieJar.inboxFor).
		var requester *string
		if page, ok := resp.Request.Context().Value(requesterKey{}).(string); ok && page != "" {
			if u, err := url.Parse(page); err == nil && u.Hostname() != "" {
				site := cookieSite(u.Hostname())
				requester = &site
			}
		}
		switch strings.ToLower(resp.Request.Header.Get("Sec-Fetch-Dest")) {
		case "document", "iframe", "frame", "embed", "object":
			document = true
		}
		var stored []urlrewrite.StoredCookie
		jar.With(sessionID, func(j *cookiejar.Jar) {
			for _, raw := range resp.Header.Values("Set-Cookie") {
				sc, ok := urlrewrite.ParseSetCookie(raw)
				if !ok {
					continue
				}
				c, ok := urlrewrite.StoreCookie(false, target, sc)
				// The context's: a cross-site one stores SameSite=None only,
				// a Partitioned cookie under its key (spec storableIn).
				if !ok || !urlrewrite.StorableIn(cx, sc) {
					continue
				}
				c = urlrewrite.PlacedIn(cx, sc, c)
				ch := cookiejar.Change{Cookie: c}
				if e, alive := cookiejar.ExpiryOf(now, sc); alive {
					ch.Expiry = e
				} else {
					ch.Gone = true
				}
				for _, n := range j.Put(false, now, cookieSite(c.Domain), ch) {
					if cookiejar.InboxFor(document, requester, cookieSite(resp.Request.URL.Hostname()), cookieSite(n.Cookie.Domain)) && urlrewrite.InCtx(true, cx, n.Cookie) {
						forBrowser = append(forBrowser, inboxSetCookie(n, j.LastApplied(n.Cookie)))
					}
				}
				stored = append(stored, c)
			}
		})
		// A cookie of the old wire form whose identity the jar now holds
		// leaves the browser's jar.
		if pend != nil {
			for _, c := range stored {
				if pend.legacy[c.WireName()] {
					forBrowser = append(forBrowser, c.WireName()+"=; Path=/; Max-Age=0")
				}
			}
		}
	}
	resp.Header.Del("Set-Cookie")
	for _, v := range forBrowser {
		resp.Header.Add("Set-Cookie", v)
	}

	secure := h.opts.ProxyCfg.PublicURL != nil && strings.EqualFold(h.opts.ProxyCfg.PublicURL.Scheme, "https")
	if newSession {
		// The session outlives the browser: its jar holds the persistent
		// cookies, which natively outlive it too. The browser session is
		// its own marker (below).
		sc := &http.Cookie{
			Name:     h.opts.SessionCookieName,
			Value:    sessionID,
			Path:     "/",
			MaxAge:   cookiejar.CapSeconds,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secure,
		}
		resp.Header.Add("Set-Cookie", sc.String()+"; Priority=High")
	}
	if bs, _ := resp.Request.Context().Value(browserSessionKey{}).(string); bs != "" {
		// A session cookie: it ends with the browser session, and with it
		// the jar's session cookies (SessionJar.BrowserSession).
		resp.Header.Add("Set-Cookie", (&http.Cookie{Name: h.opts.SessionCookieName + "b", Value: bs, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteLaxMode, Secure: secure}).String()+"; Priority=High")
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
		if urlrewrite.SameSiteAllows(c.SameSite, sameSite, false, false, 0) {
			send = append(send, c)
		}
	}
	if len(send) == 0 {
		return ""
	}
	return urlrewrite.CookieString(send)
}
