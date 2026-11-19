package urlrewrite

import "strings"

// TranslatePermissionsPolicy is the Permissions-Policy a proxied document
// is given (spec/Permissions.agda translate). Through the proxy every
// document and frame has the proxy's origin, so each feature is written as
// * when its allowlist has *, (self) when it has self or names any origin,
// () when neither. Lines that do not parse as a dictionary — which
// Chromium ignores whole — are returned as they are.
func TranslatePermissionsPolicy(lines []string) []string {
	d, ok := SFDict(strings.Join(lines, ", "))
	if !ok {
		return lines
	}
	parts := make([]string, len(d))
	for i, e := range d {
		all, any := false, false
		for _, it := range e.Value.Items {
			switch ppEntry(it) {
			case ppAll:
				all = true
			case ppSelf, ppOrigin:
				any = true
			}
		}
		switch {
		case all:
			parts[i] = e.Key + "=*"
		case any:
			parts[i] = e.Key + "=(self)"
		default:
			parts[i] = e.Key + "=()"
		}
	}
	return []string{strings.Join(parts, ", ")}
}

type ppKind int

const (
	ppNone ppKind = iota
	ppAll
	ppSelf
	ppOrigin
)

// ppEntry is an allowlist member as Chromium reads it: tokens become
// Feature-Policy's words (self → 'self'), and every member is then read
// as Feature-Policy does — "*", "'self'", "'src'"/"'none'" (nothing in a
// header), else an origin that is not opaque.
func ppEntry(it SFItem) ppKind {
	var w string
	switch it.Kind {
	case SFToken:
		switch it.Text {
		case "*":
			return ppAll
		case "self":
			return ppSelf
		}
		return ppNone
	case SFString:
		w = it.Text
	default:
		return ppNone
	}
	switch w {
	case "*":
		return ppAll
	case "'self'":
		return ppSelf
	case "'src'", "'none'":
		return ppNone
	}
	if isAllowlistOrigin(w) {
		return ppOrigin
	}
	return ppNone
}

// isAllowlistOrigin: w names an origin in an allowlist (spec/Permissions
// originEntry): an absolute http(s)/ws(s) URL without userinfo (Chromium
// takes none with it).
func isAllowlistOrigin(w string) bool {
	u, res := parseRef(nil, w)
	return res == parsedURL && !strings.Contains(u.auth, "@")
}

func asciiWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r' }

// RewriteAllow is an iframe's allow attribute as the browser is given it
// (spec/Allow.agda rewriteAllow): each allowlist word that names an origin
// becomes 'src' — through the proxy the frame's src is a proxy URL, and an
// origin there names nothing. Every other byte is kept.
func RewriteAllow(v string) string { return rewriteWords(v, "'src'", false) }

// RewriteFeaturePolicy is a Feature-Policy header as the browser is given
// it (spec/Allow.agda rewriteFeaturePolicy): each origin word becomes
// 'self' — every document has the proxy's origin there; a *. pattern is
// not one (Feature-Policy reads none), nor is an unknown word.
func RewriteFeaturePolicy(v string) string { return rewriteWords(v, "'self'", true) }

func rewriteWords(v, to string, noWild bool) string {
	dirs := strings.Split(v, ";")
	for i, d := range dirs {
		var b strings.Builder
		seenName := false
		j := 0
		for j < len(d) {
			if asciiWS(d[j]) {
				b.WriteByte(d[j])
				j++
				continue
			}
			k := j
			for k < len(d) && !asciiWS(d[k]) {
				k++
			}
			w := d[j:k]
			if seenName && allowWordIsOrigin(w) && !(noWild && wildOrigin(w)) {
				w = to
			}
			b.WriteString(w)
			seenName = true
			j = k
		}
		dirs[i] = b.String()
	}
	return strings.Join(dirs, ";")
}

// wildOrigin: an origin word whose host is a *. pattern.
func wildOrigin(w string) bool {
	u, res := parseRef(nil, w)
	return res == parsedURL && strings.HasPrefix(strings.ToLower(u.auth), "%2a.")
}

// allowWordIsOrigin: an allow attribute's word that names an origin — not
// one of its keywords (spec/Allow.agda item).
func allowWordIsOrigin(w string) bool {
	switch strings.ToLower(w) {
	case "*", "'self'", "'src'", "'none'":
		return false
	}
	return isAllowlistOrigin(w)
}
