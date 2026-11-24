package proxy

import (
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// policyStore remembers each page's Referrer-Policy (by session and its
// original URL, no fragment), as last served to that session: the policy
// governs the Referer of requests that page makes later. Bounded; an
// evicted page falls back to the default policy.
type policyStore struct {
	mu sync.Mutex
	m  map[string]urlrewrite.Policy
}

const policyStoreMax = 8192

func (s *policyStore) set(session, page string, p urlrewrite.Policy) {
	page = session + "\x00" + page
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

func (s *policyStore) get(session, page string) urlrewrite.Policy {
	page = session + "\x00" + page
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.m[page]; ok {
		return p
	}
	return urlrewrite.DefaultPolicy
}

// uirPages: the pages (per session) that declared upgrade-insecure-requests
// (spec MixedContent.uirUpgrades), by a CSP header or a <meta http-equiv>.
var uirPages struct {
	mu sync.Mutex
	m  map[string]bool
}

func setUIR(session, page string, on bool) {
	uirPages.mu.Lock()
	defer uirPages.mu.Unlock()
	if uirPages.m == nil {
		uirPages.m = map[string]bool{}
	}
	k := session + "\x00" + page
	if !on {
		delete(uirPages.m, k)
		return
	}
	if len(uirPages.m) >= policyStoreMax {
		for x := range uirPages.m {
			delete(uirPages.m, x)
			break
		}
	}
	uirPages.m[k] = true
}

func pageUIR(session, page string) bool {
	uirPages.mu.Lock()
	defer uirPages.mu.Unlock()
	return uirPages.m[session+"\x00"+page]
}

// pageEmbedders: each page's embedder policy (COEP / Document-Isolation-
// Policy), per session — the CORP check of its no-cors requests (corp).
var pageEmbedders struct {
	mu sync.Mutex
	m  map[string]string
}

func setEmbedder(session, page, e string) {
	pageEmbedders.mu.Lock()
	defer pageEmbedders.mu.Unlock()
	if pageEmbedders.m == nil {
		pageEmbedders.m = map[string]string{}
	}
	k := session + "\x00" + page
	if e == "" {
		delete(pageEmbedders.m, k)
		return
	}
	if len(pageEmbedders.m) >= policyStoreMax {
		for x := range pageEmbedders.m {
			delete(pageEmbedders.m, x)
			break
		}
	}
	pageEmbedders.m[k] = e
}

func pageEmbedder(session, page string) string {
	pageEmbedders.mu.Lock()
	defer pageEmbedders.mu.Unlock()
	return pageEmbedders.m[session+"\x00"+page]
}

// RecordMetaUIR notes a page's <meta http-equiv="content-security-policy">
// declaring upgrade-insecure-requests.
func RecordMetaUIR(resp *http.Response, target *url.URL, content string) {
	if !urlrewrite.DeclaresUIR(content) {
		return
	}
	var req *http.Request
	if resp != nil {
		req = resp.Request
	}
	setUIR(sessionIn(req), pageKey(target), true)
}

// pagePolicies holds every session's pages. A page's policy is what its
// server sent that session: two users' responses for one URL differ (signed
// in or not, an experiment), and one must not set the other's Referer.
var pagePolicies policyStore

// sessionIn is the session a request was made in ("" outside one).
func sessionIn(req *http.Request) string {
	if req == nil {
		return ""
	}
	s, _ := req.Context().Value(SessionContextKey{}).(string)
	return s
}

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
// A request's own policy (an element's referrerpolicy, fetch's
// referrerPolicy) comes in its proxified URL (urlrewrite.TargetPolicy; the
// browser was told unsafe-url) and is applied here before the page's.
// Known gap: cyrano forces crossorigin on scripts, which changes their fetch mode,
// so Origin is added only for fetch()/XHR requests.
func (h *Handler) directFetchHeaders(req *http.Request, target *url.URL, requestPolicy urlrewrite.Policy) {
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
		pol := urlrewrite.DefaultPolicy
		if requestPolicy != "" {
			pol = requestPolicy
		}
		if v, ok := urlrewrite.OriginHeader(mode, safe, pol, initiator+"/", to, strings.ToLower(req.Header.Get("Sec-Fetch-Dest"))); ok {
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
	// The request's own policy, where it has one, before its page's.
	policy := pagePolicies.get(sessionIn(req), page)
	if requestPolicy != "" {
		policy = requestPolicy
	}
	if v, ok := urlrewrite.Referrer(policy, page, to); ok {
		req.Header.Set("Referer", v)
	} else {
		req.Header.Del("Referer")
	}

	mode := strings.ToLower(req.Header.Get("Sec-Fetch-Mode"))
	safe := req.Method == http.MethodGet || req.Method == http.MethodHead
	browserSent := req.Header.Get("Origin") != ""
	scripted := strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "empty")
	// Every proxied context has the proxy's origin but one the browser
	// made opaque (a sandboxed document): its requests to the proxy are
	// the only cross-site ones a proxied page makes. Its Origin is "null"
	// and nothing is same-site with it (spec/Referrer.agda
	// originHeaderOpaque, secFetchSiteOpaque); its Referer is its page's.
	init := page
	if strings.EqualFold(req.Header.Get("Sec-Fetch-Site"), "cross-site") {
		init = "null"
	}
	if v, ok := urlrewrite.OriginHeader(mode, safe, policy, init, to, strings.ToLower(req.Header.Get("Sec-Fetch-Dest"))); ok && (browserSent || scripted) {
		req.Header.Set("Origin", v)
	} else if browserSent && !ok {
		req.Header.Del("Origin")
	} else if browserSent && urlrewrite.OnProxy(req.Header.Get("Origin"), h.opts.ProxyCfg) {
		req.Header.Set("Origin", from.Scheme+"://"+from.Host)
	}

	// "none" (a user-initiated navigation) has no initiator to compare.
	if sfs := req.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "none" {
		if site := urlrewrite.SecFetchSite(init, to); site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
	}
}

// recordPagePolicy notes the Referrer-Policy of a response that sets one
// (spec/Referrer.agda setsPolicy: a document, a worker, a stylesheet) and,
// when it has one, replaces the header the browser sees with unsafe-url:
// the browser then always sends the full (proxied) referrer, from which
// directFetchHeaders computes what the policy allows upstream. A
// stylesheet with none follows its document's (CSSOM): it is recorded with
// the requesting page's.
func recordPagePolicy(resp *http.Response, target *url.URL) {
	dest := strings.ToLower(resp.Request.Header.Get("Sec-Fetch-Dest"))
	if !setsPolicy(dest) && !(dest == "" && strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/html")) {
		return
	}
	p := urlrewrite.HeaderPolicy(strings.Join(resp.Header.Values("Referrer-Policy"), ","))
	if p == "" && dest == "style" {
		if page, ok := resp.Request.Context().Value(requesterKey{}).(string); ok {
			p = pagePolicies.get(sessionIn(resp.Request), page)
		}
	}
	pagePolicies.set(sessionIn(resp.Request), pageKey(target), p)
	if resp.Header.Get("Referrer-Policy") != "" && p != "" {
		resp.Header.Set("Referrer-Policy", string(urlrewrite.UnsafeURL))
	}
}

// setsPolicy: a response to a request of this destination sets the
// referrer policy its own requests follow (spec/Referrer.agda setsPolicy;
// checked against Chromium).
func setsPolicy(dest string) bool {
	switch dest {
	case "document", "iframe", "frame", "embed", "object", "worker", "sharedworker", "serviceworker", "style":
		return true
	}
	return false
}

// requesterKey is the request context's page key of the requesting
// document, noted before its Referer is replaced (recordPagePolicy).
type requesterKey struct{}

// chromePriority is the Priority header (RFC 9218) Chrome most commonly
// sends for a request of this Sec-Fetch-Dest and Sec-Fetch-Mode, measured
// from Chromium 147 against an HTTP/2 server; "" for none (spec/Priority.agda).
//
// Chrome sends Priority only over HTTP/2 and HTTP/3. A browser reaching
// cyrano over HTTP/1.1 (local development) sends none, and cyrano's own
// HTTP/2 request to the upstream would then lack a header every Chrome
// request of that kind carries. The exact value depends on what only the
// browser knows (a script in the head or the body, async, an image in the
// viewport, fetchpriority) and varies natively, so the commonest one is
// used. Over HTTP/2 the browser's own header is forwarded as it is.
func chromePriority(dest, mode, method, purpose string) string {
	switch lowerASCII(dest) {
	case "document", "iframe", "frame", "embed", "object":
		return "u=0, i"
	case "style", "font":
		return "u=0"
	case "script", "json":
		return "u=1"
	case "image", "video", "audio", "track":
		return "i"
	case "worker", "sharedworker", "serviceworker":
		return "u=4, i"
	case "empty":
		// a prefetch, or a beacon (the commonest no-cors POST)
		if lowerASCII(purpose) == "prefetch" || (lowerASCII(mode) == "no-cors" && method == "POST") {
			return "u=4, i"
		}
		return "u=1, i"
	}
	return ""
}

// lowerASCII lowers A–Z only (as the spec's eqLower; strings.ToLower also
// folds the Kelvin sign).
func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// ensurePriority adds Chrome's Priority header to an https upstream request
// the browser sent over HTTP/1.x without one (see chromePriority).
func ensurePriority(req *http.Request, target *url.URL, incomingHTTP1 bool) {
	if !incomingHTTP1 || target.Scheme != "https" || req.Header.Get("Priority") != "" {
		return
	}
	if p := chromePriority(req.Header.Get("Sec-Fetch-Dest"), req.Header.Get("Sec-Fetch-Mode"), req.Method, req.Header.Get("Sec-Purpose")); p != "" {
		req.Header.Set("Priority", p)
	}
}

// Compression dictionaries (RFC 9842) are per origin: a site registers one
// with Use-As-Dictionary and the browser offers it back, to that origin
// only, in Available-Dictionary (adding dcb/dcz to Accept-Encoding). On the
// proxy origin one site's dictionary would be offered to every site. So
// none is ever registered — the upstream sees a browser that has no
// dictionary yet, as on a first visit (spec/Dictionary.agda).

// noDictionaryOffer removes what a browser holding a dictionary adds.
func noDictionaryOffer(req *http.Request) {
	req.Header.Del("Available-Dictionary")
	req.Header.Del("Dictionary-ID")
	if ae, ok := req.Header["Accept-Encoding"]; ok && len(ae) > 0 {
		if v := acceptEncodingWithoutDictionaries(ae[0]); v != ae[0] {
			req.Header.Set("Accept-Encoding", v)
		}
	}
}

// acceptEncodingWithoutDictionaries drops the dcb / dcz members (Dictionary
// acceptEncoding): by name before any ";", OWS trimmed, any case; the rest
// trimmed, joined by ", ". A value without such a member is unchanged.
func acceptEncodingWithoutDictionaries(ae string) string {
	parts := strings.Split(ae, ",")
	var kept []string
	dropped := false
	for _, e := range parts {
		name, _, _ := strings.Cut(e, ";")
		switch strings.ToLower(strings.Trim(name, " \t")) {
		case "dcb", "dcz":
			dropped = true
		default:
			kept = append(kept, strings.Trim(e, " \t"))
		}
	}
	if !dropped {
		return ae
	}
	return strings.Join(kept, ", ")
}

// noDictionaryRegistration keeps the browser from storing a dictionary:
// the header is changed, not removed (scripts read the origin's value
// through Crn-H) — a later type member wins, and a dictionary of an
// unknown type is not registered (Dictionary noRegistration).
func noDictionaryRegistration(resp *http.Response) {
	vs := resp.Header.Values("Use-As-Dictionary")
	if len(vs) == 0 {
		return
	}
	resp.Header.Set("Use-As-Dictionary", strings.Join(vs, ", ")+", type=crn")
}

// RecordMetaPolicy notes a page's Referrer-Policy as its
// <meta name="referrer"> states it (the HTML rewriter gives the tag
// unsafe-url, as recordPagePolicy does the header); false when content is
// no policy.
func RecordMetaPolicy(resp *http.Response, target *url.URL, content string) bool {
	p := urlrewrite.HeaderPolicy(content)
	if p == "" {
		return false
	}
	var req *http.Request
	if resp != nil {
		req = resp.Request
	}
	pagePolicies.set(sessionIn(req), pageKey(target), p)
	return true
}
