package proxy

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

func TestBrowserEncoding(t *testing.T) {
	for in, want := range map[string]string{
		"gzip, deflate, br, zstd": "zstd",
		"gzip, deflate, br":       "br",
		"gzip, deflate":           "gzip",
		"GZIP":                    "gzip",
		"zstd;q=0, br;q=0.5":      "br",
		"zstd; Q=0.0 , gzip":      "gzip",
		"deflate":                 "",
		"identity":                "",
		"":                        "",
		"gzip;q=0":                "",
	} {
		if got := browserEncoding(in); got != want {
			t.Errorf("browserEncoding(%q) = %q, want %q", in, got, want)
		}
	}
}

func decode(t *testing.T, coding string, b []byte) string {
	t.Helper()
	var r io.Reader
	switch coding {
	case "zstd":
		d, err := zstd.NewReader(bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		defer d.Close()
		r = d
	case "br":
		r = brotli.NewReader(bytes.NewReader(b))
	case "gzip":
		g, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		r = g
	default:
		t.Fatalf("coding %q", coding)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// A rewritten body goes out in a coding the browser accepts, and decodes
// to what the rewriter produced; anything else is left as it is.
func TestCompressForBrowser(t *testing.T) {
	text := strings.Repeat("<p>the rewritten document</p>\n", 200)
	mk := func(accept string, body io.ReadCloser, hdr map[string]string) *http.Response {
		req, _ := http.NewRequest("GET", "https://site.example/", nil)
		req = req.WithContext(context.WithValue(req.Context(), browserEncodingsKey{}, accept))
		resp := &http.Response{Header: http.Header{}, Body: body, Request: req}
		for k, v := range hdr {
			resp.Header.Set(k, v)
		}
		return resp
	}
	for _, accept := range []string{"gzip, deflate, br, zstd", "gzip, deflate, br", "gzip"} {
		resp := mk(accept, RewrittenBody([]byte(text)), nil)
		compressForBrowser(resp)
		coding := resp.Header.Get("Content-Encoding")
		if coding != browserEncoding(accept) {
			t.Fatalf("%s: Content-Encoding %q", accept, coding)
		}
		b, _ := io.ReadAll(resp.Body)
		if int64(len(b)) != resp.ContentLength || resp.Header.Get("Content-Length") == "" || len(b) >= len(text) {
			t.Errorf("%s: %d bytes, ContentLength %d, header %q", accept, len(b), resp.ContentLength, resp.Header.Get("Content-Length"))
		}
		if got := decode(t, coding, b); got != text {
			t.Errorf("%s: decodes to %d bytes, want %d", accept, len(got), len(text))
		}
	}
	untouched := map[string]*http.Response{
		"the browser accepts none":   mk("", RewrittenBody([]byte(text)), nil),
		"a body no rewriter made":    mk("gzip", io.NopCloser(strings.NewReader(text)), nil),
		"a small body":               mk("gzip", RewrittenBody([]byte("<p>short</p>")), nil),
		"a body already encoded":     mk("gzip", RewrittenBody([]byte(text)), map[string]string{"Content-Encoding": "br"}),
		"a part of a representation": mk("gzip", RewrittenBody([]byte(text)), map[string]string{"Content-Range": "bytes 0-5999/9000"}),
	}
	for name, resp := range untouched {
		before := resp.Header.Get("Content-Encoding")
		compressForBrowser(resp)
		b, _ := io.ReadAll(resp.Body)
		if resp.Header.Get("Content-Encoding") != before || (string(b) != text && string(b) != "<p>short</p>") {
			t.Errorf("%s: was changed (Content-Encoding %q, %d bytes)", name, resp.Header.Get("Content-Encoding"), len(b))
		}
	}
}
