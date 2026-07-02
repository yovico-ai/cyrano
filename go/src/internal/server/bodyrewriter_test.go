package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

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
