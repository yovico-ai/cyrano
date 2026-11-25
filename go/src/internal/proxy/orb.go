package proxy

import (
	"fmt"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Opaque Response Blocking for scripts (spec/Orb.agda; urlrewrite/orb.go).
//
// A page's <script> to another origin without crossorigin is a no-cors
// request, and Chromium blocks a response that is not script (a PDF, JSON,
// an HTML page): the element gets a network error. Through the proxy every
// script is same-origin and ran instead — a load event and a SyntaxError
// (Lenovo's /leid/assign JSON; snowball-io's HTML answered with
// Access-Control-Allow-Origin: *). The browser asks the proxy in the page's
// own mode (the runtimes leave a missing crossorigin missing), so the
// proxy fails such a response with a broken connection, as for CORS
// (cors.go), when the request was no-cors. A cors-mode script gets the
// CORS check instead (scriptCORSFails).

// ErrOrbBlocked fails a script response ORB would block.
var ErrOrbBlocked = errors.New("blocked by ORB")

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
	if opaque, _ := req.Context().Value(opaqueRequesterKey{}).(bool); opaque && page != "" {
		cross = true // a sandboxed document's origin is no URL's
	}
	noCors := strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "no-cors")
	cts, hasCT := resp.Header["Content-Type"]
	ct := ""
	if hasCT && len(cts) > 0 {
		ct = strings.Join(cts, ",")
	}
	redirect := resp.StatusCode >= 300 && resp.StatusCode < 400 && resp.Header.Get("Location") != ""
	return urlrewrite.ProxyOrbBlocks(cross, redirect, ct, hasCT, noCors, body)
}

// integrityKey carries the integrity mark of the request's proxified URL.
type integrityKey struct{}

// ErrIntegrity fails a response whose bytes do not match the element's
// integrity (spec/Sri.agda fails): a network error, as ORB's.
var ErrIntegrity = fmt.Errorf("integrity mismatch: %w", ErrOrbBlocked)

// SRIFails reports whether the proxy fails this response (spec Sri.fails)
// for the integrity its URL carries, given its whole decoded body: an
// opaque response (another origin's, asked in no-cors mode — a script
// without crossorigin) is not eligible, any other must match.
func SRIFails(resp *http.Response, body []byte) bool {
	req := resp.Request
	if req == nil || req.URL == nil {
		return false
	}
	mark, _ := req.Context().Value(integrityKey{}).(string)
	if mark == "" {
		return false
	}
	page, _ := req.Context().Value(requesterKey{}).(string)
	cross := false
	if p, err := url.Parse(page); err == nil && page != "" {
		cross = !strings.EqualFold(p.Scheme+"://"+p.Host, req.URL.Scheme+"://"+req.URL.Host)
	}
	if opaque, _ := req.Context().Value(opaqueRequesterKey{}).(bool); opaque && page != "" {
		cross = true
	}
	noCors := strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "no-cors")
	return urlrewrite.SRIFails(mark, true, !(cross && noCors), body)
}

// subresourceRequesterKey marks a request whose Referer is a script or
// stylesheet the proxy served, not a document.
type subresourceRequesterKey struct{}

// opaqueRequesterKey marks a request from an opaque-origin (sandboxed) document.
type opaqueRequesterKey struct{}

// scriptCORSFails reports whether a cors-mode element request's
// cross-origin response — a script's, a stylesheet's, an image's, a
// font's, media's… (spec Orb.corsElementDest) — fails the CORS check
// (spec Orb.corsFails, Fetch.corsCheck): by the page's origin, with
// credentials when the URL carries a credentials mark (use-credentials). A
// redirect is checked too, as natively. Read before the response's
// headers are translated.
func scriptCORSFails(resp *http.Response) bool {
	req := resp.Request
	if req == nil || req.URL == nil || !corsElementDest(req.Header.Get("Sec-Fetch-Dest")) ||
		!strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "cors") {
		return false
	}
	if _, ok := req.Context().Value(corsKey{}).(corsRequest); ok {
		return false // the runtime named the context: corsFails judges it
	}
	if sub, _ := req.Context().Value(subresourceRequesterKey{}).(bool); sub {
		return false // asked by a script (a module's import): its document is not known
	}
	page, _ := req.Context().Value(requesterKey{}).(string)
	p, err := url.Parse(page)
	if err != nil || page == "" || p.Scheme == "" || p.Host == "" {
		return false
	}
	origin := strings.ToLower(p.Scheme) + "://" + strings.ToLower(p.Host)
	if opaque, _ := req.Context().Value(opaqueRequesterKey{}).(bool); opaque {
		origin = "null" // a sandboxed document: cross-origin to everything
	} else if strings.EqualFold(origin, req.URL.Scheme+"://"+req.URL.Host) {
		return false
	}
	// The element's credentials mode, by its URL's mark (use-credentials: include).
	mark, _ := req.Context().Value(destContextKey{}).(urlrewrite.Dest)
	cred := mark == urlrewrite.DestCred || mark == urlrewrite.DestScriptCred || mark == urlrewrite.DestStyleCred
	return !corsCheck(resp.Header.Values("Access-Control-Allow-Origin"), resp.Header.Values("Access-Control-Allow-Credentials"), origin, cred)
}

// corsElementDest: an element destination whose cors-mode requests the
// proxy CORS-checks (spec/Orb.agda corsElementDest).
func corsElementDest(d string) bool {
	switch strings.ToLower(d) {
	case "script", "style", "image", "font", "audio", "video", "track", "audioworklet", "paintworklet", "sharedstorageworklet", "manifest", "json":
		return true
	}
	return false
}

// opaqueElementCORS: a sandboxed (opaque-origin) document is cross-origin
// to the proxy, so the browser runs the CORS check of its elements' cors
// requests itself — and the runtimes made those use-credentials
// (Attrs.crossoriginValue), so "*" fails where natively, anonymous, it
// passes. A response the check for anonymous allows from origin "null" is
// told to the browser as allowing that origin with credentials; one it
// refuses is left to fail, as natively. Fetch and XHR keep the page's own
// mode (Sec-Fetch-Dest empty): untouched. Scripts still read the origin's
// values (Crn-H).
func opaqueElementCORS(resp *http.Response) {
	req := resp.Request
	if req == nil {
		return
	}
	if opaque, _ := req.Context().Value(opaqueRequesterKey{}).(bool); !opaque ||
		!strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "cors") {
		return
	}
	if d := strings.ToLower(req.Header.Get("Sec-Fetch-Dest")); d == "" || d == "empty" {
		return
	}
	if !corsCheck(resp.Header.Values("Access-Control-Allow-Origin"), nil, "null", false) {
		return
	}
	resp.Header.Set("Access-Control-Allow-Origin", "null")
	resp.Header.Set("Access-Control-Allow-Credentials", "true")
}
