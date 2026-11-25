package proxy

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yovico/cyrano/internal/headerorder"
	"github.com/yovico/cyrano/internal/upstream"
)

// CORS preflights (spec/Preflight.agda), made by the proxy for the browser.
//
// Under the proxy every request is same-origin to the browser, so it never
// preflighted one: a cross-origin request that natively needs one (a PUT,
// a JSON POST, a header of the page's own) went to the origin unasked, and
// one the origin would refuse at the preflight acted there. Now a
// cross-origin request in cors mode (noteCORS) that needs one gets
// Chrome's preflight first, and fails — never sent — when it does not
// pass; a passed one is kept as Chromium keeps it (per session, origin,
// URL and credentials; Access-Control-Max-Age).
//
// The runtime names the headers the page set in AuthorHeader (Crn-A: their
// names, "," joined; "!" for an XHR with upload listeners, which forces a
// preflight) — the browser's own (client hints, Priority) must not count.
// A body's Content-Type counts whoever set it.
const AuthorHeader = "Crn-A"

type preflightKey struct{}

// preflightNeed is what a request's preflight needs.
type preflightNeed struct {
	origin  string
	cred    bool
	method  string
	unsafe  []string
	headers string // Access-Control-Request-Headers
	session string
}

// The preflight's header order, Chrome's (measured, HTTP/1.1 and TLS).
var preflightOrder = []string{"host", "connection", "accept", "access-control-request-method", "access-control-request-headers",
	"origin", "user-agent", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "referer", "accept-encoding"}

// unsafeByte, langChar, safelistedHeader … mirror spec/Preflight.agda.
func unsafeByte(c byte) bool {
	return c < 0x20 && c != '\t' || c == 0x7f || strings.IndexByte("\"():<>?@[\\]{}", c) >= 0
}

func langChar(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || strings.IndexByte(" *,-.;=", c) >= 0
}

func allBytes(s string, f func(byte) bool) bool {
	for i := 0; i < len(s); i++ {
		if !f(s[i]) {
			return false
		}
	}
	return true
}

func mimeEssenceOWS(v string) string {
	if i := strings.IndexByte(v, ';'); i >= 0 {
		v = v[:i]
	}
	return strings.ToLower(strings.Trim(v, " \t"))
}

func digitsValue(s string) uint64 {
	var n uint64
	for i := 0; i < len(s); i++ {
		n = n*10 + uint64(s[i]-'0')
	}
	return n
}

func isDigits(s string) bool { return allBytes(s, func(c byte) bool { return c >= '0' && c <= '9' }) }

func simpleRange(v string) bool {
	rest, ok := strings.CutPrefix(v, "bytes=")
	if !ok {
		return false
	}
	start, end, ok := strings.Cut(rest, "-")
	if !ok || start == "" || !isDigits(start) || !isDigits(end) {
		return false
	}
	return end == "" || digitsValue(end) >= digitsValue(start)
}

func safelistedHeader(name, v string) bool {
	if len(v) > 128 {
		return false
	}
	switch strings.ToLower(name) {
	case "accept":
		return allBytes(v, func(c byte) bool { return !unsafeByte(c) })
	case "accept-language", "content-language":
		return allBytes(v, langChar)
	case "content-type":
		if !allBytes(v, func(c byte) bool { return !unsafeByte(c) }) {
			return false
		}
		switch mimeEssenceOWS(v) {
		case "application/x-www-form-urlencoded", "multipart/form-data", "text/plain":
			return true
		}
		return false
	case "range":
		return simpleRange(v)
	}
	return false
}

type headerPair struct{ name, value string }

// unsafeNames: lowercased, sorted, no repeats.
func unsafeNames(hs []headerPair) []string {
	seen := map[string]bool{}
	var out []string
	for _, h := range hs {
		if safelistedHeader(h.name, h.value) {
			continue
		}
		n := strings.ToLower(h.name)
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func safelistedMethod(m string) bool { return m == "GET" || m == "HEAD" || m == "POST" }

func needsPreflight(method string, force bool, hs []headerPair) bool {
	return force || !safelistedMethod(method) || len(unsafeNames(hs)) > 0
}

func requestHeadersValue(hs []headerPair) string { return strings.Join(unsafeNames(hs), ",") }

// listItems: the items of the field lines, as written; ok false when one
// is not a token.
func listItems(lines []string) ([]string, bool) {
	var out []string
	for _, l := range lines {
		for _, it := range strings.Split(l, ",") {
			it = strings.Trim(it, " \t")
			if it == "" {
				continue
			}
			if !allBytes(it, isTchar) {
				return nil, false
			}
			out = append(out, it)
		}
	}
	return out, true
}

func isTchar(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// allowed is what a passed preflight allows (kept in the cache).
type allowed struct {
	methods, headers []string // as listed; headers lowercased
}

func (a allowed) admits(method string, cred bool, unsafe []string) bool {
	if !safelistedMethod(method) && !contains(a.methods, method) && (cred || !contains(a.methods, "*")) {
		return false
	}
	for _, n := range unsafe {
		if !contains(a.headers, n) && (cred || !contains(a.headers, "*")) {
			return false
		}
	}
	return true
}

// preflightResult: whether a preflight response passes, and what it allows.
func preflightResult(status int, acao, acac []string, am, ah []string, origin string, cred bool, method string, unsafe []string) (allowed, bool) {
	if status < 200 || status >= 300 || !corsCheck(acao, acac, origin, cred) {
		return allowed{}, false
	}
	ms, ok1 := listItems(am)
	hs, ok2 := listItems(ah)
	if !ok1 || !ok2 {
		return allowed{}, false
	}
	for i := range hs {
		hs[i] = strings.ToLower(hs[i])
	}
	a := allowed{methods: ms, headers: hs}
	return a, a.admits(method, cred, unsafe)
}

func preflightOk(status int, acao, acac []string, am, ah []string, origin string, cred bool, method string, unsafe []string) bool {
	_, ok := preflightResult(status, acao, acac, am, ah, origin, cred, method, unsafe)
	return ok
}

// maxAge (spec Preflight.maxAge): seconds a passed preflight is kept.
func maxAge(v string, present bool) int {
	if !present {
		return 5
	}
	v = strings.Trim(v, " \t")
	if d, ok := strings.CutPrefix(v, "-"); ok && d != "" && isDigits(d) {
		return 0
	}
	if v == "" || !isDigits(v) {
		return 5
	}
	if len(v) > 5 || digitsValue(v) > 7200 {
		return 7200
	}
	return int(digitsValue(v))
}

// notePreflight records, from the runtime's Crn-A and the request, whether
// a cross-origin cors request needs a preflight (called by noteCORS, which
// has judged it one, and consumed Crn-A: names).
func notePreflight(req *http.Request, c corsRequest, names string) {
	force := false
	var hs []headerPair
	seen := map[string]bool{}
	for _, n := range strings.Split(names, ",") {
		n = strings.ToLower(strings.TrimSpace(n))
		if n == "!" {
			force = true
			continue
		}
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		if vs := req.Header.Values(n); len(vs) > 0 {
			hs = append(hs, headerPair{n, strings.Join(vs, ", ")})
		}
	}
	if vs := req.Header.Values("Content-Type"); len(vs) > 0 && !seen["content-type"] {
		hs = append(hs, headerPair{"content-type", strings.Join(vs, ", ")})
	}
	if !needsPreflight(req.Method, force, hs) {
		return
	}
	*req = *req.WithContext(context.WithValue(req.Context(), preflightKey{}, preflightNeed{
		origin: c.origin, cred: c.credentialed, method: req.Method, unsafe: unsafeNames(hs), headers: requestHeadersValue(hs),
		session: sessionIn(req),
	}))
}

// preflightCache: passed preflights, per session, origin, URL and credentials.
var preflightCache = struct {
	sync.Mutex
	m map[string]preflightEntry
}{m: map[string]preflightEntry{}}

type preflightEntry struct {
	allowed
	until time.Time
}

const preflightCacheMax = 4096

// preflighting sends a request's preflight before it, when it needs one.
type preflighting struct{ next http.RoundTripper }

func (p preflighting) RoundTrip(req *http.Request) (*http.Response, error) {
	need, ok := req.Context().Value(preflightKey{}).(preflightNeed)
	if !ok {
		return p.next.RoundTrip(req)
	}
	key := need.session + "\x00" + need.origin + "\x00" + req.URL.String() + "\x00" + strconv.FormatBool(need.cred)
	now := time.Now()
	preflightCache.Lock()
	e, hit := preflightCache.m[key]
	preflightCache.Unlock()
	if hit && now.Before(e.until) && e.admits(need.method, need.cred, need.unsafe) {
		return p.next.RoundTrip(req)
	}
	ctx := context.WithValue(headerorder.WithOrder(req.Context(), preflightOrder), upstream.NoClientHintsKey{}, true)
	pre, err := http.NewRequestWithContext(ctx, http.MethodOptions, req.URL.String(), nil)
	if err != nil {
		return nil, err
	}
	pre.Host = req.Host
	pre.Header.Set("Accept", "*/*")
	pre.Header.Set("Access-Control-Request-Method", need.method)
	if need.headers != "" {
		pre.Header.Set("Access-Control-Request-Headers", need.headers)
	}
	pre.Header.Set("Origin", need.origin)
	for _, h := range []string{"User-Agent", "Sec-Fetch-Site", "Referer", "Accept-Encoding"} {
		if v, ok := req.Header[h]; ok {
			pre.Header[h] = v
		}
	}
	pre.Header.Set("Sec-Fetch-Mode", "cors")
	pre.Header.Set("Sec-Fetch-Dest", "empty")
	resp, err := p.next.RoundTrip(pre)
	if err != nil {
		return nil, err
	}
	resp.Body.Close()
	a, passed := preflightResult(resp.StatusCode, resp.Header.Values("Access-Control-Allow-Origin"), resp.Header.Values("Access-Control-Allow-Credentials"),
		resp.Header.Values("Access-Control-Allow-Methods"), resp.Header.Values("Access-Control-Allow-Headers"), need.origin, need.cred, need.method, need.unsafe)
	if !passed {
		return nil, errCORS
	}
	if age := maxAge(resp.Header.Get("Access-Control-Max-Age"), len(resp.Header.Values("Access-Control-Max-Age")) > 0); age > 0 {
		preflightCache.Lock()
		if len(preflightCache.m) >= preflightCacheMax {
			for k := range preflightCache.m {
				delete(preflightCache.m, k)
				break
			}
		}
		preflightCache.m[key] = preflightEntry{allowed: a, until: now.Add(time.Duration(age) * time.Second)}
		preflightCache.Unlock()
	}
	return p.next.RoundTrip(req)
}
