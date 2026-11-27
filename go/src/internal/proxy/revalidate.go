package proxy

// The browser's cache of rewritten scripts and stylesheets
// (spec/Freshness.agda; internal/rewritecache).
//
// A rewritten body went to the browser under the origin's Cache-Control,
// often immutable for a year: after the rewriter changed, a browser ran the
// old rewrite against the new runtime. Now such a body carries an ETag of
// its own — "crn<version>-<key>" — and a lifetime of at most an hour (its
// Last-Modified and Expires dropped: the browser's revalidation must come
// back with that ETag). A script reads the origin's headers (Crn-H).
//
// When the browser asks again with that ETag (If-None-Match):
//   - it is of this version and the origin's own lifetime has not run out
//     (by its Cache-Control / Expires / Last-Modified, its Age): the proxy
//     answers 304 itself — as the browser's cache would have, asking the
//     origin nothing;
//   - it is of this version and that lifetime has run out: the origin is
//     asked with its own validators (its ETag, Last-Modified), as the
//     browser would have asked it; its 304 is the browser's 304 (our ETag,
//     the new lifetime);
//   - it is of another version, or not known: the conditional headers go,
//     and the body comes again, rewritten anew.
// A conditional request the page makes itself (its fetch() with the
// origin's ETag it read) is not touched: only our ETags are ours.
//
// Per session: a session's validators are its own (an origin may answer
// sessions differently).

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yovico/cyrano/internal/rewritecache"
)

// browserCap: the longest a browser keeps a rewritten body without asking.
const browserCap = time.Hour

type browserURIKey struct{}

// withBrowserURI records the request URI the browser asked for (its marks
// included): the key of what it caches.
func withBrowserURI(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), browserURIKey{}, r.URL.RequestURI()))
}

type validators struct {
	ours       string // the ETag the browser holds
	originETag string
	originLM   string
	freshUntil time.Time
	at         time.Time
}

type validatorIndex struct {
	mu sync.Mutex
	m  map[string]validators
}

const validatorsMax = 200000

var revalidation = &validatorIndex{m: map[string]validators{}}

func (x *validatorIndex) put(key string, v validators) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if len(x.m) >= validatorsMax {
		now := time.Now()
		for k, e := range x.m {
			if now.After(e.freshUntil.Add(24*time.Hour)) || len(x.m) >= validatorsMax {
				delete(x.m, k)
			}
			if len(x.m) < validatorsMax*9/10 {
				break
			}
		}
	}
	x.m[key] = v
}

func (x *validatorIndex) get(key string) (validators, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	v, ok := x.m[key]
	return v, ok
}

func indexKey(session, uri string) string { return session + "\x00" + uri }

// ourETag is a rewritten body's ETag: this version, the body's cache key.
func ourETag(key string) string {
	v := rewritecache.Version
	if len(key) > 24 {
		key = key[:24]
	}
	return `"crn` + v + "-" + key + `"`
}

// versionPrefix is how our ETags of this version begin.
func versionPrefix() string { return `"crn` + rewritecache.Version + "-" }

func isOurs(etag string) bool { return strings.HasPrefix(strings.TrimPrefix(etag, "W/"), `"crn`) }

// NoteRewritten gives a rewritten script's or stylesheet's response the
// browser caching above; key is its rewrite's cache key.
func NoteRewritten(resp *http.Response, key string) {
	if resp.Request == nil || key == "" {
		return
	}
	now := time.Now()
	f := rewritecache.ResponseFreshness(resp.Header, now)
	if f.NoStore {
		return // nothing is kept: as the origin sent it
	}
	session, _ := resp.Request.Context().Value(SessionContextKey{}).(string)
	uri, _ := resp.Request.Context().Value(browserURIKey{}).(string)
	ours := ourETag(key)
	if uri != "" {
		revalidation.put(indexKey(session, uri), validators{
			ours: ours, originETag: resp.Header.Get("ETag"), originLM: resp.Header.Get("Last-Modified"),
			freshUntil: now.Add(f.Left), at: now,
		})
	}
	resp.Header.Set("ETag", ours)
	resp.Header.Set("Cache-Control", rewritecache.BrowserCC(f, browserCap))
	resp.Header.Del("Last-Modified")
	resp.Header.Del("Expires")
}

type revalidatingKey struct{}

// revalidate handles a browser's conditional request for a rewritten body:
// answered here (true), or the request to send on.
func revalidate(w http.ResponseWriter, r *http.Request, session string) (bool, *http.Request) {
	inm := r.Header.Get("If-None-Match")
	if inm == "" || !strings.Contains(inm, `"crn`) || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false, r
	}
	v, known := revalidation.get(indexKey(session, r.URL.RequestURI()))
	// Ours and of this version (a rewriter change makes every one stale).
	current := known && strings.Contains(inm, v.ours) && strings.HasPrefix(v.ours, versionPrefix())
	if current && time.Now().Before(v.freshUntil) {
		left := time.Until(v.freshUntil)
		if left > browserCap {
			left = browserCap
		}
		w.Header().Set("ETag", v.ours)
		w.Header().Set("Cache-Control", rewritecache.BrowserCC(rewritecache.Fresh{Left: left}, browserCap))
		w.WriteHeader(http.StatusNotModified)
		return true, r
	}
	r = r.Clone(r.Context())
	r.Header.Del("If-None-Match")
	r.Header.Del("If-Modified-Since")
	if current {
		// The origin's own validators, as the browser would have sent them.
		if v.originETag != "" {
			r.Header.Set("If-None-Match", v.originETag)
		}
		if v.originLM != "" {
			r.Header.Set("If-Modified-Since", v.originLM)
		}
		r = r.WithContext(context.WithValue(r.Context(), revalidatingKey{}, v))
	}
	return false, r
}

// revalidated turns the origin's 304 to a revalidation into the browser's:
// our ETag, the new lifetime.
func revalidated(resp *http.Response) {
	if resp.StatusCode != http.StatusNotModified || resp.Request == nil {
		return
	}
	v, ok := resp.Request.Context().Value(revalidatingKey{}).(validators)
	if !ok {
		return
	}
	now := time.Now()
	f := rewritecache.ResponseFreshness(resp.Header, now)
	if f.NoStore {
		return
	}
	session, _ := resp.Request.Context().Value(SessionContextKey{}).(string)
	uri, _ := resp.Request.Context().Value(browserURIKey{}).(string)
	if et := resp.Header.Get("ETag"); et != "" {
		v.originETag = et
	}
	if lm := resp.Header.Get("Last-Modified"); lm != "" {
		v.originLM = lm
	}
	v.freshUntil, v.at = now.Add(f.Left), now
	if uri != "" {
		revalidation.put(indexKey(session, uri), v)
	}
	resp.Header.Set("ETag", v.ours)
	resp.Header.Set("Cache-Control", rewritecache.BrowserCC(f, browserCap))
	resp.Header.Del("Last-Modified")
	resp.Header.Del("Expires")
}
