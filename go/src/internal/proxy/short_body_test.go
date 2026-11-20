package proxy

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"pgregory.net/rapid"

	"github.com/yovico/cyrano/internal/specoracle"
)

// A body that ends early, as an HTTP/2 stream ending before its
// Content-Length does reads to Go.
type shortReader struct {
	r   io.Reader
	err error
}

func (s *shortReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if err == io.EOF {
		return n, s.err
	}
	return n, err
}

func shortResp(proto int, declared int64, body string, end error) *http.Response {
	h := http.Header{}
	h.Set("Content-Length", strconv.FormatInt(declared, 10))
	return &http.Response{ProtoMajor: proto, ContentLength: declared, Header: h,
		Body: io.NopCloser(&shortReader{strings.NewReader(body), end})}
}

// Akamai's 403 on api.nike.com: "Content-Length: 2" and no DATA, over
// HTTP/2. Chrome takes the empty body; through the proxy's HTTP/1.1 the
// browser failed it (ERR_CONTENT_LENGTH_MISMATCH).
func TestFitShortBody(t *testing.T) {
	r := shortResp(2, 2, "", io.ErrUnexpectedEOF)
	if err := fitShortBody(r); err != nil {
		t.Fatal(err)
	}
	if b, _ := io.ReadAll(r.Body); len(b) != 0 || r.ContentLength != 0 || r.Header.Get("Content-Length") != "0" {
		t.Errorf("short h2: body %q, length %d / %q", b, r.ContentLength, r.Header.Get("Content-Length"))
	}
	r = shortResp(2, 5, "hello", io.EOF)
	if err := fitShortBody(r); err != nil {
		t.Fatal(err)
	}
	if b, _ := io.ReadAll(r.Body); string(b) != "hello" || r.Header.Get("Content-Length") != "5" {
		t.Errorf("whole h2: body %q, length %q", b, r.Header.Get("Content-Length"))
	}
	// Over HTTP/1.1 a short body is a cut connection: left to fail.
	r = shortResp(1, 2, "", io.ErrUnexpectedEOF)
	if err := fitShortBody(r); err != nil || r.Header.Get("Content-Length") != "2" {
		t.Errorf("h1: %v, length %q", err, r.Header.Get("Content-Length"))
	}
	// A stream reset is a broken response.
	reset := errors.New("stream error: INTERNAL_ERROR")
	if err := fitShortBody(shortResp(2, 4, "ab", reset)); !errors.Is(err, reset) {
		t.Errorf("reset: %v", err)
	}
}

func TestSpecConformance_FramedLength(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		h2 := rapid.Bool().Draw(rt, "h2")
		declared := rapid.Int64Range(0, 70000).Draw(rt, "declared")
		came := rapid.Int64Range(0, 70000).Draw(rt, "came")
		p := "h1"
		if h2 {
			p = "h2"
		}
		want, _, err := oracle.Ask("framedlength", p, strconv.FormatInt(declared, 10), strconv.FormatInt(came, 10))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := strconv.FormatInt(framedLength(h2, declared, came), 10); got != want {
			rt.Fatalf("framedLength(%v, %d, %d) = %s, spec %s", h2, declared, came, got, want)
		}
	})
}
