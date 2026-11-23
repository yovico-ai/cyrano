package urlrewrite

import (
	"net/url"
	"strings"
)

// RewriteLinkHeader rewrites a Link header (RFC 8288) as spec/Link.agda
// does, which is the authority (checked against Chromium:
// link-vs-chromium). Every link-value the browser reads (OWS "<" target
// ">" and ";"-parameters, split at commas outside quoted strings and
// <…>) is edited where it stands: the target proxified, imagesrcset
// rewritten as a srcset, integrity taken out (the proxied bytes are not
// the ones it names: Shop Pay's modulepreload was blocked), crossorigin
// made use-credentials as the <link>'s attribute is (not on a font or
// fetch preload/prefetch). A link-value the browser ignores is left as written.
func RewriteLinkHeader(v string, base *url.URL, cfg ProxyConfig) string {
	values := linkSplit(v, true, ',')
	for i, lv := range values {
		values[i] = rewriteLinkValue(lv, func(u string, d Dest) string { return RewriteMarked(u, base, cfg, Mark{Dest: d}) })
	}
	return strings.Join(values, ",")
}

func linkOWS(c byte) bool { return c == ' ' || c == '\t' }

func linkTrim(s string) string { return strings.Trim(s, " \t") }

// linkSplit splits at sep outside quoted strings (and, with angle, <…>).
func linkSplit(s string, angle bool, sep byte) []string {
	var out []string
	q, e, a := false, false, false
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case e:
			e = false
		case q:
			if c == '\\' {
				e = true
			} else if c == '"' {
				q = false
			}
		case a:
			a = c != '>'
		case c == '"':
			q = true
		case angle && c == '<':
			a = true
		case c == sep:
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

type linkParam struct {
	name   string // lowercase
	value  string
	quoted bool
	has    bool // a value was given
}

func linkTokenChar(c byte) bool {
	return !(linkOWS(c) || c == '=' || c == '"' || c == ';' || c == ',')
}

// readLinkParam reads a parameter's text: ok=false when the link-value is
// invalid; empty when the parameter is empty.
func readLinkParam(raw string) (p linkParam, empty, ok bool) {
	s := linkTrim(raw)
	if s == "" {
		return p, true, true
	}
	n := 0
	for n < len(s) && linkTokenChar(s[n]) {
		n++
	}
	if n == 0 {
		return p, false, false
	}
	p.name = strings.ToLower(s[:n])
	rest := strings.TrimLeft(s[n:], " \t")
	if rest == "" {
		return p, false, true
	}
	if rest[0] != '=' {
		return p, false, false
	}
	p.has = true
	val := strings.TrimLeft(rest[1:], " \t")
	if val == "" || val[0] != '"' {
		p.value = strings.TrimRight(val, " \t")
		return p, false, true
	}
	var b strings.Builder
	for i := 1; i < len(val); i++ {
		c := val[i]
		if c == '\\' && i+1 < len(val) {
			i++
			b.WriteByte(val[i])
			continue
		}
		if c == '"' {
			if linkTrim(val[i+1:]) != "" {
				return p, false, false
			}
			p.value, p.quoted = b.String(), true
			return p, false, true
		}
		b.WriteByte(c)
	}
	return p, false, false // unterminated
}

// linkDest is what a link-value's target is requested for, as for the
// <link> element (spec/Attrs.agda urlDest; htmlrewrite.URLDest, kept here
// to avoid an import cycle).
func linkDest(rels map[string]bool, as string, hasAs bool) Dest {
	switch {
	case rels["stylesheet"]:
		return DestStyle
	case rels["modulepreload"]:
		return DestScript
	case rels["preload"] || rels["prefetch"]:
		if hasAs && as == "script" {
			return DestScript
		}
		if hasAs && as == "style" {
			return DestStyle
		}
	}
	return ""
}

func rewriteLinkValue(v string, rwd func(string, Dest) string) string {
	rw := func(u string) string { return rwd(u, "") }
	lead := 0
	for lead < len(v) && linkOWS(v[lead]) {
		lead++
	}
	if lead == len(v) || v[lead] != '<' {
		return v
	}
	gt := strings.IndexByte(v[lead+1:], '>')
	if gt < 0 {
		return v
	}
	target := v[lead+1 : lead+1+gt]
	parts := linkSplit(v[lead+1+gt+1:], false, ';')
	if linkTrim(parts[0]) != "" {
		return v
	}
	var params []linkParam
	for _, p := range parts[1:] {
		lp, empty, ok := readLinkParam(p)
		if !ok {
			return v
		}
		if !empty {
			params = append(params, lp)
		}
	}
	first := func(n string) (string, bool) {
		for _, p := range params {
			if p.name == n {
				return p.value, true
			}
		}
		return "", false
	}
	rels := map[string]bool{}
	if r, ok := first("rel"); ok {
		for _, t := range strings.Fields(strings.ToLower(r)) {
			rels[t] = true
		}
	}
	as, hasAs := first("as")
	// A font or fetch hint keeps its crossorigin (spec fontHint): the
	// @font-face or fetch() it serves keeps its own credentials mode.
	fontHint := (strings.EqualFold(as, "font") || strings.EqualFold(as, "fetch")) && (rels["preload"] || rels["prefetch"])
	dest := linkDest(rels, strings.ToLower(as), hasAs)

	var b strings.Builder
	b.WriteString(v[:lead])
	b.WriteByte('<')
	b.WriteString(rwd(linkTrim(target), dest))
	b.WriteByte('>')
	b.WriteString(parts[0])
	for _, raw := range parts[1:] {
		lp, empty, _ := readLinkParam(raw)
		nameEq := func() string {
			if i := strings.IndexByte(raw, '='); i >= 0 {
				return raw[:i+1]
			}
			return raw + "="
		}
		switch {
		case !empty && lp.name == "integrity":
			continue
		case !empty && lp.name == "crossorigin" && !fontHint:
			b.WriteString(";" + nameEq() + "use-credentials")
		case !empty && lp.name == "imagesrcset" && lp.has:
			out := RewriteSrcset(lp.value, rw)
			if lp.quoted {
				out = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(out) + `"`
			}
			b.WriteString(";" + nameEq() + out)
		default:
			b.WriteString(";" + raw)
		}
	}
	return b.String()
}

// RewriteRefresh rewrites the URL of a Refresh header or a
// <meta http-equiv=refresh content=…> value as spec/Refresh.agda reads it,
// which is Chromium's reading (refresh-vs-chromium): the time is the
// leading run of digits and "." and holds a digit; then ";" / "," /
// whitespace, whitespace, one optional ";" or ","; "url" *WS "=" *WS is
// skipped (only with the "="); a quoted URL runs to the last matching
// quote; the URL is trimmed. Only the URL is edited; a value that is not
// a refresh, or a reload, is left as written.
func RewriteRefresh(v string, base *url.URL, cfg ProxyConfig) string {
	pre, u, post, ok := refreshURL(v)
	if !ok {
		return v
	}
	return pre + Rewrite(u, base, cfg) + post
}

func refreshWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r' }

// refreshURL splits a refresh value around its URL (spec read: navigate).
func refreshURL(v string) (pre, u, post string, ok bool) {
	i := 0
	for i < len(v) && refreshWS(v[i]) {
		i++
	}
	if i == len(v) {
		return "", "", "", false
	}
	digit := false
	for i < len(v) && (v[i] >= '0' && v[i] <= '9' || v[i] == '.') {
		digit = digit || v[i] != '.'
		i++
	}
	if !digit || i == len(v) {
		return "", "", "", false // not a refresh, or a reload
	}
	if !(v[i] == ';' || v[i] == ',' || refreshWS(v[i])) {
		return "", "", "", false
	}
	for i < len(v) && refreshWS(v[i]) {
		i++
	}
	if i < len(v) && (v[i] == ';' || v[i] == ',') {
		i++
	}
	for i < len(v) && refreshWS(v[i]) {
		i++
	}
	start := i
	if len(v)-i >= 3 && strings.EqualFold(v[i:i+3], "url") {
		k := i + 3
		for k < len(v) && refreshWS(v[k]) {
			k++
		}
		if k < len(v) && v[k] == '=' {
			k++
			for k < len(v) && refreshWS(v[k]) {
				k++
			}
			start = k
		}
	}
	end := len(v)
	if start < len(v) && (v[start] == '\'' || v[start] == '"') {
		q := v[start]
		start++
		if j := strings.LastIndexByte(v[start:], q); j >= 0 {
			end = start + j
		}
	}
	for start < end && refreshWS(v[start]) {
		start++
	}
	for end > start && refreshWS(v[end-1]) {
		end--
	}
	if start == end {
		return "", "", "", false // a reload
	}
	return v[:start], v[start:end], v[end:], true
}

// RewriteSpeculationRules is the Speculation-Rules value the browser is
// given (spec/Speculation.agda): when it parses as a structured-field list
// holding a string, each string member (a rule set's URL, against the
// response's URL) proxified and written as an sf-string, the members the
// browser ignores dropped; otherwise as sent.
func RewriteSpeculationRules(v string, base *url.URL, cfg ProxyConfig) string {
	ms, ok := SFList(v)
	if !ok {
		return v
	}
	var out []string
	for _, m := range ms {
		if m.Inner || len(m.Items) != 1 || m.Items[0].Kind != SFString {
			continue
		}
		out = append(out, sfQuote(RewriteMarked(m.Items[0].Text, base, cfg, Mark{})))
	}
	if len(out) == 0 {
		return v
	}
	return strings.Join(out, ", ")
}

// sfQuote writes an sf-string: quoted, "\" and `"` escaped.
func sfQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' || s[i] == '"' {
			b.WriteByte('\\')
		}
		b.WriteByte(s[i])
	}
	b.WriteByte('"')
	return b.String()
}
