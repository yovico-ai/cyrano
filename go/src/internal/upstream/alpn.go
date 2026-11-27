package upstream

// Which protocol Chrome speaks to an https origin (spec/Alpn.agda): HTTP/3
// when the host's DNS HTTPS record lists "h3", or an unexpired Alt-Svc
// offer of the origin gives h3 for its own host and port; never while the
// origin is marked broken (a QUIC connection that could not be made). A
// direct Chrome opens Cloudflare zones over HTTP/3 on first contact; over
// HTTP/2 the same Chrome is challenged (codepen, napaonline, fivebelow,
// findagrave: 403 "Just a moment…"), and so was every proxied page there.

import (
	"strconv"
	"strings"
)

// AltSvcOffer is one Alt-Svc alternative: its protocol id, host ("" the
// origin's own, lower case), port and max age in seconds.
type AltSvcOffer struct {
	Proto  string
	Host   string
	Port   int
	MaxAge int
}

// altSvcDefaultMaxAge is RFC 7838's default ma.
const altSvcDefaultMaxAge = 86400

// brokenFor is how long an origin whose QUIC connection could not be made
// is spoken to over TCP (Chrome: 5 minutes; its doubling on a repeat is not
// done).
const brokenForSeconds = 5 * 60

func owsTrim(s string) string { return strings.Trim(s, " \t") }

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func decimal(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + int(s[i]-'0')
		if n > 1<<40 {
			return 0, false
		}
	}
	return n, true
}

// unquoted is a quoted string's content, a backslash taking the next byte.
func unquoted(s string) (string, bool) {
	if len(s) < 2 || s[0] != '"' {
		return "", false
	}
	var b strings.Builder
	for i := 1; i < len(s); i++ {
		switch c := s[i]; c {
		case '"':
			return b.String(), i == len(s)-1
		case '\\':
			if i+1 < len(s) {
				i++
				b.WriteByte(s[i])
			}
		default:
			b.WriteByte(c)
		}
	}
	return "", false
}

// splitAltSvcList splits on commas outside a quoted string.
func splitAltSvcList(v string) []string {
	var out []string
	quoted, start := false, 0
	for i := 0; i < len(v); i++ {
		switch v[i] {
		case '"':
			quoted = !quoted
		case ',':
			if !quoted {
				out = append(out, v[start:i])
				start = i + 1
			}
		}
	}
	return append(out, v[start:])
}

func altSvcMaxAge(params []string) int {
	for _, p := range params {
		k, v, ok := strings.Cut(owsTrim(p), "=")
		if ok && lowerASCII(owsTrim(k)) == "ma" {
			if n, ok := decimal(owsTrim(v)); ok {
				return n
			}
		}
	}
	return altSvcDefaultMaxAge
}

func altSvcAlternative(a string) (AltSvcOffer, bool) {
	parts := strings.Split(a, ";")
	pid, q, ok := strings.Cut(owsTrim(parts[0]), "=")
	if !ok {
		return AltSvcOffer{}, false
	}
	au, ok := unquoted(owsTrim(q))
	if !ok {
		return AltSvcOffer{}, false
	}
	i := strings.LastIndexByte(au, ':')
	if i < 0 {
		return AltSvcOffer{}, false
	}
	port, ok := decimal(au[i+1:])
	if !ok {
		return AltSvcOffer{}, false
	}
	return AltSvcOffer{Proto: owsTrim(pid), Host: lowerASCII(au[:i]), Port: port, MaxAge: altSvcMaxAge(parts[1:])}, true
}

// ReadAltSvc reads an Alt-Svc value: clear, or the offers that read (one
// that does not is skipped).
func ReadAltSvc(v string) (clear bool, offers []AltSvcOffer) {
	if lowerASCII(owsTrim(v)) == "clear" {
		return true, nil
	}
	for _, a := range splitAltSvcList(v) {
		if o, ok := altSvcAlternative(a); ok {
			offers = append(offers, o)
		}
	}
	return false, offers
}

func h3Here(host string, port int, offers []AltSvcOffer) bool {
	for _, o := range offers {
		if o.Proto == "h3" && (o.Host == "" || o.Host == lowerASCII(host)) && o.Port == port {
			return true
		}
	}
	return false
}

// UseH3 says whether a request to scheme://host:port goes over HTTP/3:
// rr is the host's HTTPS record alpn ids (nil: no record), offers its
// unexpired Alt-Svc offers (spec Alpn.protocol).
func UseH3(scheme, host string, port int, rr []string, offers []AltSvcOffer, broken bool) bool {
	if scheme != "https" || broken {
		return false
	}
	for _, id := range rr {
		if id == "h3" {
			return true
		}
	}
	return h3Here(host, port, offers)
}

func itoa(n int) string { return strconv.Itoa(n) }
