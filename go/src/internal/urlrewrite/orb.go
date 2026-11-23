package urlrewrite

import "strings"

// Opaque Response Blocking of a cross-origin script, as Chromium does it
// (spec/Orb.agda; checked against Chromium: ts/client tests/spec
// orb-vs-chromium). The proxy, under which every script is same-origin,
// fails a response Chromium would block (proxy/orb.go).

// TakenMime is the MIME type Chromium takes from a Content-Type value
// (spec/Disposition.agda takenMime): of each comma-separated item, HTTP
// whitespace skipped, up to ";" or whitespace, lowercased; the last with a
// "/" that is not */*.
func TakenMime(ct string) (string, bool) {
	m, ok := "", false
	for _, item := range strings.Split(ct, ",") {
		item = strings.TrimLeft(item, " \t\r\n")
		if i := strings.IndexAny(item, "; \t\r\n"); i >= 0 {
			item = item[:i]
		}
		item = lowerASCII(item)
		if strings.Contains(item, "/") && item != "*/*" {
			m, ok = item, true
		}
	}
	return m, ok
}

// OrbSniffWindow is how much of a body ORB sniffs.
const OrbSniffWindow = 1024

var orbNeverSniffed = map[string]bool{
	"application/gzip": true, "application/x-gzip": true, "application/zip": true, "application/x-zip-compressed": true,
	"application/pdf": true, "application/x-protobuf": true, "application/x-protobuffer": true,
	"application/msexcel": true, "application/mspowerpoint": true, "application/msword": true, "application/msword-template": true,
	"application/vnd.ms-excel": true, "application/vnd.ms-powerpoint": true, "application/vnd.ms-word": true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   true,
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
	"multipart/byteranges": true, "multipart/signed": true, "text/event-stream": true, "text/csv": true,
}

var orbSafelisted = map[string]bool{
	"text/css": true, "text/vtt": true, "image/svg+xml": true, "application/dash+xml": true,
	"application/vnd.apple.mpegurl": true, "audio/mpegurl": true, "audio/x-mpegurl": true, "application/x-mpegurl": true,
}

// OrbBlocks reports whether Chromium blocks this response to a
// cross-origin no-cors script (spec Orb.blocks). hasCT: a Content-Type
// field was sent; body: at least its first OrbSniffWindow bytes.
func OrbBlocks(ct string, hasCT bool, body []byte) bool {
	if !hasCT {
		return false
	}
	m, ok := TakenMime(ct)
	if !ok {
		return false
	}
	if orbNeverSniffed[m] {
		return true
	}
	if orbSafelisted[m] || strings.HasPrefix(m, "image/") || strings.HasPrefix(m, "audio/") || strings.HasPrefix(m, "video/") {
		return false
	}
	if len(body) > OrbSniffWindow {
		body = body[:OrbSniffWindow]
	}
	return orbBreaker(body) || orbHTML(body) == sniffYes || orbXML(body) == sniffYes || orbJSON(body) == sniffYes
}

// ProxyOrbBlocks: the proxy fails the response (spec Orb.proxyBlocks) —
// cross-origin, not a redirect (the browser follows it; ORB judges where
// it ends), asked in no-cors mode (the page's own: a <script> without
// crossorigin), and ORB blocks it, whatever Access-Control-Allow-Origin it
// carries. A cors-mode one is the CORS check's (proxy/cors.go).
func ProxyOrbBlocks(crossOrigin, redirect bool, ct string, hasCT, noCors bool, body []byte) bool {
	return crossOrigin && !redirect && noCors && OrbBlocks(ct, hasCT, body)
}

type sniffResult int

const (
	sniffNo sniffResult = iota
	sniffYes
	sniffMaybe
)

func orbWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func orbSkipWS(b []byte) []byte {
	for len(b) > 0 && orbWS(b[0]) {
		b = b[1:]
	}
	return b
}

// orbPrefix: p (lower-case when ci) a prefix of b: yes; b ends inside p: maybe.
func orbPrefix(ci bool, p string, b []byte) sniffResult {
	for i := 0; i < len(p); i++ {
		if i >= len(b) {
			return sniffMaybe
		}
		c := b[i]
		if ci && 'A' <= c && c <= 'Z' {
			c += 32
		}
		if c != p[i] {
			return sniffNo
		}
	}
	return sniffYes
}

func orbAnyOf(ci bool, ps []string, b []byte) sniffResult {
	r := sniffNo
	for _, p := range ps {
		switch orbPrefix(ci, p, b) {
		case sniffYes:
			return sniffYes
		case sniffMaybe:
			r = sniffMaybe
		}
	}
	return r
}

var orbHTMLSignatures = []string{"<!doctype html", "<script", "<html", "<head", "<iframe", "<h1", "<div", "<font",
	"<table", "<a", "<style", "<title", "<b", "<body", "<br", "<p"}

func orbHTML(b []byte) sniffResult {
	for {
		b = orbSkipWS(b)
		if r := orbAnyOf(true, orbHTMLSignatures, b); r != sniffNo {
			return r
		}
		// A comment "<!--" … "-->" ended by CR or LF, then again.
		if orbPrefix(false, "<!--", b) != sniffYes {
			return sniffNo
		}
		rest := b[4:]
		next := -1
		for i := 0; i+3 < len(rest); i++ {
			if rest[i] == '-' && rest[i+1] == '-' && rest[i+2] == '>' {
				if rest[i+3] == '\n' || rest[i+3] == '\r' {
					next = i + 3
				}
				break
			}
		}
		if next < 0 {
			return sniffNo
		}
		b = rest[next:]
	}
}

func orbXML(b []byte) sniffResult { return orbPrefix(false, "<?xml", orbSkipWS(b)) }

// "{" ws string ws ":"
func orbJSON(b []byte) sniffResult {
	b = orbSkipWS(b)
	if len(b) == 0 {
		return sniffMaybe
	}
	if b[0] != '{' {
		return sniffNo
	}
	b = orbSkipWS(b[1:])
	if len(b) == 0 {
		return sniffMaybe
	}
	if b[0] != '"' {
		return sniffNo
	}
	b = b[1:]
	for {
		if len(b) == 0 {
			return sniffMaybe
		}
		switch b[0] {
		case '\\':
			if len(b) < 2 {
				return sniffMaybe
			}
			b = b[2:]
			continue
		case '"':
			b = orbSkipWS(b[1:])
			if len(b) == 0 {
				return sniffMaybe
			}
			if b[0] == ':' {
				return sniffYes
			}
			return sniffNo
		}
		b = b[1:]
	}
}

func orbBreaker(b []byte) bool {
	return orbAnyOf(false, []string{")]}'", "{}&&", "{} &&"}, b) == sniffYes
}
