package proxy

import (
	"context"
	"errors"
	"github.com/yovico/cyrano/internal/upstream"
	"github.com/yovico/cyrano/internal/urlrewrite"
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
// A request that natively needs a preflight gets one first (preflight.go).

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
// KindHeader is the runtime's Crn-K: "xhr" on an XHR's request (its
// page-set headers go first, as Chrome sends them). It never goes upstream.
const KindHeader = "Crn-K"

func (h *Handler) noteCORS(req *http.Request, target *url.URL, mark urlrewrite.Dest) {
	if strings.EqualFold(req.Header.Get(KindHeader), "xhr") {
		*req = *req.WithContext(context.WithValue(req.Context(), upstream.XHRKey{}, true))
	}
	req.Header.Del(KindHeader)
	authors, hasAuthors := req.Header[AuthorHeader] // consumed here whatever the request (preflight.go)
	req.Header.Del(AuthorHeader)
	// (Not from a sandboxed document — cross-site to the browser, which runs
	// CORS there itself by "null": fetch_headers.go opaqueElementCORS.)
	referred := ""
	if from := h.originalReferrer(req.Header.Get("Referer")); from != nil && !strings.EqualFold(req.Header.Get("Sec-Fetch-Site"), "cross-site") {
		referred = from.Scheme + "://" + from.Host
	}
	origin, ok := corsOrigin(req.Header.Get("Sec-Fetch-Mode"), req.Header.Get("Sec-Fetch-Dest"),
		initiatorOrigin(req.Header.Get(InitiatorHeader)), referred, target.Scheme+"://"+target.Host)
	if !ok {
		return
	}
	// Credentials as the page set them (Crn-C), else as the URL's mark says
	// (a use-credentials element, a credentialed EventSource). The target is
	// of another origin here: "same-origin" includes none.
	cc := req.Header.Get(CredentialsHeader)
	cred := strings.EqualFold(cc, "include") || (cc == "" && mark.Credentialed())
	c := corsRequest{origin: origin, credentialed: cred}
	*req = *req.WithContext(context.WithValue(req.Context(), corsKey{}, c))
	if hasAuthors {
		notePreflight(req, c, strings.Join(authors, ","))
	} else {
		notePreflight(req, c, "")
	}
}

// corsOrigin is spec Fetch.corsOrigin: the origin a request is CORS-checked
// by — the context the runtime named, else for a request for no destination
// its Referer's document's — and false for none (not cors mode, the
// target's own origin). Mode and destination as the Sec-Fetch-* headers
// carry them; origins as serialized, "" for none.
func corsOrigin(mode, dest, named, referred, target string) (string, bool) {
	if !strings.EqualFold(mode, "cors") {
		return "", false
	}
	o := named
	if o == "" {
		if !strings.EqualFold(dest, "empty") {
			return "", false
		}
		o = referred
	}
	if o == "" || strings.EqualFold(o, target) {
		return "", false
	}
	return o, true
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
	return !corsCheck(resp.Header.Values("Access-Control-Allow-Origin"), resp.Header.Values("Access-Control-Allow-Credentials"), c.origin, c.credentialed)
}

// corsCheck is the CORS check (Fetch §4.9; spec/Fetch.agda corsCheck) of a
// response with these Access-Control-Allow-Origin and -Credentials field
// lines, for a request from origin (its serialization).
func corsCheck(allowOrigin, allowCredentials []string, origin string, credentialed bool) bool {
	ao, ok := combineField(allowOrigin)
	if !ok {
		return false
	}
	if !credentialed && ao == "*" {
		return true
	}
	if ao != origin {
		return false
	}
	if !credentialed {
		return true
	}
	ac, ok := combineField(allowCredentials)
	return ok && ac == "true"
}

// combineField is a header's value as Fetch's "get" gives it (spec/Fetch.agda
// combine): its field lines, each trimmed of space and tab, joined by ", ";
// false when there is none.
func combineField(lines []string) (string, bool) {
	if len(lines) == 0 {
		return "", false
	}
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = strings.Trim(l, " \t")
	}
	return strings.Join(out, ", "), true
}
