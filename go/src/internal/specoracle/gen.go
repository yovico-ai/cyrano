package specoracle

import (
	"strings"

	"pgregory.net/rapid"
)

// Generators for the conformance properties. They build strings from
// pieces chosen to sit on the rules' edges (case, default ports, dot
// segments, backslashes, percent-encoding, whitespace, the /cyrano/
// shape). The TS suite (ts/client/tests/spec/gen.ts) draws from the same
// pieces; keep the two lists alike so both runtimes face the same edges.

var (
	Proxies = []string{"http://localhost:9081", "https://proxy.example.com"}
	Bases   = []string{
		"https://example.com/p/", "https://example.com/p/q?x=1#h", "http://other.org/",
		"https://example.com", "https://example.com/a/b/c", "wss://socket.example.com/s",
	}
	schemeToks = []string{"http:", "https:", "HTTPS:", "Http:", "ws:", "wss:"}
	slashToks  = []string{"//", "//", "//", "///", `\\`, `/\`, "/", ""}
	userToks   = []string{"", "", "", "u@", "u:p@", "@"}
	hostToks   = []string{
		"example.com", "EXAMPLE.com", "a.b-c.org", "cdn.example.com", "localhost",
		"1.2.3.4", "x_y.com", "google.com", "proxy.example.com", ".", "..",
	}
	oddHosts = []string{
		"[::1]", "0x7f.1", "%41.com", "exämple.com", "1.2.3", "",
		"{x}", "a`\"b", "%7Bx%7D", "%2541.com", "a%3Ab", "1.2.3.%34", "%C3%A9.com", "xn--a.com", "xn--9ca.com", "%", "%zz",
		"[1:0:0:2::3]", "[::ffff:1.2.3.4]", "[ABCD::EF]", "[::]", "0x7f.0.0.1", "4294967295", "1.2.3.4.", "[::1%251]", "08.1", "[1::2::3]",
	}
	portToks = []string{"", "", "", ":80", ":443", ":0080", ":8080", ":9081", ":", ":99999", ":x"}
	segToks  = []string{
		"a", "b", "index.html", ".", "..", "%2e", "%2E%2e", "a b", "é", "a%2Fb",
		"cyrano", "https", "q,w", "{x}", "`", `"`, "<>", "'", "^|", "", "日本", "😀",
	}
	queryToks = []string{"", "", "?", "?q=1", "?q=1 2", "?a='b'", "?é", "?%20", "?x=`{}`"}
	fragToks  = []string{"", "", "#", "#x", "#x y", "#x%20y", "#é", "#`", "#a#b", `#"q"`}
	padToks   = []string{"", "", "", " ", "\t", "\n", " \x01", "\r\n"}
	otherToks = []string{
		"javascript:void(0)", "JavaScript:x", "java\nscript:x", "data:image/png;base64,AA",
		"blob:https://x/1", "mailto:a@b", "tel:+1", "about:blank", "ftp://h/x", "c:foo",
		"localhost:9081/x", "#top", "#", "", "   ",
	}
	cyranoSchemes = []string{"http", "https", "ws", "wss", "ftp", "x", "", "HTTPS"}
	cyranoHosts   = []string{"example.com", "H.com:443", "a.b:8080", ""}
)

func pick(xs []string) *rapid.Generator[string] { return rapid.SampledFrom(xs) }

func path(t *rapid.T) string {
	n := rapid.IntRange(0, 4).Draw(t, "segments")
	var b strings.Builder
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(pick([]string{"/", "/", `\`}).Draw(t, "sep"))
		}
		b.WriteString(pick(segToks).Draw(t, "seg"))
	}
	return b.String()
}

func host(t *rapid.T) string {
	if rapid.IntRange(0, 4).Draw(t, "odd") == 0 {
		return pick(oddHosts).Draw(t, "host")
	}
	return pick(hostToks).Draw(t, "host")
}

func qf(t *rapid.T) string {
	return pick(queryToks).Draw(t, "query") + pick(fragToks).Draw(t, "frag")
}

// URL draws a URL as it might appear in a page.
func URL(t *rapid.T, proxy string) string {
	var u string
	switch rapid.IntRange(0, 8).Draw(t, "form") {
	case 0, 1: // absolute
		u = pick(schemeToks).Draw(t, "scheme") + pick(slashToks).Draw(t, "slashes") +
			pick(userToks).Draw(t, "user") + host(t) + pick(portToks).Draw(t, "port") +
			"/" + path(t) + qf(t)
	case 2: // scheme-relative
		u = pick([]string{"//", `\\`, "///"}).Draw(t, "slashes") + host(t) +
			pick(portToks).Draw(t, "port") + "/" + path(t) + qf(t)
	case 3: // path-absolute
		u = "/" + path(t) + qf(t)
	case 4: // path-relative or query-only
		u = path(t) + qf(t)
	case 5: // not proxified, or nothing to rewrite
		u = pick(otherToks).Draw(t, "other")
	case 6: // on the proxy
		u = proxy + pick([]string{"/cyrano/https/example.com/a", "/other", "/cyrano", "/cyrano/", "/cyrano/x/h/y"}).Draw(t, "proxyPath") + qf(t)
	default: // a /cyrano/ path on a foreign origin
		u = "https://" + host(t) + "/cyrano/" + pick(cyranoSchemes).Draw(t, "cs") + "/" +
			pick(cyranoHosts).Draw(t, "ch") + "/" + path(t) + qf(t)
	}
	return pick(padToks).Draw(t, "pre") + u + pick(padToks).Draw(t, "post")
}

// ProxiedHref draws what page code might read back from location.href
// and the like.
func ProxiedHref(t *rapid.T, proxy string) string {
	switch rapid.IntRange(0, 5).Draw(t, "form") {
	case 0, 1, 2:
		return proxy + "/cyrano/" + pick(cyranoSchemes).Draw(t, "cs") + "/" +
			pick(cyranoHosts).Draw(t, "ch") + pick([]string{"", "/"}).Draw(t, "slash") + path(t) + qf(t)
	case 3:
		return proxy + "/" + path(t) + qf(t)
	case 4:
		return "https://" + host(t) + "/cyrano/https/example.com/" + path(t) + qf(t)
	default:
		return pick([]string{"about:blank", "not a url", "", "javascript:x", "/cyrano/https/h/x"}).Draw(t, "other")
	}
}

var (
	srcURLs  = []string{"a.jpg", "b.png", "/cdn-cgi/image/w=640,q=75/x.jpg", "https://x.com/y.jpg", "a,b.jpg", "img.jpg,", "c.jpg,,", "(p).jpg"}
	srcDescs = []string{"", "", "1x", "2x", "640w", "1x  foo", "(a, b)", "1.5x", "1x (c"}
	srcWS    = []string{" ", " ", "\t", "\n", "\f", "\v", "  ", "\r"}
	srcSeps  = []string{",", ", ", " ,", ",,", " , ", ",\n"}
)

// Srcset draws a srcset attribute value.
func Srcset(t *rapid.T) string {
	n := rapid.IntRange(0, 4).Draw(t, "candidates")
	var b strings.Builder
	b.WriteString(pick([]string{"", "", " ", ",", "\n "}).Draw(t, "lead"))
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(pick(srcSeps).Draw(t, "sep"))
		}
		b.WriteString(pick(srcURLs).Draw(t, "url"))
		if d := pick(srcDescs).Draw(t, "desc"); d != "" {
			b.WriteString(pick(srcWS).Draw(t, "ws") + d)
		}
	}
	b.WriteString(pick([]string{"", "", " ", ",", "\t"}).Draw(t, "trail"))
	return b.String()
}
