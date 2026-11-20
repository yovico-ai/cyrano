package urlrewrite

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
)

// TrustedTypesPolicy is the name of the runtime's own Trusted Types policy:
// random per server process, so a page cannot name it. The client is told
// it in its config ("tt").
var TrustedTypesPolicy = func() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "_crn0policy"
	}
	return "_" + hex.EncodeToString(b)
}()

// Content Security Policy for the proxy: reading a policy (CSP3 §2.2) and
// translating it. spec/Csp.agda is the authority — keep this in step with
// it and with ts/client/src/patches/html-rewriter.ts (rewriteCspContent);
// both are checked against the spec (csp_conformance_test.go).
//
// The translation weakens the policy (it does not translate host-sources
// to proxied path prefixes):
//   - report-uri / report-to are dropped (reports would leave the proxy);
//   - on a plain-http proxy, upgrade-insecure-requests and
//     block-all-mixed-content are dropped (they would upgrade or block
//     every proxied load);
//   - trusted-types stays enforced: 'none' is dropped and the runtime's own
//     policy (TrustedTypesPolicy; TS native/trusted.ts) admitted beside the
//     page's, unless "*" admits it — a site checks that its Trusted Types
//     are enforced (Cloudflare's challenge);
//   - a fetch directive gets the proxy origin, unless it allows nothing
//     ('none', with at most 'report-sample' beside it)
//     or lists it already;
//   - a script/style directive (and default-src) with a hash source drops
//     its nonces, hashes and 'strict-dynamic' and gains 'unsafe-inline' and
//     'self': rewritten inline scripts cannot match their hashes, and a hash
//     makes the browser ignore 'unsafe-inline'. Without a hash, nonces and
//     'strict-dynamic' stay — a nonce authorizes a script whatever its URL
//     (Facebook loads scripts from data: URLs only the nonce allows), and
//     the bootstrap is given it (ScriptNonce).
// Output is canonical: "name value…" directives joined by "; ", a header's
// policies by ", ", names lowercase, later duplicates left out.

type cspDirective struct {
	name string
	vals []string
}

func isCSPSpace(r rune) bool { return r == '\t' || r == '\n' || r == '\f' || r == '\r' || r == ' ' }

func cspWords(s string) []string { return strings.FieldsFunc(s, isCSPSpace) }

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// parseCSPPolicy reads one serialized policy (CSP3 §2.2.1; spec parsePolicy).
func parseCSPPolicy(s string) []cspDirective {
	var out []cspDirective
	seen := map[string]bool{}
	for _, tok := range strings.Split(s, ";") {
		w := cspWords(tok)
		if len(w) == 0 || !isASCII(tok) {
			continue
		}
		name := strings.ToLower(w[0])
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, cspDirective{name, w[1:]})
	}
	return out
}

// parseCSPHeader reads a header value: a comma-separated list of policies.
func parseCSPHeader(s string) [][]cspDirective {
	var out [][]cspDirective
	for _, p := range strings.Split(s, ",") {
		out = append(out, parseCSPPolicy(p))
	}
	return out
}

var cspFetchDirectives = map[string]bool{
	"child-src": true, "connect-src": true, "default-src": true, "fenced-frame-src": true, "font-src": true,
	"frame-src": true, "img-src": true, "manifest-src": true, "media-src": true, "object-src": true,
	"prefetch-src": true, "script-src": true, "script-src-elem": true, "script-src-attr": true,
	"style-src": true, "style-src-elem": true, "style-src-attr": true, "worker-src": true,
}

func isScriptOrStyleDirective(name string) bool {
	switch name {
	case "default-src",
		"script-src", "script-src-elem", "script-src-attr",
		"style-src", "style-src-elem", "style-src-attr":
		return true
	}
	return false
}

func isHashSource(lower string) bool {
	return strings.HasPrefix(lower, "'sha256-") || strings.HasPrefix(lower, "'sha384-") || strings.HasPrefix(lower, "'sha512-")
}

func containsFold(vals []string, t string) bool {
	for _, v := range vals {
		if strings.EqualFold(v, t) {
			return true
		}
	}
	return false
}

func appendIfAbsent(vals []string, t string) []string {
	if containsFold(vals, t) {
		return vals
	}
	return append(vals, t)
}

func translateCSPDirective(d cspDirective, proxyOrigin string) (cspDirective, bool) {
	plainHTTP := strings.HasPrefix(strings.ToLower(proxyOrigin), "http://")
	switch {
	case d.name == "report-uri" || d.name == "report-to":
		return d, false
	case plainHTTP && (d.name == "upgrade-insecure-requests" || d.name == "block-all-mixed-content"):
		return d, false
	case d.name == "trusted-types":
		var kept []string
		for _, t := range d.vals {
			if !strings.EqualFold(t, "'none'") {
				kept = append(kept, t)
			}
		}
		has := TrustedTypesPolicy == ""
		for _, t := range kept {
			if t == TrustedTypesPolicy || t == "*" {
				has = true
			}
		}
		if !has {
			kept = append(kept, TrustedTypesPolicy)
		}
		return cspDirective{d.name, kept}, true
	case cspFetchDirectives[d.name]:
		vals := d.vals
		if isScriptOrStyleDirective(d.name) {
			hashed := false
			for _, t := range vals {
				if isHashSource(strings.ToLower(t)) {
					hashed = true
				}
			}
			if hashed {
				var kept []string
				for _, t := range vals {
					l := strings.ToLower(t)
					if isHashSource(l) || strings.HasPrefix(l, "'nonce-") || l == "'strict-dynamic'" {
						continue
					}
					kept = append(kept, t)
				}
				vals = appendIfAbsent(appendIfAbsent(kept, "'unsafe-inline'"), "'self'")
			}
		}
		if proxyOrigin != "" && !allowsNothing(vals) {
			vals = appendIfAbsent(vals, proxyOrigin)
		}
		if d.name == "connect-src" {
			vals = readableCSP(vals)
		}
		return cspDirective{d.name, vals}, true
	}
	return d, true
}

// allowsNothing: 'none', with nothing beside it but 'report-sample' (spec
// noneOnly; x.com's script-src-attr 'none' 'report-sample' — the proxy
// origin added made the browser ignore the 'none').
func allowsNothing(vals []string) bool {
	none := false
	for _, t := range vals {
		switch strings.ToLower(t) {
		case "'none'":
			none = true
		case "'report-sample'":
		default:
			return false
		}
	}
	return none
}

// readableCSP admits to a connect list what the runtime reads itself: a
// page's blob: or data: worker script, by an XHR the page does not make
// (spec readable). 'none' alone stays.
func readableCSP(vals []string) []string {
	if allowsNothing(vals) {
		return vals
	}
	return appendIfAbsent(appendIfAbsent(vals, "blob:"), "data:")
}

func showCSPPolicy(p []cspDirective, proxyOrigin string) string {
	var ds []string
	var def []string
	hasConnect, hasDefault := false, false
	for _, d := range p {
		if t, ok := translateCSPDirective(d, proxyOrigin); ok {
			ds = append(ds, strings.Join(append([]string{t.name}, t.vals...), " "))
			switch t.name {
			case "connect-src":
				hasConnect = true
			case "default-src":
				def, hasDefault = t.vals, true
			}
		}
	}
	// A default-src that governs connect gets an explicit connect-src
	// after it: its own list, readable (spec translatePolicy).
	if !hasConnect && hasDefault && !allowsNothing(def) {
		ds = append(ds, strings.Join(append([]string{"connect-src"}, readableCSP(append([]string(nil), def...))...), " "))
	}
	return strings.Join(ds, "; ")
}

// RewriteCSP translates a Content-Security-Policy (or -Report-Only) header
// value for the proxy (spec translateHeader).
func RewriteCSP(header, proxyOrigin string) string {
	var out []string
	for _, p := range parseCSPHeader(header) {
		out = append(out, showCSPPolicy(p, proxyOrigin))
	}
	return strings.Join(out, ", ")
}

// RewriteMetaCSP translates a <meta http-equiv="Content-Security-Policy">
// content: one policy, no comma list (spec translateMeta).
func RewriteMetaCSP(content, proxyOrigin string) string {
	return showCSPPolicy(parseCSPPolicy(content), proxyOrigin)
}

// governingScriptDirective is the directive that governs script elements:
// script-src-elem, else script-src, else default-src.
func governingScriptDirective(p []cspDirective) ([]string, bool) {
	for _, name := range []string{"script-src-elem", "script-src", "default-src"} {
		for _, d := range p {
			if d.name == name {
				return d.vals, true
			}
		}
	}
	return nil, false
}

// ScriptNonce is the nonce the bootstrap script needs under these policies
// (header values as the origin sent them; report-only ones are not
// passed), or "": the first nonce of the governing directive of the first
// policy that has one (spec scriptNonce).
func ScriptNonce(headers []string) string {
	for _, h := range headers {
		for _, p := range parseCSPHeader(h) {
			vals, ok := governingScriptDirective(p)
			if !ok {
				continue
			}
			for _, t := range vals {
				if l := strings.ToLower(t); strings.HasPrefix(l, "'nonce-") && strings.HasSuffix(t, "'") {
					return t[len("'nonce-") : len(t)-1]
				}
			}
		}
	}
	return ""
}

// InlineScriptAllowed reports whether every one of these policies (as the
// origin sent them) lets an inline <script> run once translated: the
// bootstrap's own inline script must be an external one otherwise. The
// governing directive must have 'unsafe-inline', a nonce (the bootstrap is
// given it) or a hash (translated to 'unsafe-inline') — appleid.apple.com
// and api.twitter.com list hosts alone (spec inlineScriptAllowed).
func InlineScriptAllowed(headers []string) bool {
	for _, h := range headers {
		for _, p := range parseCSPHeader(h) {
			vals, ok := governingScriptDirective(p)
			if !ok {
				continue
			}
			allowed := false
			for _, t := range vals {
				l := strings.ToLower(t)
				if l == "'unsafe-inline'" || strings.HasPrefix(l, "'nonce-") || isHashSource(l) {
					allowed = true
				}
			}
			if !allowed {
				return false
			}
		}
	}
	return true
}

// NoScriptsRun reports whether no page script runs at all under these
// policies (header values as sent; spec/Csp.agda noScriptsRun): some
// policy's element directive and some policy's attribute directive each
// allow nothing. Sound, not complete, across several policies. Such a
// document gets no runtime.
func NoScriptsRun(headers []string) bool {
	var pols [][]cspDirective
	for _, h := range headers {
		pols = append(pols, parseCSPHeader(h)...)
	}
	pick := func(p []cspDirective, names ...string) ([]string, bool) {
		for _, n := range names {
			for _, d := range p {
				if d.name == n {
					return d.vals, true
				}
			}
		}
		return nil, false
	}
	has := func(vs []string, f func(string) bool) bool {
		for _, v := range vs {
			if f(strings.ToLower(v)) {
				return true
			}
		}
		return false
	}
	nonceOrHash := func(l string) bool { return strings.HasPrefix(l, "'nonce-") || isHashSource(l) }
	noSource := func(l string) bool {
		switch l {
		case "'none'", "'unsafe-eval'", "'wasm-unsafe-eval'", "'report-sample'", "'unsafe-hashes'", "'inline-speculation-rules'":
			return true
		}
		return false
	}
	elemNothing := func(p []cspDirective) bool {
		vs, ok := pick(p, "script-src-elem", "script-src", "default-src")
		if !ok {
			return false
		}
		if has(vs, func(l string) bool { return l == "'strict-dynamic'" }) {
			return !has(vs, nonceOrHash) // only a nonce or a hash admits then
		}
		return !has(vs, func(l string) bool { return !noSource(l) })
	}
	attrNothing := func(p []cspDirective) bool {
		vs, ok := pick(p, "script-src-attr", "script-src", "default-src")
		if !ok {
			return false
		}
		inline := has(vs, func(l string) bool { return l == "'unsafe-inline'" }) &&
			!has(vs, func(l string) bool { return nonceOrHash(l) || l == "'strict-dynamic'" })
		hashes := has(vs, func(l string) bool { return l == "'unsafe-hashes'" }) && has(vs, isHashSource)
		return !inline && !hashes
	}
	// A sandbox directive without allow-scripts: nothing runs either.
	sandboxed := func(p []cspDirective) bool {
		for _, d := range p {
			if d.name == "sandbox" {
				return !has(d.vals, func(l string) bool { return l == "allow-scripts" })
			}
		}
		return false
	}
	elem, attr, sandbox := false, false, false
	for _, p := range pols {
		elem = elem || elemNothing(p)
		attr = attr || attrNothing(p)
		sandbox = sandbox || sandboxed(p)
	}
	return (elem && attr) || sandbox
}

// FrameAncestors is a CSP header value's frame-ancestors verdict for a
// document at self framed by an embedder at ancestor (URLs; spec/Csp.agda
// frameAncestors, checked against Chromium): present reports whether a
// policy of the header has the directive, allowed whether every policy that
// has it admits the embedder's origin.
func FrameAncestors(header, ancestor, self string) (present, allowed bool) {
	anc, ok1 := parseRef(nil, preprocess(ancestor))
	doc, ok2 := parseRef(nil, preprocess(self))
	allowed = true
	for _, p := range parseCSPHeader(header) {
		for _, d := range p {
			if d.name != "frame-ancestors" {
				continue
			}
			present = true
			admits := false
			if ok1 == parsedURL && ok2 == parsedURL {
				for _, src := range d.vals {
					if cspSourceMatch(doc, anc, src) {
						admits = true
						break
					}
				}
			}
			allowed = allowed && admits
		}
	}
	return present, present && allowed || !present
}

// WithFrameAncestors is header with every policy's frame-ancestors source
// list replaced by verdict ("'self'" or "'none'"), its other directives as
// they were (read as CSP3 reads them).
func WithFrameAncestors(header, verdict string) string {
	var out []string
	for _, p := range parseCSPHeader(header) {
		var ds []string
		for _, d := range p {
			vals := d.vals
			if d.name == "frame-ancestors" {
				vals = []string{verdict}
			}
			ds = append(ds, strings.Join(append([]string{d.name}, vals...), " "))
		}
		out = append(out, strings.Join(ds, "; "))
	}
	return strings.Join(out, ", ")
}

// cspPortOf is a canonical URL's explicit port ("" when the scheme's default).
func cspPortOf(u absURL) (string, bool) {
	rest := strings.TrimPrefix(hostPort(u.auth), hostOf(u))
	if strings.HasPrefix(rest, ":") {
		return rest[1:], true
	}
	return "", false
}

// cspSchemePartMatch: Chromium's scheme matching — a scheme admits itself,
// "http" admits "https", "ws" admits "wss".
func cspSchemePartMatch(a, b string) bool {
	return a == b || a == "http" && b == "https" || a == "ws" && b == "wss"
}

func isCSPSchemeChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'
}

func isAlphaByte(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

// cspSourceMatch: does the origin of u (its path "/") match the source
// expression, for a document at self (CSP3 §6.7.2.8, spec sourceMatch)?
func cspSourceMatch(self, u absURL, expr string) bool {
	e := asciiLower(expr)
	switch {
	case e == "*":
		return u.scheme == "http" || u.scheme == "https" || u.scheme == self.scheme
	case e == "'self'":
		return cspSelfMatch(self, u)
	}
	// scheme-source: "scheme:"
	if strings.HasSuffix(e, ":") && len(e) > 1 && isAlphaByte(e[0]) {
		body := e[:len(e)-1]
		okScheme := true
		for i := 0; i < len(body); i++ {
			if !isCSPSchemeChar(body[i]) {
				okScheme = false
			}
		}
		if okScheme {
			return cspSchemePartMatch(body, u.scheme)
		}
	}
	// host-source: [scheme "://"] host [":" port] [path]
	scheme, rest := "", e
	for i := 0; i < len(e); i++ {
		if strings.HasPrefix(e[i:], "://") {
			scheme, rest = e[:i], e[i+3:]
			break
		}
		if !isCSPSchemeChar(e[i]) {
			break
		}
	}
	if strings.HasPrefix(e, "://") {
		return false // empty scheme
	}
	hostEnd := strings.IndexAny(rest, ":/")
	host, tail := rest, ""
	if hostEnd >= 0 {
		host, tail = rest[:hostEnd], rest[hostEnd:]
	}
	if host == "" {
		return false
	}
	for i := 0; i < len(host); i++ {
		c := host[i]
		if !(isAlphaByte(c) || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '*') {
			return false
		}
	}
	port, hasPort, path := "", false, tail
	if strings.HasPrefix(tail, ":") {
		pp := tail[1:]
		if i := strings.IndexByte(pp, '/'); i >= 0 {
			port, path = pp[:i], pp[i:]
		} else {
			port, path = pp, ""
		}
		if port == "" {
			return false
		}
		if port != "*" {
			for i := 0; i < len(port); i++ {
				if port[i] < '0' || port[i] > '9' {
					return false
				}
			}
		}
		hasPort = true
	}
	if scheme != "" && !isAlphaByte(scheme[0]) {
		return false
	}
	// scheme
	if scheme != "" {
		if !cspSchemePartMatch(scheme, u.scheme) {
			return false
		}
	} else if !cspSchemePartMatch(self.scheme, u.scheme) {
		return false
	}
	// host
	uh := asciiLower(hostOf(u))
	switch {
	case host == "*":
	case strings.HasPrefix(host, "*"):
		if !strings.HasSuffix(uh, host[1:]) {
			return false
		}
	default:
		if host != uh {
			return false
		}
	}
	// port
	up, explicit := cspPortOf(u)
	if !hasPort {
		if explicit {
			return false
		}
	} else if port != "*" {
		// As numbers (spec digitsValue: unbounded): digits without leading zeros.
		want := strings.TrimLeft(port, "0")
		if explicit {
			if want != strings.TrimLeft(up, "0") {
				return false
			}
		} else if want != strconv.Itoa(defaultPort[u.scheme]) {
			return false
		}
	}
	// path: the origin's URL path is "/"
	return path == "" || path == "/"
}

func cspSelfMatch(self, u absURL) bool {
	if sameOriginURL(self, u) {
		return true
	}
	if asciiLower(hostOf(self)) != asciiLower(hostOf(u)) {
		return false
	}
	sp, se := cspPortOf(self)
	up, ue := cspPortOf(u)
	if se != ue || se && sp != up {
		return false
	}
	return u.scheme == "https" || u.scheme == "wss" || self.scheme == "http" && (u.scheme == "http" || u.scheme == "ws")
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// XFrameOptionsAllows is X-Frame-Options's verdict (HTML, spec/Csp.agda
// xfoAllows, checked against Chromium) for these field lines and an
// embedder that is or is not same-origin with the document: values split
// on ",", trimmed of space and tab, lowercased, as a set; more than one
// with deny, allowall or sameorigin among them blocks; "deny" blocks;
// "sameorigin" admits a same-origin embedder only; anything else admits.
func XFrameOptionsAllows(lines []string, sameOrigin bool) bool {
	var set []string
	for _, l := range lines {
		for _, v := range strings.Split(l, ",") {
			v = asciiLower(strings.Trim(v, " \t"))
			dup := false
			for _, x := range set {
				if x == v {
					dup = true
				}
			}
			if !dup {
				set = append(set, v)
			}
		}
	}
	has := func(k string) bool {
		for _, x := range set {
			if x == k {
				return true
			}
		}
		return false
	}
	switch {
	case len(set) == 0:
		return true
	case len(set) > 1:
		return !(has("deny") || has("allowall") || has("sameorigin"))
	case set[0] == "deny":
		return false
	case set[0] == "sameorigin":
		return sameOrigin
	}
	return true
}
