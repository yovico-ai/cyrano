package proxy

import (
	"net/http"
	"net/url"
	"sync"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// The page's own fetch directives, enforced here (spec Csp.cspRefuses).
// The browser is given a policy that admits the proxy, where every
// proxied resource is, so a script the page's policy refuses ran
// (awishcometrue.com: Mailchimp's script, refused directly, replaced the
// page's jQuery). A document's enforced policies — its headers' and its
// <meta>s' — are kept per session and page, and a subresource request it
// makes is refused before it is sent when they refuse it by the original
// URLs. (No violation is reported; a gap.)

var pageCSPs struct {
	mu sync.Mutex
	m  map[string][]string
}

func setPageCSP(session, page string, policies []string, add bool) {
	pageCSPs.mu.Lock()
	defer pageCSPs.mu.Unlock()
	if pageCSPs.m == nil {
		pageCSPs.m = map[string][]string{}
	}
	k := session + "\x00" + page
	if add {
		pageCSPs.m[k] = append(append([]string(nil), pageCSPs.m[k]...), policies...)
		return
	}
	if len(policies) == 0 {
		delete(pageCSPs.m, k)
		return
	}
	if len(pageCSPs.m) >= policyStoreMax {
		for x := range pageCSPs.m {
			delete(pageCSPs.m, x)
			break
		}
	}
	pageCSPs.m[k] = append([]string(nil), policies...)
}

func pageCSP(session, page string) []string {
	pageCSPs.mu.Lock()
	defer pageCSPs.mu.Unlock()
	return pageCSPs.m[session+"\x00"+page]
}

// RecordMetaCSP adds a page's <meta http-equiv="content-security-policy">
// to the policies it enforces.
func RecordMetaCSP(resp *http.Response, target *url.URL, content string) {
	var req *http.Request
	if resp != nil {
		req = resp.Request
	}
	setPageCSP(sessionIn(req), pageKey(target), []string{content}, true)
}

// cspRefused: the requesting document's own policies refuse the request.
func cspRefused(r *http.Request, session string, from, target *url.URL) bool {
	pols := pageCSP(session, pageKey(from))
	if len(pols) == 0 {
		return false
	}
	return urlrewrite.CSPRefuses(pols, r.Header.Get("Sec-Fetch-Dest"), from.String(), target.String())
}
