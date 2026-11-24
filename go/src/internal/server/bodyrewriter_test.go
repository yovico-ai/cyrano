package server

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

// jsd (Cloudflare bot-detection) scripts must be detected so they are served
// unmodified — rewriting them trips their self-integrity check and the script
// spins in a tight loop that freezes the whole page.
func TestIsJSDScript(t *testing.T) {
	jsd := []string{
		"https://x.com/cdn-cgi/challenge-platform/scripts/jsd/main.js",
		"https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload",
		"https://x.com/cdn-cgi/challenge-platform/h/b/scripts/jsd/80a697ecdece/main.js",
	}
	notJSD := []string{
		"https://x.com/cdn-cgi/challenge-platform/orchestrate/chl_page/v1",
		"https://abs.twimg.com/responsive-web/client-web/vendor.f1cda39a.js",
		"https://x.com/i/api/graphql/x",
	}
	for _, s := range jsd {
		u, _ := url.Parse(s)
		if !isJSDScript(u) {
			t.Errorf("isJSDScript(%q) = false, want true", s)
		}
	}
	for _, s := range notJSD {
		u, _ := url.Parse(s)
		if isJSDScript(u) {
			t.Errorf("isJSDScript(%q) = true, want false", s)
		}
	}
}

func mkResp(encoding string, body []byte) *http.Response {
	h := http.Header{}
	if encoding != "" {
		h.Set("Content-Encoding", encoding)
	}
	return &http.Response{Header: h, Body: io.NopCloser(bytes.NewReader(body))}
}

func gzipBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func brotliBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := brotli.NewWriter(&buf)
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zstdBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestReadDecompressedBody covers every Content-Encoding the proxy advertises
// in Accept-Encoding, so we never advertise an encoding we can't decode. zstd
// is the regression guard for the Chrome-parity Accept-Encoding change.
func TestReadDecompressedBody(t *testing.T) {
	const payload = "<html><body>cyrano decompression payload — 0123456789</body></html>"

	cases := []struct {
		name     string
		encoding string
		body     []byte
	}{
		{"gzip", "gzip", gzipBytes(t, payload)},
		{"brotli", "br", brotliBytes(t, payload)},
		{"zstd", "zstd", zstdBytes(t, payload)},
		{"identity", "", []byte(payload)},
		{"gzip-mixed-case", "GZIP", gzipBytes(t, payload)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := mkResp(c.encoding, c.body)
			got, err := readDecompressedBody(resp)
			if err != nil {
				t.Fatalf("readDecompressedBody: %v", err)
			}
			if string(got) != payload {
				t.Errorf("decoded body mismatch:\n got %q\nwant %q", got, payload)
			}
			// Content-Encoding must be stripped so the browser treats our
			// rewritten (plaintext) body as-is.
			if ce := resp.Header.Get("Content-Encoding"); ce != "" {
				t.Errorf("Content-Encoding not stripped: %q", ce)
			}
		})
	}
}

// A document with no Content-Type is sniffed as the browser sniffs it
// (measureadv.com's sync frame): HTML is HTML, compressed or not, and the
// response still has no Content-Type; anything else is left alone.
func TestSniffedHTML(t *testing.T) {
	doc := func(dest string, body []byte, enc string) *http.Response {
		r := mkResp(enc, body)
		r.Request = &http.Request{Header: http.Header{"Sec-Fetch-Dest": {dest}}}
		return r
	}
	page := `<html><body><img src="https://a.example/x.png"></body></html>`
	if r := doc("iframe", gzipBytes(t, page), "gzip"); !sniffedHTML(r) {
		t.Error("gzipped untyped iframe document not sniffed as HTML")
	} else if b, _ := io.ReadAll(r.Body); string(b) != page || r.Header.Get("Content-Type") != "" {
		t.Errorf("body %q, type %q", b, r.Header.Get("Content-Type"))
	}
	if sniffedHTML(doc("document", []byte("just text"), "")) {
		t.Error("text sniffed as HTML")
	}
	// Only a document whose type Chromium does not take is sniffed at all
	// (responseKind asks).
	asked := false
	sniff := func() sniffResult { asked = true; return sniffResult{HTML: true} }
	if responseKind("", "script", true, "", false, sniff); asked {
		t.Error("a script fetch sniffed as a document")
	}
	if k := responseKind("", "document", true, "text/plain", true, sniff); asked || k != kindAsIs {
		t.Error("a typed response sniffed")
	}
}

// A body the proxy changes keeps its original sizes for scripts: encoded
// and decoded, in a Server-Timing metric beside the origin's own.
func TestOriginalSizesNoted(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	_, _ = gz.Write([]byte(strings.Repeat("hello ", 100)))
	_ = gz.Close()
	encoded := buf.Len()
	resp := &http.Response{
		Header: http.Header{"Content-Encoding": {"gzip"}, "Server-Timing": {"origin;dur=1"}},
		Body:   io.NopCloser(bytes.NewReader(buf.Bytes())),
	}
	body, err := readDecompressedBody(resp)
	if err != nil || len(body) != 600 {
		t.Fatalf("%d %v", len(body), err)
	}
	want := fmt.Sprintf(`crnb;desc="%d-600"`, encoded)
	got := resp.Header.Values("Server-Timing")
	if len(got) != 2 || got[0] != "origin;dur=1" || got[1] != want {
		t.Fatalf("Server-Timing = %q, want the origin's and %q", got, want)
	}
	// Read again (a sniffed document is read to look at it, then rewritten):
	// the first note stands.
	replaceBody(resp, body)
	if _, err := readDecompressedBody(resp); err != nil {
		t.Fatal(err)
	}
	if got := resp.Header.Values("Server-Timing"); len(got) != 2 || got[1] != want {
		t.Fatalf("after a second read: %q", got)
	}
}

// A gzip or deflate body that ends early is read as far as it inflated, as
// Chromium reads it (hulu.com: a sync-flushed gzip script with no trailer
// got a 502 proxied and ran direct).
func TestReadDecompressedBody_Truncated(t *testing.T) {
	text := strings.Repeat("window.ok = 1; ", 400)
	var full bytes.Buffer
	gz := gzip.NewWriter(&full)
	_, _ = gz.Write([]byte(text))
	_ = gz.Close()
	var flushed bytes.Buffer
	gf := gzip.NewWriter(&flushed)
	_, _ = gf.Write([]byte(text))
	_ = gf.Flush() // a sync flush, then nothing: no final block, no trailer
	var zl bytes.Buffer
	zw := zlib.NewWriter(&zl)
	_, _ = zw.Write([]byte(text))
	_ = zw.Close()
	var raw bytes.Buffer
	fw, _ := flate.NewWriter(&raw, flate.DefaultCompression)
	_, _ = fw.Write([]byte(text))
	_ = fw.Close()
	for _, c := range []struct {
		name, enc string
		body      []byte
		whole     bool
	}{
		{"gzip", "gzip", full.Bytes(), true},
		{"gzip sync-flushed, no trailer", "gzip", flushed.Bytes(), true},
		{"gzip without its trailer", "gzip", full.Bytes()[:full.Len()-8], true},
		{"gzip cut mid-block", "gzip", full.Bytes()[:full.Len()/2], false},
		{"deflate (zlib)", "deflate", zl.Bytes(), true},
		{"deflate (raw)", "deflate", raw.Bytes(), true},
		{"deflate (zlib) without its checksum", "deflate", zl.Bytes()[:zl.Len()-4], true},
	} {
		resp := &http.Response{Header: http.Header{"Content-Encoding": {c.enc}}, Body: io.NopCloser(bytes.NewReader(c.body))}
		got, err := readDecompressedBody(resp)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if c.whole && string(got) != text || !c.whole && !strings.HasPrefix(text, string(got)) {
			t.Errorf("%s: read %d bytes, not the text (%d)", c.name, len(got), len(text))
		}
		if resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("%s: Content-Encoding left on the decoded body", c.name)
		}
	}
}

// An empty body labelled with an encoding is empty (southern.edu: an empty
// gzip-labelled answer got a 502 — a gzip reader fails on no header).
func TestReadDecompressedBody_EmptyEncoded(t *testing.T) {
	for _, enc := range []string{"gzip", "deflate", "br", "zstd"} {
		resp := &http.Response{Header: http.Header{"Content-Encoding": {enc}}, Body: io.NopCloser(strings.NewReader(""))}
		body, err := readDecompressedBody(resp)
		if err != nil || len(body) != 0 {
			t.Errorf("%s, empty: %q, %v; want an empty body", enc, body, err)
		}
	}
}
