package proxy

import (
	"context"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
)

// Client hints (HTTP Client Hints, RFC 8942; UA-CH).
//
// A browser sends an origin only the hints that origin asked for, in the
// Accept-CH of a top-level document it served — beyond the three
// low-entropy ones every request carries. Through the proxy every site is
// one origin to the browser, so one site's Accept-CH would make it send
// those hints to every site: ten extra request headers no direct Chrome
// sends there.
//
// So the proxy keeps each session's Accept-CH per original origin, and:
//
//   - answers every top-level document with that origin's own Accept-CH
//     (an empty one when it has none), so the browser's hint set for the
//     proxy origin is the current page's — and its requests carry what a
//     direct browser's would, in the order a direct browser writes them
//     (Chrome's fetch header order depends on the whole set of headers, so
//     it cannot be restored by removing the extra ones afterwards);
//   - drops from each request the hints its origin did not ask for, which
//     covers what the first rule cannot: the navigation from one site to
//     another, sent with the previous site's set.
//
// Known gaps: on a navigation to an origin that wants hints the previous
// page's origin did not, they are missing from that one request (as on a
// first visit); pages of different origins open in two tabs share the
// browser's set; hints delegated to another origin (Permissions-Policy
// ch-ua-*, <meta http-equiv=delegate-ch>) are not forwarded to it; an
// Accept-CH in <meta http-equiv> is not seen by the proxy.

// legacyHints are the hint request headers without the Sec-CH- prefix.
// (Save-Data is not here: the browser sends it on the user's setting.)
var legacyHints = map[string]bool{
	"device-memory": true, "dpr": true, "width": true, "viewport-width": true,
	"downlink": true, "ect": true, "rtt": true,
}

// lowEntropy hints go on every request, asked for or not.
var lowEntropy = map[string]bool{"sec-ch-ua": true, "sec-ch-ua-mobile": true, "sec-ch-ua-platform": true}

func isHint(lname string) bool {
	return strings.HasPrefix(lname, "sec-ch-") || legacyHints[lname]
}

type hintStore struct {
	mu sync.Mutex
	m  map[string]map[string]bool // session + "\x00" + origin → lowercase hint names
}

const hintStoreMax = 8192

var acceptedHints hintStore

func hintKey(sessionID string, u *url.URL) string {
	return sessionID + "\x00" + strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

func (s *hintStore) set(key string, hints map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = make(map[string]map[string]bool)
	}
	if len(hints) == 0 {
		delete(s.m, key)
		return
	}
	if len(s.m) >= hintStoreMax {
		for k := range s.m {
			delete(s.m, k)
			break
		}
	}
	s.m[key] = hints
}

func (s *hintStore) get(key string) map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[key]
}

// parseAcceptCH is the set of hint names (lowercase) an Accept-CH (or
// Critical-CH) asks for, as Chromium reads it (spec/Hints.agda acceptCH):
// a Structured Fields list whose members are tokens or one-token inner
// lists, parameters ignored. ok is false when it counts for nothing — the
// list does not parse, or a member is anything else.
func parseAcceptCH(values []string) (names map[string]bool, ok bool) {
	members, ok := urlrewrite.SFList(strings.Join(values, ", "))
	if !ok {
		return nil, false
	}
	names = map[string]bool{}
	for _, m := range members {
		if len(m.Items) != 1 || m.Items[0].Kind != urlrewrite.SFToken {
			return nil, false
		}
		names[strings.ToLower(m.Items[0].Text)] = true
	}
	return names, true
}

// filterClientHints removes from req the hints a direct browser would not
// send target: all but the low-entropy ones, unless target's origin asked
// for them — and, for a subresource, only when it is the page's own origin.
func (h *Handler) filterClientHints(req *http.Request, target *url.URL, sessionID string) {
	var allowed map[string]bool
	dest := strings.ToLower(req.Header.Get("Sec-Fetch-Dest"))
	from := h.originalReferrer(req.Header.Get("Referer"))
	sameOrigin := from != nil && strings.EqualFold(from.Scheme, target.Scheme) && strings.EqualFold(from.Host, target.Host)
	if strings.EqualFold(target.Scheme, "https") && (dest == "document" || sameOrigin) {
		allowed = acceptedHints.get(hintKey(sessionID, target))
	}
	navigation := dest == "document"
	secure := strings.EqualFold(target.Scheme, "https")
	withheld := http.Header{}
	for name, vs := range req.Header {
		l := strings.ToLower(name)
		if isHint(l) && !hintSent(l, allowed, secure, navigation, sameOrigin) {
			withheld[name] = vs
			delete(req.Header, name)
		}
	}
	if len(withheld) > 0 {
		// Kept for a Critical-CH restart (restartForCriticalCH).
		*req = *req.WithContext(context.WithValue(req.Context(), withheldHintsKey{}, withheld))
	}
}

// hintSent: whether a direct browser sends this hint (spec/Hints.agda):
// the low-entropy ones always; another when the target is secure, its
// origin asked for it, and the request is a top-level navigation or to
// the page's own origin.
func hintSent(hint string, set map[string]bool, secure, navigation, samePage bool) bool {
	return lowEntropy[hint] || secure && (navigation || samePage) && set[hint]
}

type withheldHintsKey struct{}

// restartForCriticalCH re-enacts what Chrome does when a navigation's
// response names, in Critical-CH, hints the request did not carry: it
// discards the response and sends the request again with them (Client Hint
// Reliability). The browser cannot do it here — it already sent those hints
// to the proxy's origin, where the proxy withheld them because this origin
// had not asked yet — so the proxy does: the origin then sees the same two
// requests it would see from a direct Chrome, and the page is the one built
// for the second.
//
// Cookies set by the discarded response are kept, as Chrome keeps them:
// sent on the second request and set again with its response.
func (h *Handler) restartForCriticalCH(resp *http.Response) {
	req := resp.Request
	if req == nil || req.URL == nil || (req.Method != http.MethodGet && req.Method != http.MethodHead) ||
		!strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "document") || !strings.EqualFold(req.URL.Scheme, "https") {
		return
	}
	withheld, _ := req.Context().Value(withheldHintsKey{}).(http.Header)
	critical, _ := parseAcceptCH(resp.Header.Values("Critical-CH"))
	asked, _ := parseAcceptCH(resp.Header.Values("Accept-CH"))
	if len(withheld) == 0 || len(critical) == 0 {
		return
	}
	again := req.Clone(context.WithValue(req.Context(), withheldHintsKey{}, http.Header(nil)))
	missing := false
	for name, vs := range withheld {
		l := strings.ToLower(name)
		if asked[l] {
			again.Header[name] = vs
			missing = missing || critical[l]
		}
	}
	if !missing {
		return
	}
	first := resp.Header.Values("Set-Cookie")
	for _, sc := range first {
		pair, _, _ := strings.Cut(sc, ";")
		if name, _, ok := strings.Cut(strings.TrimSpace(pair), "="); ok {
			again.Header.Set("Cookie", withCookie(again.Header.Get("Cookie"), name, strings.TrimSpace(pair)))
		}
	}
	second, err := h.transport.RoundTrip(again)
	if err != nil {
		return // keep the first response
	}
	resp.Body.Close()
	header := second.Header
	if len(first) > 0 {
		header["Set-Cookie"] = append(append([]string(nil), first...), header.Values("Set-Cookie")...)
	}
	*resp = *second
	resp.Header = header
	resp.Request = again
}

// withCookie is the Cookie header value with name's pair set to pair.
func withCookie(cookie, name, pair string) string {
	var out []string
	for _, c := range strings.Split(cookie, ";") {
		c = strings.TrimSpace(c)
		if n, _, _ := strings.Cut(c, "="); c != "" && n != name {
			out = append(out, c)
		}
	}
	return strings.Join(append(out, pair), "; ")
}

// recordAcceptCH notes what a top-level document's origin asks for (as
// Chrome does: only on a secure top-level navigation, each Accept-CH
// replacing the last) and gives the browser that origin's set — empty when
// it has none, which clears what another site's page left behind.
func recordAcceptCH(resp *http.Response, target *url.URL, sessionID string) {
	if !strings.EqualFold(resp.Request.Header.Get("Sec-Fetch-Dest"), "document") {
		resp.Header.Del("Accept-CH")
		resp.Header.Del("Critical-CH")
		return
	}
	secure := strings.EqualFold(target.Scheme, "https")
	key := hintKey(sessionID, target)
	// A valid Accept-CH replaces the origin's set (an empty one clears
	// it); an invalid one changes nothing, as for Chromium
	// (spec/Hints.agda updateSet) — and the browser is then given the set.
	if vs := resp.Header.Values("Accept-CH"); len(vs) > 0 && secure {
		if names, ok := parseAcceptCH(vs); ok {
			acceptedHints.set(key, names)
			return // the browser gets the origin's own header, as sent
		}
	}
	var names []string
	if secure {
		for n := range acceptedHints.get(key) {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	resp.Header.Set("Accept-CH", strings.Join(names, ", "))
	if !secure {
		resp.Header.Del("Critical-CH")
	}
}
