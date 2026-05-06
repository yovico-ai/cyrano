// Package static serves files out of <repo>/go/assets — the same directory
// the TS client's vite build writes to. A request for /rewriter.js maps to
// <root>/client/rewriter.js where the bundle lives, while / and /index.html
// both serve <root>/index.html as the landing page.
package static

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Handler serves files from a single root directory. The mapping is intentionally
// simple — we only handle a small fixed set of routes, no dirlisting, no negotiation.
type Handler struct {
	Root         string
	RewriterJSPath string // routes here resolve to <Root>/client/rewriter.js
	IsWebProxy   bool   // when true, also serve / and /index.html
}

// ServeHTTP implements http.Handler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == h.RewriterJSPath:
		// Never cache the JS bundle — it's rebuilt frequently and child frames
		// must always load the current version, not a 304-stale copy.
		w.Header().Set("Cache-Control", "no-store")
		h.serveFile(w, r, "client/rewriter.js")
	case h.IsWebProxy && (r.URL.Path == "/" || r.URL.Path == "/index.html"):
		h.serveFile(w, r, "index.html")
	case h.IsWebProxy && strings.HasPrefix(r.URL.Path, "/images/"):
		// /images/logo.png → <Root>/images/logo.png
		h.serveFile(w, r, strings.TrimPrefix(r.URL.Path, "/"))
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveFile(w http.ResponseWriter, r *http.Request, rel string) {
	full := filepath.Join(h.Root, rel)
	// Defensive — never let a relative path escape the root.
	if !strings.HasPrefix(full, h.Root+string(filepath.Separator)) && full != h.Root {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Set Content-Type explicitly for the common cases — http.ServeContent will
	// sniff otherwise, and we want predictable behavior.
	switch filepath.Ext(rel) {
	case ".js":
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	case ".html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".ico":
		w.Header().Set("Content-Type", "image/x-icon")
	}
	http.ServeContent(w, r, rel, stat.ModTime(), f)
}
