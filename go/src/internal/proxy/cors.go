package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// The CORS check (Fetch §4.9), done by the proxy for the browser.
//
// Under the proxy every request is same-origin, so the browser never fails
// a cross-origin one: a page's fetch or XHR to an origin that does not
// allow it succeeds through the proxy, where natively it fails (hackage's
// documentation search loads an index cross-origin and, natively, reports
// that it could not). The runtime names the requesting context and the
// credentials mode in two request headers (InitiatorHeader,
// CredentialsHeader; ts/client/src/patches/cors.ts) and the browser states
// the mode (Sec-Fetch-Mode); a cross-origin request in "cors" mode whose
// response fails the check is answered with a broken connection — to page
// code exactly what a CORS failure is: fetch rejects with a TypeError, an
// XHR reports status 0 and an error event.
//
// Not done: preflights (a request that natively needs one is sent without).

type corsKey struct{}

// corsRequest is what the check needs of a request.
type corsRequest struct {
	origin       string // the requesting context's origin, as Origin serializes it
	credentialed bool
}

// errCORS fails a response the CORS check refuses.
var errCORS = errors.New("cors check failed")

// noteCORS records, before the runtime's headers are consumed, what the CORS
// check of the response to req will need; nothing for a request that is
// not a script's cross-origin request in cors mode.
func noteCORS(req *http.Request, target *url.URL) {
	if !strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "cors") {
		return
	}
	origin := initiatorOrigin(req.Header.Get(InitiatorHeader))
	if origin == "" || strings.EqualFold(origin, target.Scheme+"://"+target.Host) {
		return
	}
	cred := strings.EqualFold(req.Header.Get(CredentialsHeader), "include")
	*req = *req.WithContext(context.WithValue(req.Context(), corsKey{}, corsRequest{origin: origin, credentialed: cred}))
}

// corsFails reports whether the response fails the CORS check of the
// request it answers.
func corsFails(resp *http.Response) bool {
	if resp.Request == nil {
		return false
	}
	c, ok := resp.Request.Context().Value(corsKey{}).(corsRequest)
	if !ok {
		return false
	}
	allow := resp.Header.Values("Access-Control-Allow-Origin")
	if len(allow) != 1 { // none, or more than one: failure
		return true
	}
	a := strings.TrimSpace(allow[0])
	if !c.credentialed && a == "*" {
		return false
	}
	if a != c.origin {
		return true
	}
	return c.credentialed && strings.TrimSpace(resp.Header.Get("Access-Control-Allow-Credentials")) != "true"
}
