package proxy

import (
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// policyStore remembers each page's Referrer-Policy (by its original URL,
// no fragment), as last served: the policy governs the Referer of requests
// that page makes later. Bounded; an evicted page falls back to the default
// policy.
type policyStore struct {
	mu sync.Mutex
	m  map[string]urlrewrite.Policy
}

const policyStoreMax = 8192

func (s *policyStore) set(page string, p urlrewrite.Policy) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = make(map[string]urlrewrite.Policy)
	}
	if p == "" {
		delete(s.m, page)
		return
	}
	if len(s.m) >= policyStoreMax {
		for k := range s.m { // drop an arbitrary entry
			delete(s.m, k)
			break
		}
	}
	s.m[page] = p
}

func (s *policyStore) get(page string) urlrewrite.Policy {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.m[page]; ok {
		return p
	}
	return urlrewrite.DefaultPolicy
}

// pagePolicies is shared by every Handler: a page's policy is a property of
// the page, not of a session.
var pagePolicies policyStore

// pageKey is a page's original URL without userinfo or fragment.
func pageKey(u *url.URL) string {
	c := *u
	c.User, c.Fragment, c.RawFragment = nil, "", ""
	return c.String()
}

// originalReferrer is the original URL of the page a proxied Referer names
// (no userinfo, no fragment), or nil when the Referer is not a proxified URL.
func (h *Handler) originalReferrer(referer string) *url.URL {
	if referer == "" || !urlrewrite.OnProxy(referer, h.opts.ProxyCfg) {
		return nil
	}
	u, err := url.Parse(referer)
	if err != nil {
		return nil
	}
	t, ok := urlrewrite.ParseCyranoURL(u)
	if !ok {
		return nil
	}
	t.User, t.Fragment, t.RawFragment = nil, "", ""
	return t
}

// InitiatorHeader is a request header the runtime adds where the browser
// sends no Referer to tell the requesting context by: a fetch or XHR from
// a worker made of a blob: or data: URL — and on every fetch or XHR to
// another origin. Its value is the original URL of that context's document
// (a worker: of its creator). It never goes upstream.
// TS: ts/client/src/patches/cors.ts.
const InitiatorHeader = "Crn-I"

// initiatorOrigin is the origin an InitiatorHeader value names
// ("https://host[:port]"), or "" when it is not an http(s) origin.
func initiatorOrigin(v string) string {
	if v == "" {
		return ""
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// directFetchHeaders sets Referer, Origin and Sec-Fetch-Site on the
// outgoing request to what a direct browser would send to target
// (spec/Referrer.agda; urlrewrite.Referrer, OriginHeader, SecFetchSite).
//
// Known gaps: a policy set by <meta name=referrer>, a referrerpolicy
// attribute or fetch({referrerPolicy}) is applied by the browser against
// proxy URLs (an origin-only result names the proxy and is dropped here);
// and cyrano forces crossorigin on scripts, which changes their fetch mode,
// so Origin is added only for fetch()/XHR requests.
func (h *Handler) directFetchHeaders(req *http.Request, target *url.URL) {
	to := pageKey(target)
	referer := req.Header.Get("Referer")
	from := h.originalReferrer(referer)
	initiator := initiatorOrigin(req.Header.Get(InitiatorHeader))
	req.Header.Del(InitiatorHeader)

	if from == nil && initiator != "" {
		// A context with no referrer (a blob: worker): no Referer, and
		// Origin and Sec-Fetch-Site by the origin the runtime named.
		req.Header.Del("Referer")
		mode := strings.ToLower(req.Header.Get("Sec-Fetch-Mode"))
		safe := req.Method == http.MethodGet || req.Method == http.MethodHead
		if v, ok := urlrewrite.OriginHeader(mode, safe, urlrewrite.DefaultPolicy, initiator+"/", to); ok {
			req.Header.Set("Origin", v)
		} else {
			req.Header.Del("Origin")
		}
		if sfs := req.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "none" {
			if site := urlrewrite.SecFetchSite(initiator+"/", to); site != "" {
				req.Header.Set("Sec-Fetch-Site", site)
			}
		}
		return
	}
	if from == nil {
		// No page of ours behind it: never show the proxy to the upstream.
		if referer != "" && urlrewrite.OnProxy(referer, h.opts.ProxyCfg) {
			req.Header.Del("Referer")
		}
		if o := req.Header.Get("Origin"); o != "" && urlrewrite.OnProxy(o, h.opts.ProxyCfg) {
			req.Header.Set("Origin", target.Scheme+"://"+target.Host)
		}
		return
	}

	page := pageKey(from)
	policy := pagePolicies.get(page)
	if v, ok := urlrewrite.Referrer(policy, page, to); ok {
		req.Header.Set("Referer", v)
	} else {
		req.Header.Del("Referer")
	}

	mode := strings.ToLower(req.Header.Get("Sec-Fetch-Mode"))
	safe := req.Method == http.MethodGet || req.Method == http.MethodHead
	browserSent := req.Header.Get("Origin") != ""
	scripted := strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "empty")
	if v, ok := urlrewrite.OriginHeader(mode, safe, policy, page, to); ok && (browserSent || scripted) {
		req.Header.Set("Origin", v)
	} else if browserSent && !ok {
		req.Header.Del("Origin")
	} else if browserSent && urlrewrite.OnProxy(req.Header.Get("Origin"), h.opts.ProxyCfg) {
		req.Header.Set("Origin", from.Scheme+"://"+from.Host)
	}

	// "none" (a user-initiated navigation) has no initiator to compare.
	if sfs := req.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "none" {
		if site := urlrewrite.SecFetchSite(page, to); site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
	}
}

// recordPagePolicy notes a document's Referrer-Policy and, when it sets
// one, replaces the header the browser sees with unsafe-url: the browser
// then always sends the full (proxied) referrer, from which
// directFetchHeaders computes what the page's own policy allows upstream.
func recordPagePolicy(resp *http.Response, target *url.URL) {
	dest := strings.ToLower(resp.Request.Header.Get("Sec-Fetch-Dest"))
	isDoc := dest == "document" || dest == "iframe" || dest == "frame" || dest == "embed" || dest == "object" ||
		(dest == "" && strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/html"))
	if !isDoc {
		return
	}
	p := urlrewrite.HeaderPolicy(strings.Join(resp.Header.Values("Referrer-Policy"), ","))
	pagePolicies.set(pageKey(target), p)
	if p != "" {
		resp.Header.Set("Referrer-Policy", string(urlrewrite.UnsafeURL))
	}
}

// chromePriority is the Priority header (RFC 9218) Chrome most commonly
// sends for a request of this Sec-Fetch-Dest and Sec-Fetch-Mode, measured
// from Chromium 147 against an HTTP/2 server; "" for none.
//
// Chrome sends Priority only over HTTP/2 and HTTP/3. A browser reaching
// cyrano over HTTP/1.1 (local development) sends none, and cyrano's own
// HTTP/2 request to the upstream would then lack a header every Chrome
// request of that kind carries. The exact value depends on what only the
// browser knows (a script in the head or the body, async, an image in the
// viewport, fetchpriority) and varies natively, so the commonest one is
// used. Over HTTP/2 the browser's own header is forwarded as it is.
func chromePriority(dest, mode string) string {
	switch dest {
	case "document", "iframe", "frame":
		return "u=0, i"
	case "style":
		return "u=0"
	case "font":
		return "u=0"
	case "script":
		return "u=1"
	case "image", "video", "audio", "track":
		return "i"
	case "worker", "sharedworker", "serviceworker":
		return "u=4, i"
	case "empty":
		if mode == "no-cors" {
			return "u=4, i"
		}
		return "u=1, i"
	}
	return ""
}

// ensurePriority adds Chrome's Priority header to an https upstream request
// the browser sent over HTTP/1.x without one (see chromePriority).
func ensurePriority(req *http.Request, target *url.URL, incomingHTTP1 bool) {
	if !incomingHTTP1 || target.Scheme != "https" || req.Header.Get("Priority") != "" {
		return
	}
	if p := chromePriority(strings.ToLower(req.Header.Get("Sec-Fetch-Dest")), strings.ToLower(req.Header.Get("Sec-Fetch-Mode"))); p != "" {
		req.Header.Set("Priority", p)
	}
}

// Compression dictionaries (RFC 9842) are per origin: a site registers one
// with Use-As-Dictionary and the browser offers it back, to that origin
// only, in Available-Dictionary (adding dcb/dcz to Accept-Encoding). On the
// proxy origin one site's dictionary would be offered to every site. So
// none is ever registered — the upstream sees a browser that has no
// dictionary yet, as on a first visit.

// noDictionaryOffer removes what a browser holding a dictionary adds.
func noDictionaryOffer(req *http.Request) {
	req.Header.Del("Available-Dictionary")
	req.Header.Del("Dictionary-ID")
	ae := req.Header.Get("Accept-Encoding")
	if !strings.Contains(ae, "dc") {
		return
	}
	var kept []string
	for _, e := range strings.Split(ae, ",") {
		switch strings.ToLower(strings.TrimSpace(strings.SplitN(e, ";", 2)[0])) {
		case "dcb", "dcz":
		default:
			kept = append(kept, strings.TrimSpace(e))
		}
	}
	req.Header.Set("Accept-Encoding", strings.Join(kept, ", "))
}

// noDictionaryRegistration keeps the browser from storing a dictionary.
func noDictionaryRegistration(resp *http.Response) {
	resp.Header.Del("Use-As-Dictionary")
}

// RecordMetaPolicy notes a page's Referrer-Policy as its
// <meta name="referrer"> states it (the HTML rewriter gives the tag
// unsafe-url, as recordPagePolicy does the header); false when content is
// no policy.
func RecordMetaPolicy(target *url.URL, content string) bool {
	p := urlrewrite.HeaderPolicy(content)
	if p == "" {
		return false
	}
	pagePolicies.set(pageKey(target), p)
	return true
}
