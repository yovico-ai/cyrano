package proxy

import (
	"net/http"
	"net/url"
	"sort"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

func hintNames(h http.Header) string {
	var out []string
	for k := range h {
		if isHint(strings.ToLower(k)) {
			out = append(out, strings.ToLower(k))
		}
	}
	sort.Strings(out)
	return strings.Join(out, " ")
}

// One site's Accept-CH must not make the browser's hints reach another:
// each origin gets the low-entropy hints plus what it asked for itself.
func TestClientHintsPerOrigin(t *testing.T) {
	pub, _ := url.Parse("http://localhost:9081")
	h := &Handler{opts: Options{ProxyCfg: urlrewrite.ProxyConfig{PublicURL: pub}}}
	a, _ := url.Parse("https://a.example/")
	b, _ := url.Parse("https://b.example/")

	doc := &http.Response{Header: http.Header{"Accept-Ch": {"Sec-CH-UA-Arch, Sec-CH-UA-Model;x=1", "RTT"}, "Critical-Ch": {"Sec-CH-UA-Arch"}},
		Request: &http.Request{Header: http.Header{"Sec-Fetch-Dest": {"document"}}}}
	recordAcceptCH(doc, a, "s1")
	if got := doc.Header.Values("Accept-CH"); len(got) != 2 || doc.Header.Get("Critical-CH") == "" {
		t.Errorf("the origin's own Accept-CH / Critical-CH go to the browser as sent: %v", doc.Header)
	}
	img := &http.Response{Header: http.Header{"Accept-Ch": {"Sec-CH-UA-Bitness"}}, Request: &http.Request{Header: http.Header{"Sec-Fetch-Dest": {"image"}}}}
	recordAcceptCH(img, b, "s1")
	if _, ok := img.Header["Accept-Ch"]; ok {
		t.Errorf("Accept-CH on a subresource is ignored by browsers; got %v", img.Header)
	}
	// A document of an origin that asks for nothing clears the browser's set;
	// one that asked before (and sends no header now) gets its set again.
	plain := func(u *url.URL) string {
		r := &http.Response{Header: http.Header{}, Request: &http.Request{Header: http.Header{"Sec-Fetch-Dest": {"document"}}}}
		recordAcceptCH(r, u, "s1")
		if _, ok := r.Header["Accept-Ch"]; !ok {
			t.Errorf("%s: no Accept-CH for the browser", u)
		}
		return r.Header.Get("Accept-CH")
	}
	if got := plain(b); got != "" {
		t.Errorf("b asked for nothing; browser told %q", got)
	}
	if got := plain(a); got != "rtt, sec-ch-ua-arch, sec-ch-ua-model" {
		t.Errorf("a's set for the browser: %q", got)
	}

	browser := func(dest, referer string) *http.Request {
		r := &http.Request{Header: http.Header{}}
		for _, n := range []string{"Sec-Ch-Ua", "Sec-Ch-Ua-Mobile", "Sec-Ch-Ua-Platform", "Sec-Ch-Ua-Arch", "Sec-Ch-Ua-Model", "Sec-Ch-Ua-Bitness", "Rtt", "Downlink", "Save-Data"} {
			r.Header.Set(n, "v")
		}
		r.Header.Set("Sec-Fetch-Dest", dest)
		if referer != "" {
			r.Header.Set("Referer", referer)
		}
		return r
	}
	const low = "sec-ch-ua sec-ch-ua-mobile sec-ch-ua-platform"
	cases := []struct {
		name, session, dest, referer string
		target                       *url.URL
		want                         string
	}{
		{"navigation to the origin that asked", "s1", "document", "", a, "rtt " + low[:9] + " sec-ch-ua-arch sec-ch-ua-mobile sec-ch-ua-model sec-ch-ua-platform"},
		{"its same-origin subresource", "s1", "script", "http://localhost:9081/cyrano/https/a.example/p", a, "rtt sec-ch-ua sec-ch-ua-arch sec-ch-ua-mobile sec-ch-ua-model sec-ch-ua-platform"},
		{"another origin", "s1", "document", "", b, low},
		{"a cross-origin request to it", "s1", "image", "http://localhost:9081/cyrano/https/b.example/p", a, low},
		{"another session", "s2", "document", "", a, low},
	}
	for _, tc := range cases {
		r := browser(tc.dest, tc.referer)
		h.filterClientHints(r, tc.target, tc.session)
		if got := hintNames(r.Header); got != tc.want {
			t.Errorf("%s:\n got  %s\n want %s", tc.name, got, tc.want)
		}
		if r.Header.Get("Save-Data") == "" {
			t.Errorf("%s: Save-Data is the user's setting, not a requested hint", tc.name)
		}
	}
}

func TestNoCompressionDictionaryAcrossSites(t *testing.T) {
	r := &http.Request{Header: http.Header{}}
	r.Header.Set("Available-Dictionary", ":abc=:")
	r.Header.Set("Dictionary-ID", `"d"`)
	r.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd, dcb, dcz")
	noDictionaryOffer(r)
	if r.Header.Get("Available-Dictionary") != "" || r.Header.Get("Dictionary-ID") != "" || r.Header.Get("Accept-Encoding") != "gzip, deflate, br, zstd" {
		t.Errorf("dictionary offer not removed: %v", r.Header)
	}
	resp := &http.Response{Header: http.Header{"Use-As-Dictionary": {`match="/*"`}}}
	noDictionaryRegistration(resp)
	if got := resp.Header.Get("Use-As-Dictionary"); got != `match="/*", type=crn` {
		t.Errorf("Use-As-Dictionary: %q (kept, made unregistrable)", got)
	}
}

type rtFunc func(*http.Request) (*http.Response, error)

func (f rtFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Chrome restarts a navigation whose response names, in Critical-CH, hints
// the request lacked. Through the proxy the browser has already sent them
// (to the proxy's origin) and the proxy withheld them — so the proxy sends
// the second request, and the origin sees what a direct Chrome shows it.
func TestCriticalCHRestart(t *testing.T) {
	target, _ := url.Parse("https://cf.example/page")
	var second *http.Request
	h := &Handler{transport: rtFunc(func(r *http.Request) (*http.Response, error) {
		second = r
		return &http.Response{StatusCode: 403, Header: http.Header{"Set-Cookie": {"b=2"}, "X-Which": {"second"}}, Body: http.NoBody, Request: r}, nil
	})}
	req := &http.Request{Method: "GET", URL: target, Header: http.Header{}}
	for _, n := range []string{"Sec-Ch-Ua", "Sec-Ch-Ua-Arch", "Sec-Ch-Ua-Model", "Sec-Ch-Ua-Bitness"} {
		req.Header.Set(n, "v-"+n)
	}
	req.Header.Set("Sec-Fetch-Dest", "document")
	req.Header.Set("Cookie", "a=1; x=old")
	h.filterClientHints(req, target, "s-crit") // nothing asked yet: high-entropy hints withheld
	if req.Header.Get("Sec-Ch-Ua-Arch") != "" || req.Header.Get("Sec-Ch-Ua") == "" {
		t.Fatalf("first request should carry low-entropy hints only: %v", req.Header)
	}
	resp := &http.Response{StatusCode: 403, Body: http.NoBody, Request: req, Header: http.Header{
		"Accept-Ch":   {"Sec-CH-UA-Arch, Sec-CH-UA-Model"},
		"Critical-Ch": {"Sec-CH-UA-Arch"},
		"Set-Cookie":  {"x=new; Path=/; HttpOnly"},
		"X-Which":     {"first"},
	}}
	h.restartForCriticalCH(resp)
	if second == nil || resp.Header.Get("X-Which") != "second" {
		t.Fatalf("no restart: %v", resp.Header)
	}
	if second.Header.Get("Sec-Ch-Ua-Arch") == "" || second.Header.Get("Sec-Ch-Ua-Model") == "" || second.Header.Get("Sec-Ch-Ua-Bitness") != "" {
		t.Errorf("second request should carry exactly the hints asked for: %v", second.Header)
	}
	if got := second.Header.Get("Cookie"); got != "a=1; x=new" {
		t.Errorf("second request's cookies: %q", got)
	}
	if got := resp.Header.Values("Set-Cookie"); len(got) != 2 || got[0] != "x=new; Path=/; HttpOnly" || got[1] != "b=2" {
		t.Errorf("cookies of both responses should be set: %v", got)
	}

	// No restart when the request already carried what is critical.
	second = nil
	plain := &http.Response{StatusCode: 200, Body: http.NoBody, Request: second2(req), Header: http.Header{"Accept-Ch": {"Sec-CH-UA-Arch"}, "Critical-Ch": {"Sec-CH-UA"}}}
	h.restartForCriticalCH(plain)
	if second != nil {
		t.Errorf("restarted although the critical hint was sent")
	}
}

func second2(r *http.Request) *http.Request { return r.Clone(r.Context()) }
