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

// judgeFraming rewrites resp's framing restrictions for the embedder of
// the document it answers; a response that is not a framed document, or
// whose embedder is unknown, is left as it is.
func judgeFraming(resp *http.Response, target *url.URL) {
	parent, _ := resp.Request.Context().Value(framedByKey{}).(*url.URL)
	if parent == nil || target == nil {
		return
	}
	self, embedder := originOf(target), originOf(parent)
	governed := false // a frame-ancestors directive makes X-Frame-Options moot
	if vals := resp.Header.Values("Content-Security-Policy"); len(vals) > 0 {
		resp.Header.Del("Content-Security-Policy")
		for _, header := range vals {
			var out []string
			for _, policy := range strings.Split(header, ",") {
				present, allowed := urlrewrite.FrameAncestors(policy, embedder, self)
				if present {
					governed = true
					verdict := "frame-ancestors 'self'"
					if !allowed {
						verdict = "frame-ancestors 'none'"
					}
					var dirs []string
					for _, d := range strings.Split(policy, ";") {
						if f := strings.Fields(d); len(f) > 0 && strings.EqualFold(f[0], "frame-ancestors") {
							dirs = append(dirs, " "+verdict)
							continue
						}
						dirs = append(dirs, d)
					}
					policy = strings.TrimPrefix(strings.Join(dirs, ";"), " ")
				}
				out = append(out, policy)
			}
			resp.Header.Add("Content-Security-Policy", strings.Join(out, ","))
		}
	}
	if xfo := resp.Header.Get("X-Frame-Options"); xfo != "" && !governed {
		switch strings.ToUpper(strings.TrimSpace(strings.Split(xfo, ",")[0])) {
		case "SAMEORIGIN":
			if !strings.EqualFold(self, embedder) {
				resp.Header.Set("X-Frame-Options", "DENY")
			}
		}
	}
}
