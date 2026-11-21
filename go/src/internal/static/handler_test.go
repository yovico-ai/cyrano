package static

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The runtime is named by its content hash and cached for good under it;
// any other name for it is revalidated, so a rebuilt bundle is never
// served stale (a page and its frames once downloaded it once per frame).
func TestRuntimeByContentHash(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "client"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "client", "rewriter.js")
	write := func(s string, at time.Time) {
		if err := os.WriteFile(file, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
		_ = os.Chtimes(file, at, at)
	}
	write("one", time.Unix(1_000_000, 0))
	SetRoot(root)
	defer SetRoot("")
	h := &Handler{Root: root, RewriterJSPath: "/rewriter.js"}
	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}

	u1 := RuntimeURL("/rewriter.js")
	if !strings.HasPrefix(u1, "/rewriter.js?v=") {
		t.Fatalf("RuntimeURL = %q", u1)
	}
	if r := get(u1); r.Code != 200 || r.Body.String() != "one" || !strings.Contains(r.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("hashed URL: %d %q %q", r.Code, r.Body.String(), r.Header().Get("Cache-Control"))
	}
	if r := get("/rewriter.js"); r.Header().Get("Cache-Control") != "no-cache" || r.Header().Get("ETag") == "" {
		t.Errorf("bare URL: Cache-Control %q, ETag %q", r.Header().Get("Cache-Control"), r.Header().Get("ETag"))
	}

	write("two", time.Unix(2_000_000, 0))
	u2 := RuntimeURL("/rewriter.js")
	if u2 == u1 {
		t.Fatal("the URL did not change with the bundle")
	}
	// The old name now gets the new bundle, revalidated, never cached for good.
	if r := get(u1); r.Body.String() != "two" || r.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("old hash: %q %q", r.Body.String(), r.Header().Get("Cache-Control"))
	}
	if r := get(u2); r.Body.String() != "two" || !strings.Contains(r.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("new hash: %q %q", r.Body.String(), r.Header().Get("Cache-Control"))
	}
}
