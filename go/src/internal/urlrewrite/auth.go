package urlrewrite

import "strings"

// RewriteChallenge is spec/Auth.agda rewriteChallenge: a WWW-Authenticate
// field line that starts with a Basic challenge gets its first realm
// parameter named for site — realm="<site> <realm>" — so the browser's
// credentials cache (by origin and realm: every proxied site is the
// proxy's origin) keeps each site's apart. Any other line, or one not
// readable so, is left as sent.
func RewriteChallenge(site, line string) string {
	scheme, r := authToken(line)
	if strings.ToLower(scheme) != "basic" || r == "" || !authSp(r[0]) {
		return line
	}
	before, v, after, ok := realmIn(line[:len(scheme)+1], r[1:])
	if !ok {
		return line
	}
	return before + authQuote(site+" "+v) + after
}

// AuthPromptable: the browser would show a challenge on this response (spec
// promptable) — a navigation's, a same-origin or a CORS request's.
func AuthPromptable(navigation, sameOrigin, cors bool) bool { return navigation || sameOrigin || cors }

func authSp(c byte) bool { return c == ' ' || c == '\t' }

func authTchar(c byte) bool {
	return !(authSp(c) || strings.IndexByte("\",;=()<>@:\\/[]?{}", c) >= 0)
}

func authToken(s string) (string, string) {
	i := 0
	for i < len(s) && authTchar(s[i]) {
		i++
	}
	return s[:i], s[i:]
}

func authSpan(s string) (string, string) {
	i := 0
	for i < len(s) && authSp(s[i]) {
		i++
	}
	return s[:i], s[i:]
}

// authValue reads a token or a quoted-string: its value and the rest.
func authValue(s string) (string, string, bool) {
	if strings.HasPrefix(s, `"`) {
		var b strings.Builder
		for i := 1; i < len(s); i++ {
			switch s[i] {
			case '"':
				return b.String(), s[i+1:], true
			case '\\':
				if i+1 >= len(s) {
					return "", "", false
				}
				i++
				b.WriteByte(s[i])
			default:
				b.WriteByte(s[i])
			}
		}
		return "", "", false
	}
	t, r := authToken(s)
	if t == "" {
		return "", "", false
	}
	return t, r, true
}

// realmIn finds the first realm parameter among the params of s: the text
// before its value (consumed is what came before s), its value, the text
// after it.
func realmIn(consumed, s string) (string, string, string, bool) {
	for {
		w, r := authSpan(s)
		name, r1 := authToken(r)
		if name == "" {
			return "", "", "", false
		}
		w1, r1b := authSpan(r1)
		if !strings.HasPrefix(r1b, "=") {
			return "", "", "", false
		}
		consumed += w + name + w1 + "="
		w2, rest := authSpan(r1b[1:])
		v, r3, ok := authValue(rest)
		if !ok {
			return "", "", "", false
		}
		if strings.ToLower(name) == "realm" {
			return consumed + w2, v, r3, true
		}
		consumed += w2 + rest[:len(rest)-len(r3)]
		w4, r4 := authSpan(r3)
		if !strings.HasPrefix(r4, ",") {
			return "", "", "", false
		}
		consumed += w4 + ","
		s = r4[1:]
	}
}

func authQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}
