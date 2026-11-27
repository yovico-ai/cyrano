package server

import (
	"bytes"
	"io"
	"net/http"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// A zstd body read to its end, and read again (the tokenizer and
// io.MultiReader do): EOF again, never the closed decoder's error.
func TestDecodedStream_ZstdStaysAtTheEnd(t *testing.T) {
	enc, _ := zstd.NewWriter(nil)
	body := enc.EncodeAll([]byte("<p>hello</p>"), nil)
	resp := &http.Response{Header: http.Header{"Content-Encoding": {"zstd"}}}
	r, err := decodedStream(resp, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(r)
	if err != nil || string(got) != "<p>hello</p>" {
		t.Fatalf("read %q, %v", got, err)
	}
	for i := 0; i < 3; i++ {
		if n, err := r.Read(make([]byte, 8)); n != 0 || err != io.EOF {
			t.Fatalf("read %d after the end: %d, %v; want 0, EOF", i, n, err)
		}
	}
}
