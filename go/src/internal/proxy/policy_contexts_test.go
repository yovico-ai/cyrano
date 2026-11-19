package proxy

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

func TestSpecConformance_SetsPolicy(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		d := rapid.SampledFrom([]string{"document", "iframe", "frame", "embed", "object", "worker", "sharedworker", "serviceworker", "style",
			"script", "image", "empty", "font", "audioworklet", "paintworklet", "manifest", "report", ""}).Draw(rt, "dest")
		want, _, err := oracle.Ask("setspolicy", d)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := setsPolicy(d); got != (want == "yes") {
			rt.Fatalf("setsPolicy(%q) = %v, spec %s", d, got, want)
		}
	})
}

func policyResp(dest, target, policy string, requester string) *http.Response {
	u, _ := url.Parse(target)
	req := &http.Request{URL: u, Header: http.Header{"Sec-Fetch-Dest": {dest}}}
	if requester != "" {
		req = req.WithContext(context.WithValue(context.Background(), requesterKey{}, requester))
	}
	resp := &http.Response{Request: req, Header: http.Header{}}
	if policy != "" {
		resp.Header.Set("Referrer-Policy", policy)
	}
	return resp
}

// A worker's and a stylesheet's Referrer-Policy govern their own requests
// (recorded in Chromium): it reached the browser, which then sent only the
// proxy's origin, and the proxy could not name the worker upstream. A
// stylesheet without one follows its document's.
func TestRecordPagePolicy_WorkersAndStylesheets(t *testing.T) {
	r := policyResp("worker", "https://w.example/w.js", "origin", "")
	recordPagePolicy(r, r.Request.URL)
	if r.Header.Get("Referrer-Policy") != string(urlrewrite.UnsafeURL) || pagePolicies.get(pageKey(r.Request.URL)) != "origin" {
		t.Errorf("worker: header %q, recorded %q", r.Header.Get("Referrer-Policy"), pagePolicies.get(pageKey(r.Request.URL)))
	}
	doc, _ := url.Parse("https://d.example/page")
	pagePolicies.set(pageKey(doc), "no-referrer")
	s := policyResp("style", "https://cdn.example/a.css", "", pageKey(doc))
	recordPagePolicy(s, s.Request.URL)
	if got := pagePolicies.get(pageKey(s.Request.URL)); got != "no-referrer" || s.Header.Get("Referrer-Policy") != "" {
		t.Errorf("stylesheet: recorded %q, header %q", got, s.Header.Get("Referrer-Policy"))
	}
	sc := policyResp("script", "https://cdn.example/a.js", "origin", "")
	recordPagePolicy(sc, sc.Request.URL)
	if sc.Header.Get("Referrer-Policy") != "origin" {
		t.Error("a script's header was taken as a policy")
	}
}
