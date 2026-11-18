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

// topSiteStore remembers, per session, the top-level site of framed
// documents by their URL. Bounded.
type topSiteStore struct {
	mu sync.Mutex
	m  map[string]string
}

const topSiteStoreMax = 8192

func (s *topSiteStore) set(session, doc, site string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = make(map[string]string)
	}
	if len(s.m) >= topSiteStoreMax {
		for k := range s.m {
			delete(s.m, k)
			break
		}
	}
	s.m[session+"\x00"+doc] = site
}

func (s *topSiteStore) get(session, doc string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[session+"\x00"+doc]
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
func (h *Handler) storageAccess(req *http.Request, target *url.URL, sessionID string) {
	mode := strings.ToLower(req.Header.Get("Sec-Fetch-Mode"))
	dest := strings.ToLower(req.Header.Get("Sec-Fetch-Dest"))
	credentials := strings.ToLower(req.Header.Get(CredentialsHeader))
	req.Header.Del(CredentialsHeader)

	from := h.requestingDocument(req)
	navigation := mode == "navigate"
	// A framed document's embedder, for judging its frame-ancestors and
	// X-Frame-Options against (frame_ancestors.go).
	if navigation && dest != "document" && from != nil {
		*req = *req.WithContext(context.WithValue(req.Context(), framedByKey{}, from))
	}
	var top string
	switch {
	case navigation && dest == "document":
		top = siteOf(target)
	case from != nil:
		if top = topSites.get(sessionID, pageKey(from)); top == "" {
			top = siteOf(from)
		}
	default:
		return // nothing known of the context: the browser's own header, if any, stands
	}
	req.Header.Del("Sec-Fetch-Storage-Access")
	if navigation {
		topSites.set(sessionID, pageKey(target), top)
	}
	if top == "" || siteOf(target) == top {
		return
	}
	credentialed := false
	switch {
	case credentials != "":
		credentialed = credentials == "include"
	case navigation || mode == "no-cors":
		credentialed = true
	case mode == "cors" && dest == "empty" && from != nil:
		// fetch/XHR by default: credentials to its own origin only.
		credentialed = from.Scheme == target.Scheme && strings.EqualFold(from.Host, target.Host)
	}
	if credentialed {
		req.Header.Set("Sec-Fetch-Storage-Access", "active")
	}
}
