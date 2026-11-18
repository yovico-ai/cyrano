package urlrewrite

// The browser's URL parser (WHATWG URL Standard), for the URLs cyrano
// rewrites: a port of spec/Url.agda, function for function. The spec is
// the authority; keep this in step with it (owner, 2026-11-17: targets are
// normalized the way the browser does it, so the server's static rewrite
// and the client's dynamic one produce the same bytes).
//
// net/url is not used for this because it keeps host case and default
// ports, does not treat '\' as '/', and encodes a different set of
// characters than the browser does.

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

// absURL is spec/Url.agda's Abs: a parsed absolute URL whose authority is
// canonical [userinfo@]host[:port] text and whose path is percent-encoded
// segments with dot segments resolved. Userinfo is kept as the browser
// writes it: page code reads it back in href (the page cannot tell).
type absURL struct {
	scheme string
	auth   string
	path   []string
	query  *string
	frag   *string
}

// parsed is spec/Url.agda's Parsed.
type parsed int

const (
	parsedURL   parsed = iota
	otherScheme        // a scheme cyrano does not proxify
	invalidURL         // the browser's parser rejects it
)

var defaultPort = map[string]int{"http": 80, "https": 443, "ws": 80, "wss": 443}

func isSlash(r rune) bool { return r == '/' || r == '\\' }
func isDigit(r rune) bool { return r >= '0' && r <= '9' }
func isAlpha(r rune) bool { return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') }
func isHex(r rune) bool {
	return isDigit(r) || (r >= 'A' && r <= 'F') || (r >= 'a' && r <= 'f')
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// preprocess drops leading and trailing C0 controls and spaces, then
// every tab, LF and CR.
func preprocess(s string) string {
	s = strings.TrimFunc(s, func(r rune) bool { return r <= ' ' })
	return strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)
}

// Percent-encode sets (Node 22's, which leaves '^' out of the path set).
func c0Set(r rune) bool       { return r < 0x20 || r > 0x7e }
func fragmentSet(r rune) bool { return c0Set(r) || strings.ContainsRune(" \"<>`", r) }
func querySet(r rune) bool    { return c0Set(r) || strings.ContainsRune(" \"#<>'", r) }
func pathSet(r rune) bool     { return c0Set(r) || strings.ContainsRune(" \"#<>?`{}^|", r) } // ^ | as Chromium
func userinfoSet(r rune) bool { return pathSet(r) || strings.ContainsRune("/:;=@[\\]^|", r) }

func encodeWith(inSet func(rune) bool, s []rune) string {
	var b strings.Builder
	for _, r := range s {
		if !inSet(r) {
			b.WriteRune(r)
			continue
		}
		for _, c := range []byte(string(r)) {
			b.WriteByte('%')
			b.WriteByte("0123456789ABCDEF"[c>>4])
			b.WriteByte("0123456789ABCDEF"[c&15])
		}
	}
	return b.String()
}

func allRunes(s string, p func(rune) bool) bool {
	for _, r := range s {
		if !p(r) {
			return false
		}
	}
	return true
}

// ── host and port ───────────────────────────────────────────────────────

type hostResult int

const (
	hostOK hostResult = iota
	hostInvalid
)

// forbiddenDomain: WHATWG forbidden domain code points (ASCII; applied
// after percent-decoding, so % [ ] can reach it) — except the space, which
// Chromium escapes instead (chromiumHost).
func forbiddenDomain(r rune) bool {
	return r < ' ' || r == 0x7f || strings.ContainsRune("#%/:<>?@[\\]^|", r)
}

func hexVal(r rune) rune {
	switch {
	case isDigit(r):
		return r - '0'
	case r >= 'A' && r <= 'F':
		return r - 'A' + 10
	default:
		return r - 'a' + 10
	}
}

// pctDecode is WHATWG percent-decode: %XX becomes that byte (here a code
// point below 256); a '%' not followed by two hex digits stays.
func pctDecode(s string) string {
	rs := []rune(s)
	var b strings.Builder
	for i := 0; i < len(rs); i++ {
		if rs[i] == '%' && i+2 < len(rs) && isHex(rs[i+1]) && isHex(rs[i+2]) {
			b.WriteRune(hexVal(rs[i+1])*16 + hexVal(rs[i+2]))
			i += 2
			continue
		}
		b.WriteRune(rs[i])
	}
	return b.String()
}

// octet: a decimal label 0..255 written without leading zeros.
func octet(l string) bool {
	if l == "" || !allRunes(l, isDigit) {
		return false
	}
	if len(l) == 1 {
		return true
	}
	if l[0] == '0' || len(l) > 3 {
		return false
	}
	n, _ := strconv.Atoi(l)
	return n <= 255
}

func numericLabel(l string) bool {
	if l == "" {
		return false
	}
	if allRunes(l, isDigit) {
		return true
	}
	return l[0] == '0' && len(l) >= 2 && (l[1] == 'x' || l[1] == 'X') && allRunes(l[2:], isHex)
}

// endsInNumber: the last label (ignoring one trailing dot) is numeric;
// the browser reads such a host as an IPv4 address.
func endsInNumber(h string) bool {
	labels := strings.Split(h, ".")
	if len(labels) > 0 && labels[len(labels)-1] == "" {
		labels = labels[:len(labels)-1]
	}
	if len(labels) == 0 {
		return false
	}
	return numericLabel(labels[len(labels)-1])
}

// parseHost is the WHATWG host parser (spec/Url.agda host). "[…]" is
// IPv6. Otherwise percent-decode; a host with non-ASCII bytes goes through
// IDNA (UTS #46) — the one part the spec leaves outside its model, checked
// instead against a real browser (Chromium) by fixtures/idna.json. Then
// the forbidden-code-point check, and IPv4 for a host ending in a number.
//
// The reference is Chromium, not the URL Standard, where they differ: the
// page cannot tell only if cyrano parses as the user's browser does, and a
// host Go rejected but the browser accepted would be left unproxified — a
// request escaping containment. Chromium runs IDNA only on non-ASCII hosts
// (so an ASCII "xn--" label is taken as written), allows joiners
// (CheckJoiners=false) and applies the bidi rule.
func parseHost(h string) (string, hostResult) {
	if h == "" {
		return "", hostInvalid
	}
	if h[0] == '[' {
		if !strings.HasSuffix(h, "]") {
			return "", hostInvalid
		}
		pieces, ok := parseIPv6(h[1 : len(h)-1])
		if !ok {
			return "", hostInvalid
		}
		return ipv6Text(pieces), hostOK
	}
	b := pctDecodeBytes(h)
	domain := string(b)
	if needsIDNA(b) {
		a, err := idnaProfile.ToASCII(strings.ToValidUTF8(domain, "\uFFFD"))
		if err != nil || a == "" || leadingMark(a) {
			return "", hostInvalid
		}
		domain = a
	}
	for _, r := range domain {
		if forbiddenDomain(r) {
			return "", hostInvalid
		}
	}
	lower := lowerASCII(domain)
	if endsInNumber(lower) {
		n, ok := parseIPv4(lower)
		if !ok {
			return "", hostInvalid
		}
		return ipv4Text(n), hostOK
	}
	return chromiumHost(lower), hostOK
}

// chromiumHost: where Chromium departs from the standard for a domain, a
// space and '*' are kept percent-encoded (%20, %2A) — spec chromiumHost.
func chromiumHost(h string) string {
	return strings.NewReplacer(" ", "%20", "*", "%2A").Replace(h)
}

// idnaProfile is UTS #46 ToASCII as Chromium applies it: nontransitional,
// bidi rule on, joiners allowed, no hyphen / STD3 / DNS-length checks.
var idnaProfile = idna.New(
	idna.MapForLookup(),
	idna.Transitional(false),
	idna.BidiRule(),
	idna.CheckJoiners(false),
	idna.CheckHyphens(false),
	idna.StrictDomainName(false),
	idna.VerifyDNSLength(false),
)

// leadingMark: some label of the ASCII result decodes to text starting
// with a combining mark, which UTS #46 validity forbids (x/net/idna lets it
// through once joiners are allowed).
func leadingMark(ascii string) bool {
	for _, l := range strings.Split(ascii, ".") {
		if !strings.HasPrefix(l, "xn--") {
			continue
		}
		u, err := idna.Punycode.ToUnicode(l)
		if err != nil {
			return true
		}
		if r, _ := utf8.DecodeRuneInString(u); unicode.Is(unicode.M, r) {
			return true
		}
	}
	return false
}

// needsIDNA: the host has non-ASCII bytes (Chromium leaves ASCII hosts to
// plain lowercasing).
func needsIDNA(b []byte) bool {
	for _, c := range b {
		if c > 0x7f {
			return true
		}
	}
	return false
}

// pctDecodeBytes is WHATWG percent-decode over the UTF-8 bytes of s.
func pctDecodeBytes(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(rune(s[i+1])) && isHex(rune(s[i+2])) {
			out = append(out, byte(hexVal(rune(s[i+1]))*16+hexVal(rune(s[i+2]))))
			i += 2
			continue
		}
		out = append(out, s[i])
	}
	return out
}

// ── IPv4 (WHATWG "IPv4 parser") ─────────────────────────────────────────

func inRadix(r uint64, s string) (uint64, bool) {
	var n uint64
	for _, c := range s {
		var d uint64
		switch {
		case r == 16 && isHex(c):
			d = uint64(hexVal(c))
		case r == 8 && c >= '0' && c <= '7', r == 10 && isDigit(c):
			d = uint64(c - '0')
		default:
			return 0, false
		}
		n = n*r + d
		if n > 1<<40 { // beyond any IPv4 value; keep the arithmetic bounded
			n = 1 << 40
		}
	}
	return n, true
}

func ipv4Number(p string) (uint64, bool) {
	switch {
	case p == "":
		return 0, false
	case len(p) >= 2 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X'):
		return inRadix(16, p[2:])
	case len(p) >= 2 && p[0] == '0':
		return inRadix(8, p[1:])
	default:
		return inRadix(10, p)
	}
}

func parseIPv4(h string) (uint64, bool) {
	parts := strings.Split(h, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return 0, false
	}
	var v uint64
	for i, p := range parts {
		n, ok := ipv4Number(p)
		if !ok {
			return 0, false
		}
		if i < len(parts)-1 {
			if n > 255 {
				return 0, false
			}
			v += n << (8 * uint(3-i))
			continue
		}
		if n >= 1<<(8*uint(5-len(parts))) {
			return 0, false
		}
		v += n
	}
	return v, true
}

func ipv4Text(n uint64) string {
	return strconv.FormatUint(n>>24&255, 10) + "." + strconv.FormatUint(n>>16&255, 10) + "." +
		strconv.FormatUint(n>>8&255, 10) + "." + strconv.FormatUint(n&255, 10)
}

// ── IPv6 (WHATWG "IPv6 parser" and serializer) ──────────────────────────

func ipv6Piece(g string) (uint64, bool) {
	if g == "" || len(g) > 4 {
		return 0, false
	}
	return inRadix(16, g)
}

func ipv6Groups(s string, tail bool) ([]uint64, bool) {
	if s == "" {
		return nil, true
	}
	gs := strings.Split(s, ":")
	var out []uint64
	for i, g := range gs {
		if tail && i == len(gs)-1 && strings.Contains(g, ".") {
			os := strings.Split(g, ".")
			if len(os) != 4 {
				return nil, false
			}
			var b [4]uint64
			for j, o := range os {
				if !octet(o) {
					return nil, false
				}
				n, _ := strconv.ParseUint(o, 10, 64)
				b[j] = n
			}
			out = append(out, b[0]<<8|b[1], b[2]<<8|b[3])
			continue
		}
		n, ok := ipv6Piece(g)
		if !ok {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}

func parseIPv6(s string) ([]uint64, bool) {
	l, r, double := strings.Cut(s, "::")
	if !double {
		ps, ok := ipv6Groups(s, true)
		return ps, ok && len(ps) == 8
	}
	if strings.Contains(r, "::") {
		return nil, false
	}
	ls, ok1 := ipv6Groups(l, false)
	rs, ok2 := ipv6Groups(r, true)
	if !ok1 || !ok2 || len(ls)+len(rs) > 7 {
		return nil, false
	}
	out := append(append(ls, make([]uint64, 8-len(ls)-len(rs))...), rs...)
	return out, true
}

func ipv6Text(ps []uint64) string {
	// The first longest run of zero pieces, of length ≥ 2, becomes "::".
	best, bestLen := -1, 1
	for i := 0; i < len(ps); i++ {
		n := 0
		for i+n < len(ps) && ps[i+n] == 0 {
			n++
		}
		if n > bestLen {
			best, bestLen = i, n
		}
	}
	hex := func(xs []uint64) string {
		t := make([]string, len(xs))
		for i, x := range xs {
			t[i] = strconv.FormatUint(x, 16)
		}
		return strings.Join(t, ":")
	}
	if best < 0 {
		return "[" + hex(ps) + "]"
	}
	return "[" + hex(ps[:best]) + "::" + hex(ps[best+bestLen:]) + "]"
}

// parsePort returns the canonical port text ("" for none or the scheme's
// default) and whether it is valid.
func parsePort(scheme, p string) (string, bool) {
	if p == "" {
		return "", true
	}
	if !allRunes(p, isDigit) {
		return "", false
	}
	n := 0
	for _, r := range p {
		n = n*10 + int(r-'0')
		if n > 65535 {
			return "", false
		}
	}
	if n == defaultPort[scheme] {
		return "", true
	}
	return strconv.Itoa(n), true
}

func isAuthorityEnd(r rune) bool { return isSlash(r) || r == '?' || r == '#' }

// userinfoText is the userinfo as the browser serializes it: username and
// password (split at the first ':') percent-encoded, written only when one
// of them is non-empty.
func userinfoText(ui []rune) string {
	u, p := ui, []rune(nil)
	for i, r := range ui {
		if r == ':' {
			u, p = ui[:i], ui[i+1:]
			break
		}
	}
	eu, ep := encodeWith(userinfoSet, u), encodeWith(userinfoSet, p)
	switch {
	case eu == "" && ep == "":
		return ""
	case ep == "":
		return eu + "@"
	default:
		return eu + ":" + ep + "@"
	}
}

// hostPort is the host[:port] of a canonical authority (canonical
// userinfo has no raw '@').
func hostPort(auth string) string {
	if at := strings.LastIndexByte(auth, '@'); at >= 0 {
		return auth[at+1:]
	}
	return auth
}

// authority reads [userinfo@]host[:port] up to the first / \ ? #.
// Userinfo runs to the last '@'; the host ends at the first ':'.
func authority(scheme string, inp []rune) (auth string, rest []rune, res parsed) {
	end := len(inp)
	for i, r := range inp {
		if isAuthorityEnd(r) {
			end = i
			break
		}
	}
	hp, rest := string(inp[:end]), inp[end:]
	ui := ""
	if at := strings.LastIndexByte(hp, '@'); at >= 0 {
		ui = userinfoText([]rune(hp[:at]))
		hp = hp[at+1:]
	}
	h, p, hasPort := splitHostPort(hp)
	host, hr := parseHost(h)
	switch hr {
	case hostInvalid:
		return "", nil, invalidURL
	}
	res = parsedURL
	if !hasPort {
		return ui + host, rest, res
	}
	port, ok := parsePort(scheme, p)
	if !ok {
		return "", nil, invalidURL
	}
	if port == "" {
		return ui + host, rest, res
	}
	return ui + host + ":" + port, rest, res
}

// splitHostPort splits host and port text; inside "[…]" a ':' is part of
// the host (spec hostAndPort).
func splitHostPort(hp string) (host, port string, hasPort bool) {
	if strings.HasPrefix(hp, "[") {
		if i := strings.IndexByte(hp, ']'); i >= 0 {
			switch rest := hp[i+1:]; {
			case rest == "":
				return hp[:i+1], "", false
			case rest[0] == ':':
				return hp[:i+1], rest[1:], true
			}
		}
		return hp, "", false
	}
	return strings.Cut(hp, ":")
}

// ── path, query, fragment ───────────────────────────────────────────────

func isSingleDot(b string) bool { return b == "." || lowerASCII(b) == "%2e" }
func isDoubleDot(b string) bool {
	switch lowerASCII(b) {
	case "..", ".%2e", "%2e.", "%2e%2e":
		return true
	}
	return false
}

func shorten(p []string) []string {
	if len(p) == 0 {
		return p
	}
	return p[:len(p)-1]
}

// endSegment is the WHATWG path state at the end of one segment; slash
// says the segment ended at a slash (not at ?, # or the end).
func endSegment(slash bool, buf []rune, acc []string) []string {
	b := string(buf)
	switch {
	case isDoubleDot(b):
		acc = shorten(acc)
		if !slash {
			acc = append(acc, "")
		}
	case isSingleDot(b):
		if !slash {
			acc = append(acc, "")
		}
	default:
		acc = append(acc, encodeWith(pathSet, buf))
	}
	return acc
}

func pathLoop(acc []string, s []rune) ([]string, []rune) {
	acc = append([]string(nil), acc...)
	var buf []rune
	for i, r := range s {
		switch {
		case isSlash(r):
			acc = endSegment(true, buf, acc)
			buf = buf[:0]
		case r == '?' || r == '#':
			return endSegment(false, buf, acc), s[i:]
		default:
			buf = append(buf, r)
		}
	}
	return endSegment(false, buf, acc), nil
}

func fragmentOf(r []rune) *string {
	if len(r) == 0 {
		return nil
	}
	f := encodeWith(fragmentSet, r[1:])
	return &f
}

func queryAndFragment(r []rune) (*string, *string) {
	if len(r) == 0 {
		return nil, nil
	}
	if r[0] != '?' {
		return nil, fragmentOf(r)
	}
	q, rest := r[1:], []rune(nil)
	for i, c := range q {
		if c == '#' {
			q, rest = q[:i], q[i:]
			break
		}
	}
	enc := encodeWith(querySet, q)
	return &enc, fragmentOf(rest)
}

func fromPath(scheme, auth string, p []string, r []rune) absURL {
	q, f := queryAndFragment(r)
	return absURL{scheme: scheme, auth: auth, path: p, query: q, frag: f}
}

func withAuthority(scheme string, inp []rune) (absURL, parsed) {
	for len(inp) > 0 && isSlash(inp[0]) {
		inp = inp[1:]
	}
	auth, rest, res := authority(scheme, inp)
	if res != parsedURL {
		return absURL{}, res
	}
	// One leading slash after the authority belongs to the path.
	if len(rest) > 0 && isSlash(rest[0]) {
		rest = rest[1:]
	}
	p, r := pathLoop(nil, rest)
	return fromPath(scheme, auth, p, r), parsedURL
}

// schemeSplit: ALPHA *( ALPHA / DIGIT / + / - / . ) ":" , lowercased.
func schemeSplit(s []rune) (string, []rune, bool) {
	if len(s) == 0 || !isAlpha(s[0]) {
		return "", nil, false
	}
	for i := 1; i < len(s); i++ {
		r := s[i]
		if r == ':' {
			return lowerASCII(string(s[:i])), s[i+1:], true
		}
		if !(isAlpha(r) || isDigit(r) || r == '+' || r == '-' || r == '.') {
			return "", nil, false
		}
	}
	return "", nil, false
}

// relative resolves a reference against base (WHATWG relative state).
func relative(b absURL, s []rune) (absURL, parsed) {
	if len(s) == 0 {
		return absURL{scheme: b.scheme, auth: b.auth, path: b.path, query: b.query}, parsedURL
	}
	switch c := s[0]; {
	case isSlash(c):
		if len(s) > 1 && isSlash(s[1]) {
			return withAuthority(b.scheme, s[2:])
		}
		p, r := pathLoop(nil, s[1:])
		return fromPath(b.scheme, b.auth, p, r), parsedURL
	case c == '?':
		return fromPath(b.scheme, b.auth, b.path, s), parsedURL
	case c == '#':
		return absURL{scheme: b.scheme, auth: b.auth, path: b.path, query: b.query, frag: fragmentOf(s)}, parsedURL
	default:
		p, r := pathLoop(shorten(b.path), s)
		return fromPath(b.scheme, b.auth, p, r), parsedURL
	}
}

// parseRef reads s against an optional base; without a base only an
// absolute URL is understood.
func parseRef(base *absURL, s string) (absURL, parsed) {
	rs := []rune(s)
	name, rest, ok := schemeSplit(rs)
	if !ok {
		if base == nil {
			return absURL{}, invalidURL
		}
		return relative(*base, rs)
	}
	if _, proxifiable := defaultPort[name]; !proxifiable {
		return absURL{}, otherScheme
	}
	// "https:foo" on an https page is relative to the page; otherwise the
	// slashes are optional and it names host foo.
	if base != nil && base.scheme == name {
		return relative(*base, rest)
	}
	return withAuthority(name, rest)
}

// ── serializing ─────────────────────────────────────────────────────────

func pathText(p []string) string {
	var b strings.Builder
	for _, s := range p {
		b.WriteByte('/')
		b.WriteString(s)
	}
	return b.String()
}

// An empty query or fragment is a bare "?" or "#", as the browser writes
// it: page code reads it back in href (the page cannot tell).
func queryText(q *string) string {
	if q == nil {
		return ""
	}
	return "?" + *q
}

func fragText(f *string) string {
	if f == nil {
		return ""
	}
	return "#" + *f
}

func (u absURL) origin() string { return u.scheme + "://" + u.auth }

func (u absURL) href() string {
	return u.origin() + pathText(u.path) + queryText(u.query) + fragText(u.frag)
}
