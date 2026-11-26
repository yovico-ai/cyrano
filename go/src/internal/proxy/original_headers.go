package proxy

import (
	"net/http"
	"sort"
	"strings"
)

// OriginalHeadersName is the response header that carries, for scripts,
// the origin's value of every header the proxy changed: a JSON object from
// lowercase header name to its values as the origin sent them (null: the
// origin sent no such header — the proxy added it).
//
// The browser acts on the headers as changed (a translated CSP, a
// neutralized Alt-Svc, the rewritten body's Content-Length); a script
// reading the response through fetch or XHR is shown the origin's
// (ts/client/src/patches/response-headers.ts), and never this header.
// The same idea as the originals attribute for markup.
const OriginalHeadersName = "Crn-H"

// StatusTextName is the Crn-H entry of an HTTP/1.x origin's reason phrase.
const StatusTextName = ":status-text"

// statusPhrase is the reason phrase of an HTTP/1.x response ("" for HTTP/2
// and /3, which have none — nor directly).
func statusPhrase(resp *http.Response) string {
	if resp == nil || resp.ProtoMajor != 1 {
		return ""
	}
	if i := strings.IndexByte(resp.Status, ' '); i >= 0 {
		return strings.TrimSpace(resp.Status[i+1:])
	}
	return ""
}

// notScriptVisible are headers no script can read from a response, or that
// belong to the hop, not the response.
var notScriptVisible = map[string]bool{
	"Set-Cookie": true, "Set-Cookie2": true,
	"Connection": true, "Keep-Alive": true, "Transfer-Encoding": true, "Upgrade": true,
	"Proxy-Authenticate": true, "Proxy-Connection": true, "Te": true, "Trailer": true,
}

// carryOriginalHeaders compares the headers about to go to the browser with
// those the origin sent, and records the origin's wherever they differ.
func carryOriginalHeaders(now, sent http.Header, phrase string) {
	orig := map[string][]string{}
	// The origin's reason phrase (spec/Carry.agda statusText), under a
	// name no header can have.
	if phrase != "" {
		orig[StatusTextName] = []string{phrase}
	}
	for name, was := range sent {
		if notScriptVisible[name] || name == OriginalHeadersName {
			continue
		}
		if !sameValues(now.Values(name), was) {
			orig[strings.ToLower(name)] = was
		}
	}
	for name := range now {
		if notScriptVisible[name] || name == OriginalHeadersName {
			continue
		}
		if _, had := sent[name]; !had {
			orig[strings.ToLower(name)] = nil
		}
	}
	now.Del(OriginalHeadersName)
	if len(orig) == 0 {
		return
	}
	now.Set(OriginalHeadersName, CrnHValue(orig))
}

// CrnHValue writes the Crn-H object (spec/Carry.agda crnH): names in
// ascending order, null for a header the origin did not send, each value
// byte for byte — a script reads a header natively one character per
// byte, and json.Marshal turned invalid UTF-8 into U+FFFD.
func CrnHValue(orig map[string][]string) string {
	names := make([]string, 0, len(orig))
	for n := range orig {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteByte('{')
	for i, n := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		writeJSONBytes(&b, n)
		b.WriteByte(':')
		vs := orig[n]
		if vs == nil {
			b.WriteString("null")
			continue
		}
		b.WriteByte('[')
		for j, v := range vs {
			if j > 0 {
				b.WriteByte(',')
			}
			writeJSONBytes(&b, v)
		}
		b.WriteByte(']')
	}
	b.WriteByte('}')
	return b.String()
}

// writeJSONBytes writes v's bytes as a JSON string (spec jsonBytes): every
// byte outside printable ASCII, and " and \, escaped as \u00XX.
func writeJSONBytes(b *strings.Builder, v string) {
	const hex = "0123456789abcdef"
	b.WriteByte('"')
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c == '"':
			b.WriteString(`\"`)
		case c == '\\':
			b.WriteString(`\\`)
		case c < 0x20 || c > 0x7e:
			b.WriteString(`\u00`)
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
}

func sameValues(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type sentHeadersKey struct{}

// SentHeaders: the headers the origin sent with resp, before the proxy
// changed any (what Crn-H will carry where they differ); nil when unknown.
func SentHeaders(resp *http.Response) http.Header {
	if resp == nil || resp.Request == nil {
		return nil
	}
	h, _ := resp.Request.Context().Value(sentHeadersKey{}).(http.Header)
	return h
}
