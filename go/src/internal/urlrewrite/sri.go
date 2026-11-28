package urlrewrite

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"strings"
)

// Subresource Integrity (spec/Sri.agda). Through the proxy a script or
// stylesheet is rewritten, so its bytes can never match the page's
// `integrity`: the rewriters drop the attribute and carry the metadata in
// the element's URL instead (the scheme segment's "!=" marker, SRIMark);
// the proxy checks the origin's bytes against it (SRIFails) and fails the
// response — a network error — when they do not match.

type sriItem struct{ alg, value string }

var sriRank = map[string]int{"sha256": 1, "sha384": 2, "sha512": 3}

// sriCanon is a base64 / base64url value made canonical (spec Sri.canon):
// "+" → "-", "/" → "_", no "=" padding; false when it is empty or holds
// any other byte.
func sriCanon(v string) (string, bool) {
	v = strings.TrimRight(v, "=")
	if v == "" {
		return "", false
	}
	b := []byte(v)
	for i, c := range b {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
		case c == '+':
			b[i] = '-'
		case c == '/':
			b[i] = '_'
		default:
			return "", false
		}
	}
	return string(b), true
}

// sriItemOf reads one token: alg "-" value ["?" options] (spec Sri.itemOf).
func sriItemOf(t string) (sriItem, bool) {
	a, rest, ok := strings.Cut(t, "-")
	if !ok {
		return sriItem{}, false
	}
	alg := asciiLower(a)
	if sriRank[alg] == 0 {
		return sriItem{}, false
	}
	if i := strings.IndexByte(rest, '?'); i >= 0 {
		rest = rest[:i]
	}
	v, ok := sriCanon(rest)
	if !ok {
		return sriItem{}, false
	}
	return sriItem{alg, v}, true
}

func sriSplit(s string, sep func(rune) bool) []string {
	// spec splitOn: every separator splits, empty pieces kept
	var out []string
	start := 0
	for i, r := range s {
		if sep(r) {
			out = append(out, s[start:i])
			start = i + len(string(r))
		}
	}
	return append(out, s[start:])
}

func sriItems(tokens []string) []sriItem {
	var out []sriItem
	for _, t := range tokens {
		if it, ok := sriItemOf(t); ok {
			out = append(out, it)
		}
	}
	return out
}

// SRIMark is the marker an element's integrity metadata gives its URL
// (spec Sri.markOf): the strongest algorithm's valid items, canonical,
// joined by "."; false when there is nothing to check.
func SRIMark(metadata string) (string, bool) {
	items := sriItems(sriSplit(metadata, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\f' || r == '\r' }))
	top := 0
	for _, it := range items {
		top = max(top, sriRank[it.alg])
	}
	var parts []string
	for _, it := range items {
		if sriRank[it.alg] == top {
			parts = append(parts, it.alg+"-"+it.value)
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, "."), true
}

// SRIDigest is body's digest by alg, canonical base64url.
func SRIDigest(alg string, body []byte) string {
	var sum []byte
	switch alg {
	case "sha256":
		s := sha256.Sum256(body)
		sum = s[:]
	case "sha384":
		s := sha512.Sum384(body)
		sum = s[:]
	case "sha512":
		s := sha512.Sum512(body)
		sum = s[:]
	}
	return base64.RawURLEncoding.EncodeToString(sum)
}

// SRIPasses: does a body whose digests digest gives match the mark (spec
// Sri.passes).
func SRIPasses(mark string, digest func(alg string) string) bool {
	for _, it := range sriItems(strings.Split(mark, ".")) {
		if digest(it.alg) == it.value {
			return true
		}
	}
	return false
}

// SRIFails: the proxy fails the response (spec Sri.fails) — a mark, and a
// response that is opaque (not eligible) or matches none of its items.
func SRIFails(mark string, marked, eligible bool, body []byte) bool {
	if !marked {
		return false
	}
	return !eligible || !SRIPasses(mark, func(alg string) string { return SRIDigest(alg, body) })
}

// SRIHonored: the browser checks this element attribute's integrity (spec
// Sri.honored): a script's src; a link's href for a stylesheet, a preload
// or a modulepreload (rels lowercased).
func SRIHonored(svg bool, tag, attr string, rels []string) bool {
	if svg {
		return false
	}
	if tag == "script" && attr == "src" {
		return true
	}
	if tag == "link" && attr == "href" {
		for _, r := range rels {
			if r == "stylesheet" || r == "preload" || r == "modulepreload" {
				return true
			}
		}
	}
	return false
}

// Where an honored element's integrity goes (spec Sri.carry).
type SRICarryKind int

const (
	SRIUnchecked  SRICarryKind = iota
	SRIInURL                   // marked in its proxified URL
	SRIInDocument              // kept for the document, checked by the proxy
)

// SRICarry: a module member — a module script's src, a modulepreload's
// href — is named by its URL in the module map, so its integrity is not
// marked there (two URLs were two module instances: gigabyte.com's Nuxt
// entry ran twice); the document keeps it, as an import map's integrity
// section (proxy.RecordModuleIntegrity). Everything else honored is marked.
func SRICarry(svg bool, tag, attr string, rels []string, isModule bool) SRICarryKind {
	if !SRIHonored(svg, tag, attr, rels) {
		return SRIUnchecked
	}
	if tag == "script" && isModule {
		return SRIInDocument
	}
	if tag == "link" {
		for _, r := range rels {
			if r == "modulepreload" {
				return SRIInDocument
			}
		}
	}
	return SRIInURL
}
