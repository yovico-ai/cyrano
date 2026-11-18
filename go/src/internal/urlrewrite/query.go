package urlrewrite

import (
	"net/url"
	"strings"
)

// WSOriginParam carries, on a proxied WebSocket URL, the origin of the
// page that opened it: a handshake has no Referer, so the server cannot
// otherwise know which Origin a direct browser would send. The client
// appends it last ("&name=…" after a query, "?name=…" without one —
// ts/client/src/patches/websocket.ts); the server strips it.
const WSOriginParam = "__cyrano_ws_origin"

// SplitWSOrigin removes the WSOriginParam the client appended to rawQuery
// and returns the rest exactly as the page wrote it, the origin it named
// ("" when absent or not an http(s) origin), and whether the page's URL
// had a query at all.
func SplitWSOrigin(rawQuery string) (rest, origin string, hadQuery bool) {
	i := strings.LastIndex(rawQuery, WSOriginParam+"=")
	if i < 0 || (i > 0 && rawQuery[i-1] != '&') || strings.ContainsAny(rawQuery[i:], "&") {
		return rawQuery, "", true
	}
	v, err := url.QueryUnescape(rawQuery[i+len(WSOriginParam)+1:])
	if err == nil {
		if a, res := parseRef(nil, v); res == parsedURL && (a.scheme == "http" || a.scheme == "https") {
			origin = a.originText()
		}
	}
	if i == 0 {
		return "", origin, false
	}
	return rawQuery[:i-1], origin, true
}

// UnproxyQueryValues replaces each query value that is a proxified URL on
// the proxy with the original URL it stands for (percent-encoded as a query
// value), leaving every other byte of rawQuery as it is.
func UnproxyQueryValues(rawQuery string, cfg ProxyConfig) string {
	if rawQuery == "" || cfg.PublicURL == nil || !strings.Contains(rawQuery, "cyrano") {
		return rawQuery
	}
	parts := strings.Split(rawQuery, "&")
	changed := false
	for i, part := range parts {
		name, value, has := strings.Cut(part, "=")
		if !has {
			continue
		}
		dec, err := url.QueryUnescape(value)
		if err != nil {
			continue
		}
		if orig := Unwrap(dec, cfg); orig != dec {
			parts[i] = name + "=" + url.QueryEscape(orig)
			changed = true
		}
	}
	if !changed {
		return rawQuery
	}
	return strings.Join(parts, "&")
}

// IsURLLikeSpecifier reports whether a module specifier names a URL (HTML,
// "resolve a module specifier"): it starts with "/", "./" or "../", or it
// parses as an absolute URL (has a scheme). Anything else is a bare
// specifier ("react"), resolved by the page's import map or a TypeError —
// never a URL relative to the page, so cyrano must leave it as written.
func IsURLLikeSpecifier(s string) bool {
	if strings.HasPrefix(s, "/") || strings.HasPrefix(s, "./") || strings.HasPrefix(s, "../") {
		return true
	}
	_, _, ok := schemeSplit([]rune(s))
	return ok
}
