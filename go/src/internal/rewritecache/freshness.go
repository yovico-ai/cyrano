package rewritecache

// How long a response stays fresh in the browser's cache, and what the
// browser is told of a rewritten one (spec/Freshness.agda; checked by
// TestSpecConformance_Freshness).

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Fresh is a response's freshness: not to be kept at all, or kept for
// Left (none left: revalidated at once), NoCache when every use is.
type Fresh struct {
	NoStore bool
	NoCache bool
	Left    time.Duration
}

type directive struct {
	name  string
	value string
	has   bool
}

// splitList splits at commas outside quotes (spec Alpn.splitList).
func splitList(s string) []string {
	var out []string
	q := false
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			q = !q
		case ',':
			if !q {
				out = append(out, s[start:i])
				start = i + 1
			}
		}
	}
	return append(out, s[start:])
}

func trimOWS(s string) string { return strings.Trim(s, " \t") }

// unquoted is a quoted string's content (spec Alpn.unquoted), ok false
// when it is not one.
func unquoted(s string) (string, bool) {
	if len(s) == 0 || s[0] != '"' {
		return "", false
	}
	var b strings.Builder
	for i := 1; i < len(s); i++ {
		switch c := s[i]; c {
		case '"':
			if i == len(s)-1 {
				return b.String(), true
			}
			return "", false
		case '\\':
			if i+1 >= len(s) {
				return "", false
			}
			i++
			b.WriteByte(s[i])
		default:
			b.WriteByte(c)
		}
	}
	return "", false
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func directives(cc string) []directive {
	var out []directive
	for _, part := range splitList(cc) {
		d := trimOWS(part)
		name, value, has := strings.Cut(d, "=")
		name = lowerASCII(trimOWS(name))
		if name == "" {
			continue
		}
		if has {
			v := trimOWS(value)
			if u, ok := unquoted(v); ok {
				v = u
			}
			value = v
		}
		out = append(out, directive{name, value, has})
	}
	return out
}

func digits(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + int64(s[i]-'0')
		if n > 1<<40 {
			n = 1 << 40 // (far beyond any cap)
		}
	}
	return n, true
}

// FreshnessOf is the spec's freshness: cc the Cache-Control, expires
// Expires − Date in seconds (-1: no Expires; an unreadable or past one is
// 0), sinceLM Date − Last-Modified (-1: none), ageHdr the Age header,
// sinceDate now − Date.
func FreshnessOf(cc string, expires, sinceLM, ageHdr, sinceDate int64) Fresh {
	ds := directives(cc)
	has := func(n string) bool {
		for _, d := range ds {
			if d.name == n {
				return true
			}
		}
		return false
	}
	if has("no-store") {
		return Fresh{NoStore: true}
	}
	if has("no-cache") {
		return Fresh{NoCache: true}
	}
	var life int64
	found := false
	for _, d := range ds {
		if d.name == "max-age" && d.has {
			if n, ok := digits(d.value); ok {
				life, found = n, true
				break
			}
		}
	}
	if !found {
		switch {
		case expires >= 0:
			life = expires
		case sinceLM >= 0:
			life = sinceLM / 10
		}
	}
	age := ageHdr
	if sinceDate > age {
		age = sinceDate
	}
	left := life - age
	if left < 0 {
		left = 0
	}
	return Fresh{Left: time.Duration(left) * time.Second}
}

// BrowserCC is the Cache-Control the browser is told of a rewritten body
// ("" when the origin's stands: no-store).
func BrowserCC(f Fresh, cap time.Duration) string {
	if f.NoStore {
		return ""
	}
	if f.NoCache {
		return "no-cache, max-age=0"
	}
	n := f.Left
	if n > cap {
		n = cap
	}
	return "max-age=" + strconv.FormatInt(int64(n/time.Second), 10)
}

// ResponseFreshness reads a response's freshness at now (dates as Go's
// http.ParseTime reads them: outside the spec's model).
func ResponseFreshness(h http.Header, now time.Time) Fresh {
	date, err := http.ParseTime(h.Get("Date"))
	if err != nil {
		date = now
	}
	expires := int64(-1)
	if v, ok := h["Expires"]; ok && len(v) > 0 {
		expires = 0
		if t, err := http.ParseTime(v[0]); err == nil && t.After(date) {
			expires = int64(t.Sub(date) / time.Second)
		}
	}
	sinceLM := int64(-1)
	if t, err := http.ParseTime(h.Get("Last-Modified")); err == nil && !t.After(date) {
		sinceLM = int64(date.Sub(t) / time.Second)
	}
	ageHdr, _ := digits(trimOWS(h.Get("Age")))
	sinceDate := int64(0)
	if now.After(date) {
		sinceDate = int64(now.Sub(date) / time.Second)
	}
	return FreshnessOf(strings.Join(h.Values("Cache-Control"), ", "), expires, sinceLM, ageHdr, sinceDate)
}
