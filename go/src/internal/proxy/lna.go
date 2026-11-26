package proxy

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yovico/cyrano/internal/dnscache"
	"github.com/yovico/cyrano/internal/upstream"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Local Network Access (spec/Lna.agda). Through the proxy every request is
// same-origin to the browser, so Chromium never judged one: a public
// site's page reached loopback and private addresses — the proxy host's
// own services, routers, cloud metadata — where Chromium refuses them
// without the user's permission (round K). The proxy judges it: a
// document's space is the address its response came from, a request's
// target the addresses its host resolves to (the most private of them),
// and a request to a less public space than its document's is refused
// before it is sent (the proxy cannot ask the user for the permission).

var pageSpaces struct {
	mu sync.Mutex
	m  map[string]urlrewrite.AddressSpace
}

func setPageSpace(session, page string, s urlrewrite.AddressSpace) {
	pageSpaces.mu.Lock()
	defer pageSpaces.mu.Unlock()
	if pageSpaces.m == nil {
		pageSpaces.m = map[string]urlrewrite.AddressSpace{}
	}
	if len(pageSpaces.m) >= policyStoreMax {
		for x := range pageSpaces.m {
			delete(pageSpaces.m, x)
			break
		}
	}
	pageSpaces.m[session+"\x00"+page] = s
}

func pageSpace(session, page string) (urlrewrite.AddressSpace, bool) {
	pageSpaces.mu.Lock()
	defer pageSpaces.mu.Unlock()
	s, ok := pageSpaces.m[session+"\x00"+page]
	return s, ok
}

// recordPageSpace notes a document's address space from the connection
// its response came over.
func (h *Handler) recordPageSpace(resp *http.Response) {
	if h.opts.LNASpaceOf != nil {
		if sp, ok := h.opts.LNASpaceOf(resp.Request.URL.Hostname()); ok {
			setPageSpace(sessionIn(resp.Request), pageKey(resp.Request.URL), sp)
		}
		return
	}
	info, ok := resp.Request.Context().Value(upstream.ConnInfoKey{}).(*upstream.ConnInfo)
	if !ok || info.Remote == "" {
		return
	}
	host, _, err := net.SplitHostPort(info.Remote)
	if err != nil {
		return
	}
	if ip := net.ParseIP(host); ip != nil {
		setPageSpace(sessionIn(resp.Request), pageKey(resp.Request.URL), urlrewrite.SpaceOf(ip))
	}
}

// targetSpace is the most private space of the addresses host resolves to
// (an IP literal: its own); false when it does not resolve.
func (h *Handler) targetSpace(host string) (urlrewrite.AddressSpace, bool) {
	if h.opts.LNASpaceOf != nil {
		return h.opts.LNASpaceOf(host)
	}
	h0 := strings.Trim(host, "[]")
	if ip := net.ParseIP(h0); ip != nil {
		return urlrewrite.SpaceOf(ip), true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	addrs, err := dnscache.Default.LookupIPAddr(ctx, h0)
	if err != nil || len(addrs) == 0 {
		return 0, false
	}
	s := urlrewrite.SpacePublic
	for _, a := range addrs {
		s = min(s, urlrewrite.SpaceOf(a.IP))
	}
	return s, true
}

// lnaRefused: the request goes to a less public space than its document's.
func (h *Handler) lnaRefused(r *http.Request, session, from, target string, targetHost string) bool {
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Mode"), "navigate") || from == "" {
		return false
	}
	doc, ok := pageSpace(session, from)
	if !ok || doc == urlrewrite.SpaceLoopback {
		return false
	}
	t, ok := h.targetSpace(targetHost)
	return ok && urlrewrite.LNARefused(doc, t, false)
}
