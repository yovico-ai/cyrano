package proxy

import (
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

// parseAcceptCH is the set of hint names (lowercase) an Accept-CH header
// lists: a structured-field list of tokens; parameters are ignored.
func parseAcceptCH(values []string) map[string]bool {
	out := map[string]bool{}
	for _, v := range values {
		for _, item := range strings.Split(v, ",") {
			item, _, _ = strings.Cut(item, ";")
			if item = strings.ToLower(strings.TrimSpace(item)); item != "" {
				out[item] = true
			}
		}
	}
	return out
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
	for name := range req.Header {
		l := strings.ToLower(name)
		if isHint(l) && !lowEntropy[l] && !allowed[l] {
			delete(req.Header, name)
		}
	}
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
	if vs := resp.Header.Values("Accept-CH"); len(vs) > 0 && secure {
		acceptedHints.set(key, parseAcceptCH(vs))
		return // the browser gets the origin's own header, as sent
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
