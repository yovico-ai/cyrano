package proxy

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

// A body the proxy rewrote goes to the browser compressed again. The
// rewriters work on the decoded text, and what they produce was sent as it
// stood: a 720 kB brotli document reached the browser as 7.9 MB (cnn.com).
// On a real link that is most of a page's load time.
//
// Only a body a rewriter replaced is compressed: anything else passes as
// the origin sent it, encoding and all, streamed. The page cannot tell:
// a script reads Content-Encoding and Content-Length as the origin sent
// them (Crn-H, original_headers.go), and a performance entry's sizes from
// the crnb metric (server/bodyrewriter.go OriginalSizesMetric).

// rewrittenBody is a response body a rewriter produced, whole.
type rewrittenBody struct {
	*bytes.Reader
	b []byte
}

func (rewrittenBody) Close() error { return nil }

// RewrittenBody wraps the bytes a rewriter produced as a response body.
func RewrittenBody(b []byte) io.ReadCloser {
	return rewrittenBody{Reader: bytes.NewReader(b), b: b}
}

type browserEncodingsKey struct{}

// withBrowserEncodings records the Accept-Encoding the browser itself sent.
func withBrowserEncodings(req *http.Request) *http.Request {
	return req.WithContext(context.WithValue(req.Context(), browserEncodingsKey{}, strings.Join(req.Header.Values("Accept-Encoding"), ",")))
}

// compressMin: below this a body is sent as it is (the frame costs more).
const compressMin = 1024

// browserEncoding is the coding to send a rewritten body in, of those the
// browser accepts (RFC 9110 §12.5.3: a coding with q=0 is refused): zstd
// before br before gzip — the cheapest to produce first. "" for none.
func browserEncoding(acceptEncoding string) string {
	accepted := map[string]bool{}
	for _, part := range strings.Split(acceptEncoding, ",") {
		name, params, _ := strings.Cut(part, ";")
		name = strings.ToLower(strings.TrimSpace(name))
		refused := false
		for _, p := range strings.Split(params, ";") {
			k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
			if strings.EqualFold(strings.TrimSpace(k), "q") {
				if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && q == 0 {
					refused = true
				}
			}
		}
		if name != "" && !refused {
			accepted[name] = true
		}
	}
	for _, c := range []string{"zstd", "br", "gzip"} {
		if accepted[c] {
			return c
		}
	}
	return ""
}

var zstdEncoder, _ = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault))

func encodeBody(coding string, body []byte) ([]byte, bool) {
	var out bytes.Buffer
	out.Grow(len(body) / 4)
	switch coding {
	case "zstd":
		return zstdEncoder.EncodeAll(body, make([]byte, 0, len(body)/4)), true
	case "br":
		w := brotli.NewWriterLevel(&out, 4)
		if _, err := w.Write(body); err != nil || w.Close() != nil {
			return nil, false
		}
	case "gzip":
		w, _ := gzip.NewWriterLevel(&out, gzip.BestSpeed)
		if _, err := w.Write(body); err != nil || w.Close() != nil {
			return nil, false
		}
	default:
		return nil, false
	}
	return out.Bytes(), true
}

// compressForBrowser encodes a rewritten body in a coding the browser
// accepts, when it has none and is worth it.
func compressForBrowser(resp *http.Response) {
	rb, ok := resp.Body.(rewrittenBody)
	if !ok || resp.Request == nil || len(rb.b) < compressMin || resp.Header.Get("Content-Encoding") != "" || resp.Header.Get("Content-Range") != "" {
		return
	}
	accept, _ := resp.Request.Context().Value(browserEncodingsKey{}).(string)
	coding := browserEncoding(accept)
	if coding == "" {
		return
	}
	enc, ok := encodeBody(coding, rb.b)
	if !ok || len(enc) >= len(rb.b) {
		return
	}
	resp.Body = io.NopCloser(bytes.NewReader(enc))
	resp.ContentLength = int64(len(enc))
	resp.Header.Set("Content-Length", strconv.Itoa(len(enc)))
	resp.Header.Set("Content-Encoding", coding)
}
