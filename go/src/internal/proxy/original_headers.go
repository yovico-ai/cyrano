package proxy

import (
	"encoding/json"
	"net/http"
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

// notScriptVisible are headers no script can read from a response, or that
// belong to the hop, not the response.
var notScriptVisible = map[string]bool{
	"Set-Cookie": true, "Set-Cookie2": true,
	"Connection": true, "Keep-Alive": true, "Transfer-Encoding": true, "Upgrade": true,
	"Proxy-Authenticate": true, "Proxy-Connection": true, "Te": true, "Trailer": true,
}

// carryOriginalHeaders compares the headers about to go to the browser with
// those the origin sent, and records the origin's wherever they differ.
func carryOriginalHeaders(now, sent http.Header) {
	orig := map[string][]string{}
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
	if b, err := json.Marshal(orig); err == nil {
		now.Set(OriginalHeadersName, string(b))
	}
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
