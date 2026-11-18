package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestCORSCheck(t *testing.T) {
	target, _ := url.Parse("https://api.test/data")
	mk := func(mode, initiator, creds string, resp http.Header) bool {
		req := httptest.NewRequest("GET", "https://api.test/data", nil)
		req.Header.Set("Sec-Fetch-Mode", mode)
		if initiator != "" {
			req.Header.Set(InitiatorHeader, initiator)
		}
		if creds != "" {
			req.Header.Set(CredentialsHeader, creds)
		}
		noteCORS(req, target)
		return corsFails(&http.Response{Header: resp, Request: req})
	}
	page := "https://site.test/p?q=1"
	for _, c := range []struct {
		name              string
		mode, init, creds string
		h                 http.Header
		fails             bool
	}{
		{"no ACAO", "cors", page, "omit", http.Header{}, true},
		{"wildcard", "cors", page, "omit", http.Header{"Access-Control-Allow-Origin": {"*"}}, false},
		{"exact", "cors", page, "omit", http.Header{"Access-Control-Allow-Origin": {"https://site.test"}}, false},
		{"other origin", "cors", page, "omit", http.Header{"Access-Control-Allow-Origin": {"https://x.test"}}, true},
		{"wildcard with credentials", "cors", page, "include", http.Header{"Access-Control-Allow-Origin": {"*"}}, true},
		{"credentials without ACAC", "cors", page, "include", http.Header{"Access-Control-Allow-Origin": {"https://site.test"}}, true},
		{"credentials allowed", "cors", page, "include", http.Header{"Access-Control-Allow-Origin": {"https://site.test"}, "Access-Control-Allow-Credentials": {"true"}}, false},
		{"two ACAO values", "cors", page, "omit", http.Header{"Access-Control-Allow-Origin": {"*", "*"}}, true},
		{"same origin", "cors", "https://api.test/x", "include", http.Header{}, false},
		{"no-cors mode", "no-cors", page, "omit", http.Header{}, false},
		{"no runtime header (a script element)", "cors", "", "", http.Header{}, false},
	} {
		if got := mk(c.mode, c.init, c.creds, c.h); got != c.fails {
			t.Errorf("%s: fails=%v, want %v", c.name, got, c.fails)
		}
	}
}
