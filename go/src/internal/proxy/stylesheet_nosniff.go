package proxy

import (
	"net/http"
	"net/url"
	"strings"
)

// In a quirks-mode document Chromium applies a stylesheet of any type when
// it is same-origin (spec/Disposition.agda sheetApplies). Through the proxy
// every sheet is same-origin, so a cross-origin one served as text/plain
// would apply where directly it does not. Such a sheet gets
// X-Content-Type-Options: nosniff, which makes it apply exactly where it
// would directly, in either mode (Disposition.agda proxied-sheet; checked
// against Chromium: quirks-sheets-vs-chromium). Scripts never read a
// stylesheet's response; Crn-H records the header as the proxy's.
func addStylesheetNosniff(resp *http.Response) {
	req := resp.Request
	if req == nil || req.URL == nil || !strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "style") {
		return
	}
	from, _ := req.Context().Value(requesterKey{}).(string)
	fu, err := url.Parse(from)
	if from == "" || err != nil {
		return // no requesting page known: as the browser was sent it
	}
	same := strings.EqualFold(fu.Scheme, req.URL.Scheme) && strings.EqualFold(fu.Host, req.URL.Host)
	if stylesheetNosniff(same, resp.Header.Values("Content-Type"), hasNosniff(resp.Header)) {
		resp.Header.Set("X-Content-Type-Options", "nosniff")
	}
}

// stylesheetNosniff is Disposition.agda addNosniff: a cross-origin sheet
// without nosniff that is neither of type text/css nor untyped.
func stylesheetNosniff(sameOrigin bool, contentType []string, nosniff bool) bool {
	if sameOrigin || nosniff {
		return false
	}
	if len(contentType) == 0 {
		return false // untyped
	}
	e := sheetEssence(contentType[0])
	return e != "" && e != "text/css"
}

// sheetEssence is Disposition.agda essence: up to ";", HTTP whitespace
// trimmed, ASCII-lowercased.
func sheetEssence(ct string) string {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return lowerASCII(strings.Trim(ct, " \t\r\n"))
}

// hasNosniff is Disposition.agda nosniff (Fetch "determine nosniff"): the
// field lines combined, the first comma-separated value, trimmed, is
// "nosniff" (ASCII case aside).
func hasNosniff(h http.Header) bool {
	vs := h.Values("X-Content-Type-Options")
	if len(vs) == 0 {
		return false
	}
	first, _, _ := strings.Cut(strings.Join(vs, ","), ",")
	return lowerASCII(strings.Trim(first, " \t")) == "nosniff"
}
