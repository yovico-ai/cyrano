package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Opaque Response Blocking for scripts (spec/Orb.agda; urlrewrite/orb.go).
//
// A page's <script> to another origin is a no-cors request, and Chromium
// blocks a response that is not script (a PDF, JSON, an HTML page): the
// element gets a network error. Through the proxy every script is
// same-origin and ran instead — a load event and a SyntaxError (Lenovo's
// /leid/assign JSON). The proxy fails such a response with a broken
// connection, as for CORS (cors.go), when it came without
// Access-Control-Allow-Origin: the proxy forces crossorigin on scripts and
// cannot tell the page's mode, and without that header a cors-mode request
// fails natively too (spec Orb.exactNoCors, neverWorse).

// ErrOrbBlocked fails a script response ORB would block.
var ErrOrbBlocked = errors.New("blocked by ORB")

type orbACAOKey struct{}

// noteOrbACAO records, before the response's headers are translated,
// whether the origin sent Access-Control-Allow-Origin.
func noteOrbACAO(resp *http.Response) {
	if resp.Request == nil {
		return
	}
	has := len(resp.Header.Values("Access-Control-Allow-Origin")) > 0
	resp.Request = resp.Request.WithContext(context.WithValue(resp.Request.Context(), orbACAOKey{}, has))
}

// OrbBlocks reports whether the proxy fails this response to a script
// request, given (at least) the first bytes of its decoded body.
func OrbBlocks(resp *http.Response, body []byte) bool {
	req := resp.Request
	if req == nil || req.URL == nil || !strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "script") {
		return false
	}
	page, _ := req.Context().Value(requesterKey{}).(string)
	// Cross-origin to the page that asked; with no page known (none of
	// ours behind the request) nothing is blocked, as before.
	cross := false
	if p, err := url.Parse(page); err == nil && page != "" {
		cross = !strings.EqualFold(p.Scheme+"://"+p.Host, req.URL.Scheme+"://"+req.URL.Host)
	}
	hasACAO, _ := req.Context().Value(orbACAOKey{}).(bool)
	cts, hasCT := resp.Header["Content-Type"]
	ct := ""
	if hasCT && len(cts) > 0 {
		ct = strings.Join(cts, ",")
	}
	redirect := resp.StatusCode >= 300 && resp.StatusCode < 400 && resp.Header.Get("Location") != ""
	return urlrewrite.ProxyOrbBlocks(cross, redirect, ct, hasCT, hasACAO, body)
}
