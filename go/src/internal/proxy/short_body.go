package proxy

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
)

// An HTTP/2 stream that ends with fewer body bytes than its
// Content-Length declared (Akamai's 403s on api.nike.com: "2", and no
// DATA) is the response it is to Chrome, the bytes that came; over the
// proxy's HTTP/1.1 the browser would fail it with
// ERR_CONTENT_LENGTH_MISMATCH. Such a body, when small, is read before
// the response is answered, and the browser is told the length that
// came; scripts still read the origin's Content-Length (Crn-H, recorded
// by modifyResponse). Over HTTP/1.1 a short body is a cut connection,
// which the browser fails natively too: left as it is (spec/Carry.agda
// framedLength).

// shortBodyLimit bounds what is read ahead: a larger body streams.
const shortBodyLimit = 64 << 10

// framedLength is the Content-Length the browser is told (spec framedLength).
func framedLength(http2 bool, declared, came int64) int64 {
	if http2 && came < declared {
		return came
	}
	return declared
}

// fitShortBody reads a small HTTP/2 body ahead and, when it came short,
// answers with what came. Any other failure reading it is returned: the
// origin's response is then broken, as natively.
func fitShortBody(resp *http.Response) error {
	if resp.ProtoMajor != 2 || resp.ContentLength <= 0 || resp.ContentLength > shortBodyLimit || resp.Body == nil {
		return nil
	}
	buf, err := io.ReadAll(io.LimitReader(resp.Body, resp.ContentLength))
	_ = resp.Body.Close()
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}
	n := framedLength(true, resp.ContentLength, int64(len(buf)))
	resp.Body = io.NopCloser(bytes.NewReader(buf))
	if n != resp.ContentLength {
		resp.ContentLength = n
		resp.Header.Set("Content-Length", strconv.FormatInt(n, 10))
	}
	return nil
}
