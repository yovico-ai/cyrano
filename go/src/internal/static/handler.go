// Package static serves files out of <repo>/go/assets — the same directory
// the TS client's vite build writes to. A request for /rewriter.js maps to
// <root>/client/rewriter.js where the bundle lives, while / and /index.html
// both serve <root>/index.html as the landing page.
package static

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The runtime bundle is addressed by its content: every page and frame
// names it as /rewriter.js?v=<hash> (RuntimeURL), and that URL is served
// immutable, so a page and its frames load it once. Served no-store, a
// page with 250 ad frames downloaded its 765 kB 250 times, ran into
// Chrome's limit on requests in flight (ERR_INSUFFICIENT_RESOURCES) and
// left frames without the runtime, whose scripts then reached their
// origins directly (windowscentral.com). A request without the current
// hash — an old page after a rebuild — gets the current bundle, revalidated.

var (
	assetsMu   sync.Mutex
	assetsRoot string
	bundle     struct {
		mod  time.Time
		size int64
		hash string
	}
)

// SetRoot names the assets directory RuntimeURL hashes the bundle from.
func SetRoot(root string) {
	assetsMu.Lock()
	defer assetsMu.Unlock()
	assetsRoot = root
}

// bundleHash is the hash of <root>/client/rewriter.js, recomputed when the
// file changes; "" when there is none.
func bundleHash() string {
	assetsMu.Lock()
	defer assetsMu.Unlock()
	if assetsRoot == "" {
		return ""
	}
	full := filepath.Join(assetsRoot, "client", "rewriter.js")
	st, err := os.Stat(full)
	if err != nil {
		return ""
	}
	if bundle.hash != "" && st.ModTime().Equal(bundle.mod) && st.Size() == bundle.size {
		return bundle.hash
	}
	f, err := os.Open(full)
	if err != nil {
		return ""
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return ""
	}
	bundle.mod, bundle.size, bundle.hash = st.ModTime(), st.Size(), hex.EncodeToString(sum.Sum(nil))[:16]
	return bundle.hash
}

// RuntimeURL is the runtime bundle's path as pages and frames are given it:
// path?v=<content hash> (path alone when the bundle cannot be read).
func RuntimeURL(path string) string {
	if h := bundleHash(); h != "" {
		return path + "?v=" + h
	}
	return path
}

// Handler serves files from a single root directory. The mapping is intentionally
// simple — we only handle a small fixed set of routes, no dirlisting, no negotiation.
type Handler struct {
	Root           string
	RewriterJSPath string // routes here resolve to <Root>/client/rewriter.js
	IsWebProxy     bool   // when true, also serve / and /index.html
}

// ServeHTTP implements http.Handler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == h.RewriterJSPath:
		// By its content hash, for good; anything else, revalidated.
		if v := bundleHash(); v != "" {
			w.Header().Set("ETag", `"`+v+`"`)
			if r.URL.Query().Get("v") == v {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
		} else {
			w.Header().Set("Cache-Control", "no-store")
		}
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
