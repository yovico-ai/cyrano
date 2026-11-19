package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// What the upstream receives as Referer / Origin / Sec-Fetch-Site must be
// what a direct browser would send (spec/Referrer.agda; the rules
// themselves are checked against the spec in urlrewrite). Here: the
// Director applies them, from the proxied Referer and the referring page's
// recorded policy.
func TestDirectFetchHeaders(t *testing.T) {
	upstream, captured := startUpstream(t) // http://127.0.0.1:port
	h := New(Options{ProxyCfg: devProxyCfg()})
	proxied := func(original string) string {
		return urlrewrite.Rewrite(original, nil, devProxyCfg()) // the real proxified URL, query included
	}
	send := func(method, target string, hdr map[string]string) http.Header {
		req := httptest.NewRequest(method, cyranoPath(target), nil)
		req.Host = "localhost:9081"
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		func() {
			// A cross-origin request this test upstream does not allow
			// (no CORS headers) is aborted by the proxy (cors.go); what
			// went upstream is captured all the same.
			defer func() {
				if r := recover(); r != nil && r != http.ErrAbortHandler {
					panic(r)
				}
			}()
			h.ServeHTTP(httptest.NewRecorder(), req)
		}()
		return captured.headers
	}
	up, _ := url.Parse(upstream.URL)
	crossPage := "https://page.example/a/b?q=1"

	// A request made under its own referrer policy carries it in its
	// proxified URL (/cyrano/http!<policy>/…); the browser sent the full
	// page URL (unsafe-url) and the proxy applies the request's policy.
	t.Run("a request's own referrer policy, from its URL", func(t *testing.T) {
		for policy, want := range map[urlrewrite.Policy]string{
			urlrewrite.Origin:     "https://page.example/",
			urlrewrite.NoReferrer: "",
			urlrewrite.UnsafeURL:  crossPage,
			urlrewrite.SameOrigin: "",
		} {
			marked := urlrewrite.RewriteWithPolicy(upstream.URL+"/f", nil, devProxyCfg(), policy)
			req := httptest.NewRequest("GET", strings.TrimPrefix(marked, "http://localhost:9081"), nil)
			req.Host = "localhost:9081"
			req.Header.Set("Referer", proxied(crossPage))
			req.Header.Set("Sec-Fetch-Dest", "iframe")
			req.Header.Set("Sec-Fetch-Mode", "navigate")
			func() {
				defer func() {
					if r := recover(); r != nil && r != http.ErrAbortHandler {
						panic(r)
					}
				}()
				h.ServeHTTP(httptest.NewRecorder(), req)
			}()
			if got := captured.headers.Get("Referer"); got != want {
				t.Errorf("%s: Referer %q, want %q", policy, got, want)
			}
		}
	})

	t.Run("cross-origin referrer is trimmed to the origin by default", func(t *testing.T) {
		got := send("GET", upstream.URL+"/img.png", map[string]string{
			"Referer": proxied(crossPage) + "#frag", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image",
		})
		// https page → http loopback target: loopback is potentially trustworthy, so no downgrade.
		if v := got.Get("Referer"); v != "https://page.example/" {
			t.Errorf("Referer = %q, want origin only", v)
		}
		if v := got.Get("Sec-Fetch-Site"); v != "cross-site" {
			t.Errorf("Sec-Fetch-Site = %q, want cross-site", v)
		}
		if v := got.Get("Origin"); v != "" {
			t.Errorf("Origin = %q on a no-cors GET, want none", v)
		}
	})

	// A blob: worker sends no Referer; the runtime names its origin
	// (Cloudflare's challenge fetches hagen.challenges.cloudflare.com so).
	t.Run("a referrer-less context is told by the initiator header", func(t *testing.T) {
		got := send("GET", upstream.URL+"/i", map[string]string{
			"Crn-I": "https://page.example", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
		})
		if v := got.Get("Origin"); v != "https://page.example" {
			t.Errorf("Origin = %q", v)
		}
		if v := got.Get("Sec-Fetch-Site"); v != "cross-site" {
			t.Errorf("Sec-Fetch-Site = %q", v)
		}
		if got.Get("Referer") != "" || got.Get("Crn-I") != "" {
			t.Errorf("Referer %q, Crn-I %q went upstream", got.Get("Referer"), got.Get("Crn-I"))
		}
		got = send("GET", upstream.URL+"/i", map[string]string{
			"Crn-I": upstream.URL, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
		})
		if got.Get("Origin") != "" || got.Get("Sec-Fetch-Site") != "same-origin" {
			t.Errorf("same-origin GET: Origin %q, site %q", got.Get("Origin"), got.Get("Sec-Fetch-Site"))
		}
		got = send("GET", upstream.URL+"/i", map[string]string{"Crn-I": "javascript:1"})
		if got.Get("Crn-I") != "" {
			t.Error("the initiator header went upstream")
		}
	})

	t.Run("same-origin referrer is sent whole, without fragment", func(t *testing.T) {
		got := send("GET", upstream.URL+"/next", map[string]string{
			"Referer": proxied(upstream.URL+"/page?x=1") + "#f", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
		})
		if v := got.Get("Referer"); v != upstream.URL+"/page?x=1" {
			t.Errorf("Referer = %q", v)
		}
		if v := got.Get("Sec-Fetch-Site"); v != "same-origin" {
			t.Errorf("Sec-Fetch-Site = %q", v)
		}
	})

	t.Run("a cross-origin fetch() GET gets the Origin the browser omitted", func(t *testing.T) {
		got := send("GET", upstream.URL+"/api", map[string]string{
			"Referer": proxied(crossPage), "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
		})
		if v := got.Get("Origin"); v != "https://page.example" {
			t.Errorf("Origin = %q, want the page's origin", v)
		}
	})

	t.Run("the proxy's own Origin is never forwarded", func(t *testing.T) {
		got := send("POST", upstream.URL+"/api", map[string]string{
			"Referer": proxied(crossPage), "Origin": "http://localhost:9081", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
		})
		if v := got.Get("Origin"); v != "https://page.example" {
			t.Errorf("Origin = %q", v)
		}
		got = send("POST", upstream.URL+"/api", map[string]string{"Origin": "http://localhost:9081"})
		if v := got.Get("Origin"); v != up.Scheme+"://"+up.Host {
			t.Errorf("Origin without a referrer = %q, want the target's origin", v)
		}
	})

	t.Run("the page's own policy is applied", func(t *testing.T) {
		page, _ := url.Parse(crossPage)
		pagePolicies.set(pageKey(page), urlrewrite.NoReferrer)
		defer pagePolicies.set(pageKey(page), "")
		got := send("GET", upstream.URL+"/img.png", map[string]string{"Referer": proxied(crossPage), "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors"})
		if v, ok := got["Referer"]; ok {
			t.Errorf("Referer = %q under no-referrer, want none", v)
		}
	})

	t.Run("a proxy Referer that names no page is dropped", func(t *testing.T) {
		got := send("GET", upstream.URL+"/x", map[string]string{"Referer": "http://localhost:9081/"})
		if v, ok := got["Referer"]; ok {
			t.Errorf("Referer = %q, want none", v)
		}
	})
}

func TestRecordPagePolicy(t *testing.T) {
	target, _ := url.Parse("https://site.example/doc")
	resp := &http.Response{
		Header:  http.Header{"Referrer-Policy": {"no-referrer, same-origin"}, "Content-Type": {"text/html"}},
		Request: &http.Request{Header: http.Header{"Sec-Fetch-Dest": {"document"}}},
	}
	recordPagePolicy(resp, target)
	defer pagePolicies.set(pageKey(target), "")
	if p := pagePolicies.get(pageKey(target)); p != urlrewrite.SameOrigin {
		t.Errorf("recorded policy = %q, want same-origin (the last recognized token)", p)
	}
	// The browser is told unsafe-url so the server always sees the full referrer.
	if v := resp.Header.Get("Referrer-Policy"); v != "unsafe-url" {
		t.Errorf("Referrer-Policy to the browser = %q", v)
	}
	// A subresource's header is not a document policy.
	img := &http.Response{Header: http.Header{"Referrer-Policy": {"origin"}}, Request: &http.Request{Header: http.Header{"Sec-Fetch-Dest": {"image"}}}}
	other, _ := url.Parse("https://site.example/i.png")
	recordPagePolicy(img, other)
	if p := pagePolicies.get(pageKey(other)); p != urlrewrite.DefaultPolicy {
		t.Errorf("an image recorded policy %q", p)
	}
}
