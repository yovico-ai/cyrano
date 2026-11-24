package urlrewrite

import "strings"

// ClearSiteDataTypes are the types a Clear-Site-Data value names, as
// Chromium reads it (spec/ClearSiteData.agda types): split on ",", each
// item trimmed of spaces and tabs, a quoted string's inside.
func ClearSiteDataTypes(v string) []string {
	var out []string
	for _, item := range strings.Split(v, ",") {
		t := strings.Trim(item, " \t")
		if len(t) >= 2 && t[0] == '"' && t[len(t)-1] == '"' {
			out = append(out, t[1:len(t)-1])
		}
	}
	return out
}

// ClearsCookies: the value, on a response from a potentially trustworthy
// URL, clears the cookies of its registrable domain (spec clearsCookies).
func ClearsCookies(trustworthy bool, v string) bool {
	if !trustworthy {
		return false
	}
	for _, t := range ClearSiteDataTypes(v) {
		if t == "cookies" || t == "*" {
			return true
		}
	}
	return false
}
