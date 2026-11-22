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
