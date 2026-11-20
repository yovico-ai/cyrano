package proxy

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Framing restrictions — CSP frame-ancestors and X-Frame-Options — are
// about origins, and under the proxy the browser sees one origin: it would
// refuse a frame the origin allows ("frame-ancestors
// https://accounts.google.com", framed by accounts.google.com itself) and
// allow one it forbids (X-Frame-Options: SAMEORIGIN framed by another
// site). The proxy knows the embedding document (the proxied Referer of the
// frame's navigation) and judges for the browser: the header it sends says
// 'self' (the proxy) where the origin's policy admits the embedder, 'none'
// where it does not. Scripts still read the origin's headers.
//
// Only the immediate embedder is judged; natively every ancestor must be
// admitted.

// framedByKey is the context key of a framed document's embedder (*url.URL,
// its original URL).
type framedByKey struct{}

func originOf(u *url.URL) string { return u.Scheme + "://" + u.Host }

// embedderOf is the document that embeds a framed document being
// navigated to (spec/Frames.agda embedderOf). marked: the frame's URL
// carries the frame mark — the Referer's document gave it; recorded: the
// embedder recorded for the Referer's document when it was itself loaded
// as a frame ("": it was not). A frame navigating itself (unmarked, from a
// frame's document) keeps its embedder: support.microsoft.com's silent
// sign-in frame, back from login.microsoftonline.com by a form POST, was
// judged against login.microsoftonline.com and refused.
// inertFrame: whether a framed document being navigated to gets no runtime
// (spec/Frames.agda inertFrame) — its URL says so, or it is unmarked (a
// frame navigating itself) and the Referer's document was an inert frame's.
func inertFrame(markInert, marked, recorded bool) bool {
	return markInert || (!marked && recorded)
}

func embedderOf(marked bool, recorded, referer string) string {
	if !marked && recorded != "" {
		return recorded
	}
	return referer
}

// judgeFraming rewrites resp's framing restrictions for the embedder of
// the document it answers (spec/Csp.agda frameAncestors, xfoAllows); a
// response that is not a framed document, or whose embedder is unknown, is
// left as it is.
func judgeFraming(resp *http.Response, target *url.URL) {
	parent, _ := resp.Request.Context().Value(framedByKey{}).(*url.URL)
	if parent == nil || target == nil {
		return
	}
	self, embedder := target.String(), originOf(parent)+"/"
	// Every enforced policy that has frame-ancestors must admit the embedder.
	vals := resp.Header.Values("Content-Security-Policy")
	governed, allowed := false, true
	for _, header := range vals {
		if present, ok := urlrewrite.FrameAncestors(header, embedder, self); present {
			governed = true
			allowed = allowed && ok
		}
	}
	if governed {
		verdict := "'self'"
		if !allowed {
			verdict = "'none'"
		}
		resp.Header.Del("Content-Security-Policy")
		for _, header := range vals {
			if present, _ := urlrewrite.FrameAncestors(header, embedder, self); present {
				header = urlrewrite.WithFrameAncestors(header, verdict)
			}
			resp.Header.Add("Content-Security-Policy", header)
		}
		return // frame-ancestors makes X-Frame-Options moot
	}
	// The browser judges X-Frame-Options against the proxy origin, where
	// every embedder is same-origin: where the origin's verdict (for the
	// real embedder) is to block, the browser is told DENY.
	if xfo := resp.Header.Values("X-Frame-Options"); len(xfo) > 0 &&
		!urlrewrite.XFrameOptionsAllows(xfo, strings.EqualFold(originOf(target), originOf(parent))) {
		resp.Header.Set("X-Frame-Options", "DENY")
	}
}
