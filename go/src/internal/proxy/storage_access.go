package proxy

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Sec-Fetch-Storage-Access, as Chrome sends it (Storage Access Headers,
// Chrome 133+): on a request that carries credentials to a site other than
// the top-level document's — a third-party frame's own requests, a
// third-party frame's navigation — the browser states the context's access
// to unpartitioned cookies: "active" where third-party cookies are allowed
// (Chrome's default outside Incognito), "none" where they are blocked.
//
// Under the proxy every request is first-party to the proxy and the browser
// sends no such header. The proxy adds it: it learns each framed
// document's top-level site as the frame is navigated (from the Referer,
// which names the embedding document), and the requesting document from the
// Referer or, where there is none, from the runtime's InitiatorHeader.
// Cloudflare's Turnstile frame is such a third-party frame: every request
// it makes to challenges.cloudflare.com carries the header natively.
//
// Not known here: whether this browser blocks third-party cookies (then
// "none"); the credentials mode of a script or stylesheet (cyrano forces
// crossorigin on them): those get no header.

// CredentialsHeader is a request header the runtime adds beside
// InitiatorHeader: the request's credentials mode as the page set it,
// "include" or "omit" (fetch's "same-origin" resolved against the target).
// It never goes upstream.
const CredentialsHeader = "Crn-C"

// frameContext is a framed document's context: its top-level site, and
// whether a document of its chain (itself included) is of another site.
type frameContext struct {
	top   string
	cross bool
	// embedder: the document that embeds this one (its original URL), when
	// it was loaded as a frame; "" for a top-level document.
	embedder string
}

// topSiteStore remembers, per session, the context of framed documents by
// their URL. Bounded.
type topSiteStore struct {
	mu sync.Mutex
	m  map[string]frameContext
}

const topSiteStoreMax = 8192

func (s *topSiteStore) set(session, doc string, c frameContext) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = make(map[string]frameContext)
	}
	if len(s.m) >= topSiteStoreMax {
		for k := range s.m {
			delete(s.m, k)
			break
		}
	}
	s.m[session+"\x00"+doc] = c
}

func (s *topSiteStore) get(session, doc string) (frameContext, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.m[session+"\x00"+doc]
	return c, ok
}

var topSites topSiteStore

// siteOf is u's schemeful site: scheme and registrable domain (the host
// itself where it has none).
func siteOf(u *url.URL) string {
	return urlrewrite.SchemefulSite(pageKey(u))
}

// requestingDocument is the original URL of the document (or worker
// creator) a request comes from: by its proxied Referer, else by the
// runtime's InitiatorHeader; nil when neither tells.
func (h *Handler) requestingDocument(req *http.Request) *url.URL {
	if from := h.originalReferrer(req.Header.Get("Referer")); from != nil {
		return from
	}
	v := req.Header.Get(InitiatorHeader)
	if initiatorOrigin(v) == "" {
		return nil
	}
	u, err := url.Parse(v)
	if err != nil {
		return nil
	}
	u.User, u.Fragment, u.RawFragment = nil, "", ""
	return u
}

// storageAccess sets Sec-Fetch-Storage-Access on the outgoing request as a
// direct browser would, and notes the top-level site of a document being
// navigated to. It reads the proxied Referer and the runtime's headers: call
// it before directFetchHeaders replaces them.
func (h *Handler) storageAccess(req *http.Request, target *url.URL, sessionID string, frameMarked bool) {
	mode := strings.ToLower(req.Header.Get("Sec-Fetch-Mode"))
	dest := strings.ToLower(req.Header.Get("Sec-Fetch-Dest"))
	credentials := strings.ToLower(req.Header.Get(CredentialsHeader))
	req.Header.Del(CredentialsHeader)

	from := h.requestingDocument(req)
	navigation := mode == "navigate"
	// A framed document's embedder, for judging its frame-ancestors and
	// X-Frame-Options against (frame_ancestors.go).
	// Its parent: the Referer's document when that document gave the frame
	// this URL (marked), the embedder of the Referer's document when a
	// frame navigates itself (spec Frames embedderOf).
	framedBy := ""
	if navigation && dest != "document" && from != nil {
		recorded, _ := topSites.get(sessionID, pageKey(from))
		framedBy = embedderOf(frameMarked, recorded.embedder, pageKey(from))
		if by, err := url.Parse(framedBy); err == nil {
			*req = *req.WithContext(context.WithValue(req.Context(), framedByKey{}, by))
		}
	}
	var ctx frameContext // the requesting document's (for a navigation: the embedder's)
	switch {
	case navigation && dest == "document":
		ctx = frameContext{top: siteOf(target)}
	case from != nil:
		var ok bool
		if ctx, ok = topSites.get(sessionID, pageKey(from)); !ok {
			ctx = frameContext{top: siteOf(from)} // a top-level document
		}
	default:
		return // nothing known of the context: the browser's own header, if any, stands
	}
	req.Header.Del("Sec-Fetch-Storage-Access")
	targetSite := siteOf(target)
	if navigation {
		topSites.set(sessionID, pageKey(target), frameContext{top: ctx.top, cross: ctx.cross || targetSite != ctx.top, embedder: framedBy})
	}
	cred := credentials
	if cred == "" {
		if navigation || mode == "no-cors" {
			cred = "include"
		} else {
			cred = "same-origin" // fetch's and a cors element's default
		}
	}
	fromOrigin := ""
	if from != nil {
		fromOrigin = strings.ToLower(from.Scheme + "://" + from.Host)
	}
	if storageAccessActive(mode, dest, cred, ctx, fromOrigin, strings.ToLower(target.Scheme+"://"+target.Host), targetSite, urlrewrite.Trustworthy(target)) {
		req.Header.Set("Sec-Fetch-Storage-Access", "active")
	}
}

// storageAccessActive: whether a direct browser sends
// Sec-Fetch-Storage-Access: active (spec/Storage.agda storageAccess) — to a
// trustworthy target, not on a top-level navigation, on a third-party
// request (any document of the chain, or the target, of another site than
// the top-level one: a cross-site frame's requests to the top-level site
// are) that carries credentials.
func storageAccessActive(mode, dest, cred string, ctx frameContext, from, to, targetSite string, trustworthy bool) bool {
	if !trustworthy || mode == "navigate" && dest == "document" || ctx.top == "" {
		return false
	}
	if !ctx.cross && targetSite == ctx.top {
		return false
	}
	switch cred {
	case "include":
		return true
	case "same-origin":
		return from != "" && from == to
	}
	return false
}
