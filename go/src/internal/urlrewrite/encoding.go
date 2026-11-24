package urlrewrite

import (
	"strconv"
	"strings"
)

// QueryEncoder encodes one code point in a document's encoding; ok is false
// when the encoding cannot represent it (spec/Encoding.agda Encoder).
type QueryEncoder func(r rune) (b []byte, ok bool)

// Latin1 is the spec's model encoder (code points below 256 as one byte).
func Latin1(r rune) ([]byte, bool) {
	if r < 256 {
		return []byte{byte(r)}, true
	}
	return nil, false
}

// EncodeQuery is spec/Encoding.agda encodeQuery: a query, percent-encoded
// after encoding in enc (a code point enc cannot encode as "&#N;").
func EncodeQuery(enc QueryEncoder, special bool, q string) string {
	var b strings.Builder
	for _, r := range q {
		bs, ok := enc(r)
		if !ok {
			bs = []byte("&#" + strconv.Itoa(int(r)) + ";")
		}
		for _, c := range bs {
			if c < 33 || c == '"' || c == '#' || c == '<' || c == '>' || c >= 127 || special && c == '\'' {
				b.WriteString("%" + strings.ToUpper(strconv.FormatInt(int64(c)>>4, 16)) + strings.ToUpper(strconv.FormatInt(int64(c)&15, 16)))
			} else {
				b.WriteByte(c)
			}
		}
	}
	return b.String()
}

// rawQuery is an input URL's own query: after the first "?", before "#",
// tabs and newlines removed; ok false when it has none.
func rawQuery(input string) (string, bool) {
	s := strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(input)
	if i := strings.IndexByte(s, '#'); i >= 0 {
		s = s[:i]
	}
	i := strings.IndexByte(s, '?')
	if i < 0 {
		return "", false
	}
	return s[i+1:], true
}

// Requery gives a proxified URL (rewritten from input in a document whose
// encoding enc encodes) the query the browser would: the input's own query
// encoded in enc, when it holds a code point beyond ASCII (spec/Encoding.agda).
func Requery(proxified, input string, enc QueryEncoder) string {
	if enc == nil {
		return proxified
	}
	q, ok := rawQuery(input)
	if !ok || !nonASCII(q) {
		return proxified
	}
	i := strings.IndexByte(proxified, '?')
	if i < 0 {
		return proxified
	}
	end := len(proxified)
	if j := strings.IndexByte(proxified[i:], '#'); j >= 0 {
		end = i + j
	}
	special := true // the proxified URL is the proxy's: http(s)
	return proxified[:i+1] + EncodeQuery(enc, special, q) + proxified[end:]
}

func nonASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return true
		}
	}
	return false
}
