// Package sitehost is spec/SiteHost.agda: one proxy host per site.
//
// Every proxied site (a scheme and a registrable domain, Chromium's
// schemeful site) is served from <label>.<domain>, where the label is the
// first 26 characters of base32(SHA-256(site key)), lower case, no
// padding: a function of the site alone, so no table is shared between
// servers. The path still names the whole target (urlrewrite); the host
// only partitions — the browser keeps each site's cookies, storage,
// process and thread apart, as it does directly. A request is admitted
// only on its target site's host (Admits).
package sitehost

import (
	"crypto/sha256"
	"encoding/base32"
	"strings"
)

// LabelLength is the label's length in base32 characters (130 bits).
const LabelLength = 26

var enc = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// Key is spec siteKey: "<scheme>://<registrable domain>", the host itself
// when it has none (registrable == "": an IP address, a public suffix).
func Key(scheme, host, registrable string) string {
	if registrable == "" {
		return scheme + "://" + host
	}
	return scheme + "://" + registrable
}

// Label is spec siteLabel.
func Label(key string) string {
	sum := sha256.Sum256([]byte(key))
	return enc.EncodeToString(sum[:])[:LabelLength]
}

// Host is spec siteHost: the proxy host serving the site.
func Host(domain, key string) string { return Label(key) + "." + domain }

// LabelOf is spec labelOf: the one label before "."+domain, or "".
func LabelOf(domain, host string) string {
	i := strings.IndexByte(host, '.')
	if i <= 0 || host[i+1:] != domain {
		return ""
	}
	return host[:i]
}

// Admits is spec admits: whether host is the site's own.
func Admits(domain, host, key string) bool {
	l := LabelOf(domain, host)
	return l != "" && l == Label(key)
}

// MaxLabel is a DNS label's limit.
const MaxLabel = 63

var schemeLetter = map[string]byte{"http": 'h', "https": 's', "ws": 'w', "wss": 'x'}
var letterScheme = map[byte]string{'h': "http", 's': "https", 'w': "ws", 'x': "wss"}

// OriginLabel is spec/OriginLabel.agda originLabel: the origin as one DNS
// label — scheme letter, the host with "." as "-0" and "-" as "-1", and
// "-2<port>" when it has one — or "" when it has none (a host with another
// character, such as an IPv6 address, or a label past 63 characters).
func OriginLabel(scheme, host, port string) string {
	l, ok := schemeLetter[scheme]
	if !ok || host == "" {
		return ""
	}
	var b strings.Builder
	b.WriteByte(l)
	for i := 0; i < len(host); i++ {
		c := host[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			b.WriteByte(c)
		case c == '.':
			b.WriteString("-0")
		case c == '-':
			b.WriteString("-1")
		default:
			return ""
		}
	}
	for i := 0; i < len(port); i++ {
		if port[i] < '0' || port[i] > '9' {
			return ""
		}
	}
	if port != "" {
		b.WriteString("-2" + port)
	}
	if b.Len() > MaxLabel {
		return ""
	}
	return b.String()
}

// LabelOrigin is spec labelOrigin: the scheme, host and port ("" for none)
// a label names; ok false when it is no origin's label.
func LabelOrigin(label string) (scheme, host, port string, ok bool) {
	if label == "" {
		return "", "", "", false
	}
	scheme, ok = letterScheme[label[0]]
	if !ok {
		return "", "", "", false
	}
	var h strings.Builder
	for i := 1; i < len(label); i++ {
		c := label[i]
		if c == '-' {
			if i+1 >= len(label) {
				return "", "", "", false
			}
			switch label[i+1] {
			case '0':
				h.WriteByte('.')
			case '1':
				h.WriteByte('-')
			case '2':
				p := label[i+2:]
				if h.Len() == 0 || p == "" || strings.Trim(p, "0123456789") != "" {
					return "", "", "", false
				}
				return scheme, h.String(), p, true
			default:
				return "", "", "", false
			}
			i++
			continue
		}
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return "", "", "", false
		}
		h.WriteByte(c)
	}
	if h.Len() == 0 {
		return "", "", "", false
	}
	return scheme, h.String(), "", true
}
