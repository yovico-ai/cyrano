//go:build e2e

package e2e

// The browser's cache of rewritten scripts (proxy/revalidate.go,
// spec/Freshness.agda) and the rewrite cache (internal/rewritecache),
// against the full stack.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"sync"
	"testing"

	"github.com/yovico/cyrano/internal/rewritecache"
)

type originLog struct {
	mu   sync.Mutex
	reqs []string // "<path> inm=<If-None-Match>"
}

func (o *originLog) add(s string) { o.mu.Lock(); o.reqs = append(o.reqs, s); o.mu.Unlock() }
func (o *originLog) all() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.reqs...)
}

func scriptGet(t *testing.T, c *http.Client, url, inm string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Sec-Fetch-Dest", "script")
	req.Header.Set("Sec-Fetch-Mode", "no-cors")
	if inm != "" {
		req.Header.Set("If-None-Match", inm)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp
}

func TestE2E_RewrittenScriptCaching(t *testing.T) {
	log := &originLog{}
	origin := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		log.add(r.URL.Path + " inm=" + r.Header.Get("If-None-Match"))
		w.Header().Set("Content-Type", "text/javascript")
		switch r.URL.Path {
		case "/long.js": // a bundle the origin calls immutable for a year
			w.Header().Set("ETag", `"o-long"`)
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case "/short.js": // stale at once: the origin is asked again
			w.Header().Set("ETag", `"o-short"`)
			w.Header().Set("Cache-Control", "max-age=0")
			if r.Header.Get("If-None-Match") == `"o-short"` {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		io.WriteString(w, "var u = location.href;")
	})
	proxy := startProxy(t)
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	// A first request gives the session.
	getViaWithCookie(t, proxy, origin.URL+"/", "")
	long := strings.Replace(gotoURL(proxy, origin.URL+"/long.js"), "/cyrano/http/", "/cyrano/http!js/", 1)

	r := scriptGet(t, c, long, "")
	ours := r.Header.Get("ETag")
	if r.StatusCode != 200 || !strings.HasPrefix(ours, `"crn`) {
		t.Fatalf("first: %d ETag %q; want 200 and our ETag", r.StatusCode, ours)
	}
	if cc := r.Header.Get("Cache-Control"); cc != "max-age=3600" {
		t.Fatalf("Cache-Control to the browser %q; want the capped max-age=3600", cc)
	}
	var crnH map[string][]string
	_ = json.Unmarshal([]byte(r.Header.Get("Crn-H")), &crnH)
	if crnH["etag"] == nil || crnH["etag"][0] != `"o-long"` || crnH["cache-control"] == nil {
		t.Fatalf("Crn-H %q: the page must read the origin's ETag and Cache-Control", r.Header.Get("Crn-H"))
	}

	// Asked again within the origin's lifetime: 304 here, the origin not asked.
	before := len(log.all())
	if r := scriptGet(t, c, long, ours); r.StatusCode != http.StatusNotModified || r.Header.Get("ETag") != ours {
		t.Fatalf("revalidation within the origin's lifetime: %d %q; want 304 with our ETag", r.StatusCode, r.Header.Get("ETag"))
	}
	if n := len(log.all()); n != before {
		t.Fatalf("the origin was asked (%v); a fresh body is answered by the proxy", log.all()[before:])
	}

	// Stale by the origin: asked with its own ETag; its 304 is ours.
	short := strings.Replace(gotoURL(proxy, origin.URL+"/short.js"), "/cyrano/http/", "/cyrano/http!js/", 1)
	sr := scriptGet(t, c, short, "")
	sOurs := sr.Header.Get("ETag")
	if r := scriptGet(t, c, short, sOurs); r.StatusCode != http.StatusNotModified || r.Header.Get("ETag") != sOurs {
		t.Fatalf("revalidation past the origin's lifetime: %d %q; want the origin's 304 as ours", r.StatusCode, r.Header.Get("ETag"))
	}
	if got := log.all(); got[len(got)-1] != `/short.js inm="o-short"` {
		t.Fatalf("origin asked %q; want its own validator", got[len(got)-1])
	}

	// Another version (the rewriter changed): the body again, rewritten anew.
	was := rewritecache.Version
	rewritecache.Version = was + "x"
	r2 := scriptGet(t, c, long, ours)
	rewritecache.Version = was
	if r2.StatusCode != 200 || r2.Header.Get("ETag") == ours {
		t.Fatalf("after a version change: %d %q; want 200 and a new ETag", r2.StatusCode, r2.Header.Get("ETag"))
	}
	if got := log.all(); got[len(got)-1] != "/long.js inm=" {
		t.Fatalf("origin asked %q; want an unconditional request", got[len(got)-1])
	}

	// The page's own conditional request (the origin's ETag it read) is
	// the origin's to answer.
	scriptGet(t, c, long, `"o-long"`)
	if got := log.all(); got[len(got)-1] != `/long.js inm="o-long"` {
		t.Fatalf("the page's own If-None-Match: origin got %q", got[len(got)-1])
	}

	// Another session, the same bytes: one rewrite kept.
	n := rewritecache.Shared.Len()
	jar2, _ := cookiejar.New(nil)
	c2 := &http.Client{Jar: jar2}
	if r := scriptGet(t, c2, long, ""); r.StatusCode != 200 {
		t.Fatalf("another session: %d", r.StatusCode)
	}
	if rewritecache.Shared.Len() != n {
		t.Fatalf("another session's same bytes made another cache entry (%d → %d)", n, rewritecache.Shared.Len())
	}
}
