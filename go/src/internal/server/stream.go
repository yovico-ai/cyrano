package server

// A document rewritten as it arrives (htmlrewrite/streaming.go). The proxy
// read the whole body, rewrote it and only then sent the first byte: the
// browser parsed nothing — fetched no stylesheet, painted nothing — until
// the origin's last byte (bbc.com's first byte 1.2 s after direct's,
// theguardian.com 0.9 s, ikea.com 1.2 s). Now the body is decoded, rewritten
// and sent as it comes; what the rewriter needs first is only what it
// needs before the body's first byte (htmlConfig) and, for a document
// whose Content-Type names no charset, what of its head declares one.
//
// Not streamed: a frame's document (below); a challenge (by host, or Cloudflare's Cf-Mitigated) — its
// scripts compare the sizes of its own frame (crnb, exact in the header
// only for a body read whole); a document sniffed as HTML (its type says
// nothing: its first bytes were read already); a range; XML (a document
// that does not read is given as sent: known only at its end).
// CYRANO_STREAM=0 turns streaming off.
//
// The sizes the origin sent (crnb) are known only at the body's end: the
// header carries a token (spec/Carry.agda crnbRef), and the sizes go to
// the runtime in the session's next response (proxy.QueueStreamedSizes).

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
	"golang.org/x/text/encoding"
	"golang.org/x/text/transform"

	"github.com/yovico/cyrano/internal/htmlrewrite"
	"github.com/yovico/cyrano/internal/proxy"
)

const (
	// streamStall: how long the origin may keep the proxy waiting before
	// what is rewritten so far goes to the browser.
	streamStall = 5 * time.Millisecond
	// streamChunk: the most rewritten bytes held back.
	streamChunk = 32 << 10
)

// streamable says whether a document is rewritten as it arrives.
func streamable(resp *http.Response, target *url.URL) bool {
	if os.Getenv("CYRANO_STREAM") == "0" || resp.Request == nil {
		return false
	}
	if mimeEssence(resp.Header.Get("Content-Type")) != "text/html" {
		return false // sniffed, or another type taken as HTML
	}
	if isChallengeHost(target.Hostname()) || resp.Header.Get("Cf-Mitigated") != "" || resp.Header.Get("Content-Range") != "" {
		return false
	}
	// A top-level document only: its sizes go to the runtime as a cookie
	// of the channel, one a navigation (proxy.QueueStreamedSizes); a page's
	// tens of ad frames, each a cookie, would crowd the proxy origin's jar
	// (Chrome's 180) where the channel's own entries live. A frame's
	// document is buffered, its sizes exact in its header.
	return strings.EqualFold(resp.Request.Header.Get("Sec-Fetch-Dest"), "document")
}

type streamHooks struct {
	logger      *slog.Logger
	onChallenge func() // the body turned out to be a challenge page
}

// streamDocument gives resp a body rewritten as the upstream one arrives.
func streamDocument(resp *http.Response, target *url.URL, cfg htmlrewrite.Config, h streamHooks) error {
	upstream := resp.Body
	raw := &countingReader{r: upstream}
	dec, err := decodedStream(resp, raw)
	if err != nil {
		upstream.Close()
		return fmt.Errorf("read upstream body: %w", err)
	}
	decoded := &countingReader{r: dec}
	ct := resp.Header.Get("Content-Type")
	head, err := encodingPrefix(decoded, ct)
	if err != nil {
		upstream.Close()
		return fmt.Errorf("read upstream body: %w", err)
	}
	enc, encName := declaredEncoding(head, ct)
	var src io.Reader = io.MultiReader(bytes.NewReader(head), decoded)
	if enc != nil {
		src = transform.NewReader(src, enc.NewDecoder())
		cfg.QueryEncoder = queryEncoderOf(enc)
	}
	// (as the buffered path: a declared encoding in the Content-Type too)
	if encName != "" {
		if mt, params, err := mime.ParseMediaType(ct); err == nil && params["charset"] == "" {
			params["charset"] = encName
			resp.Header.Set("Content-Type", mime.FormatMediaType(mt, params))
		}
	}
	src = &challengeScan{r: src, on: h.onChallenge}

	sess, _ := resp.Request.Context().Value(proxy.SessionContextKey{}).(string)
	token := addSizesRef(resp)
	pr, pw := io.Pipe()
	resp.Body = proxy.StreamedBody(pr)
	resp.ContentLength = -1
	resp.Header.Del("Content-Length")
	resp.Header.Del("Transfer-Encoding")
	go func() {
		defer upstream.Close()
		var w io.Writer = pw
		var ew io.WriteCloser
		if enc != nil {
			ew = transform.NewWriter(pw, encoding.HTMLEscapeUnsupported(enc.NewEncoder()))
			w = ew
		}
		cfg.Stream = &htmlrewrite.Streaming{Stall: streamStall, Chunk: streamChunk}
		err := htmlrewrite.Rewrite(w, src, cfg)
		if err == nil && token != "" {
			proxy.QueueStreamedSizes(sess, token, raw.n, decoded.n)
		}
		if err == nil && ew != nil {
			err = ew.Close()
		}
		if err != nil && h.logger != nil {
			h.logger.Warn("rewriter: streamed html rewrite failed", "target", target.String(), "err", err)
		}
		// An error cuts the document short (never the rest unrewritten).
		pw.CloseWithError(err)
	}()
	return nil
}

// decodedStream is the body decoded as it arrives (readDecoded's codings,
// as leniently: a body that ends early or fails its checksum is read as
// far as it inflated).
func decodedStream(resp *http.Response, rawIn io.Reader) (io.Reader, error) {
	raw := bufio.NewReader(rawIn)
	if _, err := raw.Peek(1); err == io.EOF {
		resp.Header.Del("Content-Encoding")
		return bytes.NewReader(nil), nil
	}
	var r io.Reader
	switch strings.ToLower(resp.Header.Get("Content-Encoding")) {
	case "gzip":
		gz, err := gzip.NewReader(raw)
		if err != nil {
			return nil, err
		}
		r = gz
	case "deflate":
		if h, _ := raw.Peek(2); len(h) == 2 && h[0]&0x0f == 8 && (uint16(h[0])<<8|uint16(h[1]))%31 == 0 {
			zr, err := zlib.NewReader(raw)
			if err != nil {
				return nil, err
			}
			r = zr
		} else {
			r = flate.NewReader(raw)
		}
	case "br":
		r = brotli.NewReader(raw)
	case "zstd":
		zr, err := zstd.NewReader(raw)
		if err != nil {
			return nil, err
		}
		r = &zstdEnding{d: zr}
	default:
		return raw, nil
	}
	resp.Header.Del("Content-Encoding")
	return lenientReader{r}, nil
}

// lenientReader ends where a truncated or mis-summed body stops inflating
// (lenientInflate).
type lenientReader struct{ r io.Reader }

func (l lenientReader) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	if err != nil && (errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, gzip.ErrChecksum) || errors.Is(err, zlib.ErrChecksum)) {
		err = io.EOF
	}
	return n, err
}

// zstdEnding releases the decoder at the end, and stays at the end: a
// read after it is EOF again, not the closed decoder's error (which cut
// 15 documents short: "decoder used after Close").
type zstdEnding struct {
	d    *zstd.Decoder
	done error
}

func (z *zstdEnding) Read(p []byte) (int, error) {
	if z.done != nil {
		return 0, z.done
	}
	n, err := z.d.Read(p)
	if err != nil {
		z.done = err
		z.d.Close()
	}
	return n, err
}

// encodingPrefix reads what declaredEncoding needs of the body: the first
// bytes (a byte order mark) when the Content-Type names a charset, else up
// to what declares one, <body>, 64 KiB, or the end.
func encodingPrefix(r io.Reader, contentType string) ([]byte, error) {
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		if len(buf) >= 3 {
			// Up to the last complete tag: a half-read <meta> decides nothing.
			upto := buf
			if i := bytes.LastIndexByte(buf, '>'); i >= 0 {
				upto = buf[:i+1]
			} else {
				upto = nil
			}
			if _, _, decided := declaredEncodingIn(upto, contentType); decided || len(buf) >= 64<<10 {
				return buf, nil
			}
		}
		n, err := r.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err == io.EOF {
			return buf, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

// challengeScan calls on once when the text read through it shows a
// challenge page (isChallengeHTML), across reads.
type challengeScan struct {
	r    io.Reader
	on   func()
	tail []byte
	seen bool
}

func (c *challengeScan) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if !c.seen && n > 0 && c.on != nil {
		window := append(c.tail, p[:n]...)
		if isChallengeHTML(window) {
			c.seen = true
			c.on()
		}
		if len(window) > 64 {
			window = window[len(window)-64:]
		}
		c.tail = append(c.tail[:0], window...)
	}
	return n, err
}

// ── The sizes of streamed bodies ─────────────────────────────────────

// addSizesRef puts a token in the response's crnb metric (unless the
// origin sent a metric of that name itself) and returns it ("" then).
func addSizesRef(resp *http.Response) string {
	for _, v := range resp.Header.Values("Server-Timing") {
		if strings.HasPrefix(v, OriginalSizesMetric+";") || v == OriginalSizesMetric {
			return ""
		}
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	token := hex.EncodeToString(b[:])
	resp.Header.Add("Server-Timing", fmt.Sprintf(`%s;desc="@%s"`, OriginalSizesMetric, token))
	return token
}
