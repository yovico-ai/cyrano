package urlrewrite

import (
	"net/url"
	"strings"
)

// RewriteLinkHeader rewrites the target of every link-value in a Link
// header (RFC 8288: `<uri>; param, <uri>; param`), so a preload,
// modulepreload or prefetch hint is fetched through the proxy like the
// resource it announces. Everything else is left as written.
func RewriteLinkHeader(v string, base *url.URL, cfg ProxyConfig) string {
	var b strings.Builder
	inQuotes := false
	atValueStart := true // only a '<' that starts a link-value opens a target
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case inQuotes:
			if c == '\\' && i+1 < len(v) {
				b.WriteByte(c)
				i++
				c = v[i]
			} else if c == '"' {
				inQuotes = false
			}
		case c == '"':
			inQuotes = true
		case c == ',':
			atValueStart = true
			b.WriteByte(c)
			continue
		case c == '<' && atValueStart:
			if end := strings.IndexByte(v[i:], '>'); end > 0 {
				b.WriteByte('<')
				b.WriteString(Rewrite(v[i+1:i+end], base, cfg))
				b.WriteByte('>')
				i += end
				atValueStart = false
				continue
			}
		}
		if c != ' ' && c != '\t' {
			atValueStart = false
		}
		b.WriteByte(c)
	}
	return b.String()
}

// RewriteRefresh rewrites the URL of a Refresh header or a
// <meta http-equiv=refresh content=…> value (HTML, "shared declarative
// refresh steps": `<time>[;|,] [url=]['|"]<url>`), so the refresh navigates
// through the proxy. A value with no URL (a plain reload) is unchanged.
func RewriteRefresh(v string, base *url.URL, cfg ProxyConfig) string {
	isWS := func(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r' }
	i := 0
	for i < len(v) && isWS(v[i]) {
		i++
	}
	for i < len(v) && ((v[i] >= '0' && v[i] <= '9') || v[i] == '.') {
		i++
	}
	if i >= len(v) || !(v[i] == ';' || v[i] == ',' || isWS(v[i])) {
		return v
	}
	for i < len(v) && isWS(v[i]) {
		i++
	}
	if i < len(v) && (v[i] == ';' || v[i] == ',') {
		i++
	}
	for i < len(v) && isWS(v[i]) {
		i++
	}
	if i >= len(v) {
		return v
	}
	// Optional "url" *WS "=" *WS.
	j := i
	if len(v)-j >= 3 && strings.EqualFold(v[j:j+3], "url") {
		k := j + 3
		for k < len(v) && isWS(v[k]) {
			k++
		}
		if k < len(v) && v[k] == '=' {
			k++
			for k < len(v) && isWS(v[k]) {
				k++
			}
			j = k
		}
	}
	start, end := j, len(v)
	if j < len(v) && (v[j] == '\'' || v[j] == '"') {
		start = j + 1
		if q := strings.IndexByte(v[start:], v[j]); q >= 0 {
			end = start + q
		}
	}
	if start >= end {
		return v
	}
	return v[:start] + Rewrite(v[start:end], base, cfg) + v[end:]
}
