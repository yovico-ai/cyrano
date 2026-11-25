package urlrewrite

// Conformance with the Agda spec (spec/Containment.agda), asked live:
// the generators draw URLs, the compiled spec says what each must
// become, and Rewrite / Unwrap must agree byte for byte. `make
// spec-check` runs these with the oracle required; plain `go test`
// skips them, with a note, when it has not been built.

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	schemes := make([]string, 0, len(resolvableSchemes))
	for s := range resolvableSchemes {
		schemes = append(schemes, strings.TrimSuffix(s, ":"))
	}
	specoracle.Main(m, schemes)
}

func proxyConfig(t *rapid.T, proxy string) ProxyConfig {
	u, err := url.Parse(proxy)
	if err != nil {
		t.Fatalf("proxy %q: %v", proxy, err)
	}
	return ProxyConfig{PublicURL: u}
}

func TestSpecConformance_Rewrite(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)

		want, err := oracle.Rewrite(proxy, base, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, err := url.Parse(base)
		if err != nil {
			rt.Fatalf("base %q: %v", base, err)
		}
		if got := Rewrite(raw, baseURL, proxyConfig(rt, proxy)); got != want.Out {
			rt.Fatalf("Rewrite(%q) on %s = %q, spec says %q (%s)", raw, base, got, want.Out, want.Kind)
		}
	})
}

func TestSpecConformance_Unwrap(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		href := specoracle.ProxiedHref(rt, proxy)

		want, err := oracle.Unwrap(proxy, href)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := Unwrap(href, proxyConfig(rt, proxy)); got != want.Out {
			rt.Fatalf("Unwrap(%q) = %q, spec says %q (%s)", href, got, want.Out, want.Kind)
		}
	})
}

// The fundamental principle (REQUIREMENTS.md), for URLs: what page code
// reads back for a URL it wrote is what it would be shown without
// cyrano — Unwrap(Rewrite(raw)) is the browser's own href.
func TestSpecConformance_PageCannotTell(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)

		rw, err := oracle.Rewrite(proxy, base, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if rw.Kind != "proxified" {
			rt.Skip("not proxified")
		}
		want, err := oracle.Direct(base, raw)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, err := url.Parse(base)
		if err != nil {
			rt.Fatalf("base %q: %v", base, err)
		}
		cfg := proxyConfig(rt, proxy)
		if got := Unwrap(Rewrite(raw, baseURL, cfg), cfg); got != want.Out {
			rt.Fatalf("Unwrap(Rewrite(%q)) on %s = %q, the browser shows %q", raw, base, got, want.Out)
		}
	})
}

// The same principle seen from the upstream: the request the server
// forwards for a proxified URL is the one the browser would send
// directly — scheme, host, escaped path and query byte for byte (a bare
// "?" included), and neither userinfo nor fragment, which a browser never
// puts on the wire.
func TestSpecConformance_UpstreamCannotTell(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)

		rw, err := oracle.Rewrite(proxy, base, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if rw.Kind != "proxified" {
			rt.Skip("not proxified")
		}
		want, err := oracle.Direct(base, raw)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		wire := onTheWire(want.Out)

		// What the server receives: the proxified URL as an HTTP request.
		req, err := url.Parse(rw.Out)
		if err != nil {
			rt.Fatalf("proxified %q does not parse: %v", rw.Out, err)
		}
		target, ok := ParseCyranoURL(req)
		if !ok {
			rt.Fatalf("ParseCyranoURL(%q) rejected a proxified URL", rw.Out)
		}
		// Known gap (CLAUDE.md): a path starting "//" cannot go on the wire as
		// URL.Opaque, so net/url re-escapes it ("^" as %5E).
		if UpstreamPath(target) == "" && target.EscapedPath() != target.RawPath {
			rt.Skip("known gap: //-path re-escaped by net/url")
		}
		// As the proxy Director writes it (proxy/handler.go makeDirector).
		out := *target
		out.User = nil
		if p := UpstreamPath(target); p != "" {
			out.Opaque = p
		}
		if got := out.Scheme + "://" + out.Host + out.RequestURI(); got != wire {
			rt.Fatalf("raw %q on %s: upstream gets %q, the browser would send %q", raw, base, got, wire)
		}
	})
}

// onTheWire is what a browser sends for an href: no userinfo, no fragment.
func onTheWire(href string) string {
	if i := strings.IndexByte(href, '#'); i >= 0 {
		href = href[:i]
	}
	scheme, rest, _ := strings.Cut(href, "://")
	end := strings.IndexByte(rest, '/')
	if end < 0 {
		end = len(rest)
	}
	return scheme + "://" + hostPort(rest[:end]) + rest[end:]
}

// A request made under its own referrer policy: the proxified URL carries
// it (spec rewriteUrlWith), and the proxy reads it back (targetPolicy).
func TestSpecConformance_RewriteWithPolicy(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)
		pol := rapid.SampledFrom(specoracle.Policies).Draw(rt, "policy")
		want, _, err := oracle.Ask("rewritewith", proxy, base, pol, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, err := url.Parse(base)
		if err != nil {
			rt.Fatalf("base %q: %v", base, err)
		}
		got := RewriteWithPolicy(raw, baseURL, proxyConfig(rt, proxy), Policy(pol))
		if got != want {
			rt.Fatalf("RewriteWithPolicy(%q, %s) on %s = %q, spec says %q", raw, pol, base, got, want)
		}
	})
}

// A script's or stylesheet's URL: the proxified URL says so (spec
// rewriteUrlWith with a destination mark), and the proxy reads it back
// (targetDest); unwrap ignores it (Unwrap is checked on ProxiedHref,
// which draws marked segments).
func TestSpecConformance_RewriteMarked(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)
		pol := rapid.SampledFrom(append([]string{"-", "-"}, specoracle.Policies...)).Draw(rt, "policy")
		dest := rapid.SampledFrom([]string{"-", "js", "css", "frame", "inert", "set", "mjs", "cred", "jsc", "cssc", "anon"}).Draw(rt, "dest")
		want, _, err := oracle.Ask("rewritemark", proxy, base, pol, dest, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		m := Mark{}
		if pol != "-" {
			m.Policy = Policy(pol)
		}
		if dest != "-" {
			m.Dest = Dest(dest)
		}
		if got := RewriteMarked(raw, baseURL, proxyConfig(rt, proxy), m); got != want {
			rt.Fatalf("RewriteMarked(%q, %+v) on %s = %q, spec says %q", raw, m, base, got, want)
		}
	})
}

func TestSpecConformance_TargetDest(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		href := specoracle.ProxiedHref(rt, proxy)
		want, has, err := oracle.Ask("targetdest", href)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if !has {
			want = ""
		}
		a, res := parseRef(nil, preprocess(href))
		got := ""
		if res == parsedURL && a.scheme+"://"+hostPort(a.auth) == proxy {
			got = string(TargetDest(pathText(a.path)))
		}
		if got != want {
			rt.Fatalf("TargetDest(%q) = %q, spec says %q", href, got, want)
		}
	})
}

func TestSpecConformance_TargetPolicy(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		href := specoracle.ProxiedHref(rt, proxy)
		want, has, err := oracle.Ask("targetpolicy", href)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if !has {
			want = ""
		}
		a, res := parseRef(nil, preprocess(href))
		got := ""
		if res == parsedURL && a.scheme+"://"+hostPort(a.auth) == proxy {
			got = string(TargetPolicy(pathText(a.path)))
		}
		if got != want {
			rt.Fatalf("TargetPolicy(%q) = %q, spec says %q", href, got, want)
		}
	})
}

var importMapPieces = []string{"{", "}", "[", "]", ":", ",", " ", "\n", `"imports"`, `"scopes"`, `"integrity"`, `"react"`, `"./a.js"`,
	`"/b/"`, `"https://cdn.example/c.js"`, `"../d"`, `"lodash/"`, `"http:"`, `"foo:bar"`, `"é.js"`, `"\ud800"`, `"x\"y"`, "1", "null",
	"true", `"sha384-abc"`, `"\/e.js"`, `" /f.js"`}

func drawImportMap(rt *rapid.T) string {
	switch rapid.IntRange(0, 2).Draw(rt, "shape") {
	case 0:
		return strings.Join(rapid.SliceOfN(rapid.SampledFrom(importMapPieces), 0, 14).Draw(rt, "pieces"), "")
	case 1:
		k := rapid.SampledFrom([]string{`"react"`, `"./a.js"`, `"/b/"`, `"https://cdn.example/c.js"`, `"lodash/"`, `" /f.js"`}).Draw(rt, "k")
		v := rapid.SampledFrom([]string{`"./x.js"`, `"/y.js"`, `"https://cdn.example/z.js"`, `"bare"`, "null", "3"}).Draw(rt, "v")
		return `{"imports":{` + k + ":" + v + `},"scopes":{"/s/":{` + k + ":" + v + `}},"integrity":{` + v + `:"sha"}}`
	default:
		return `{"imports":` + strings.Join(rapid.SliceOfN(rapid.SampledFrom(importMapPieces), 0, 10).Draw(rt, "inner"), "") + "}"
	}
}

func TestSpecConformance_ImportMap(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		text := drawImportMap(rt)
		want, _, err := oracle.Ask("importmap", proxy, base, text)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		if got := string(RewriteImportMap([]byte(text), baseURL, proxyConfig(rt, proxy))); got != want {
			rt.Fatalf("RewriteImportMap(%q) on %s = %q, spec says %q", text, base, got, want)
		}
		// scope prefixes twice, in the document's form too (spec rewriteImportMapT)
		if rapid.Bool().Draw(rt, "scoped") {
			text = `{"scopes":{` + rapid.SampledFrom([]string{`"/"`, `"/s/"`, `"https://cdn.example/"`, `"./"`}).Draw(rt, "sk") + rapid.SampledFrom([]string{":", " : "}).Draw(rt, "c") +
				rapid.SampledFrom([]string{`{"a":"/a.js"}`, `{ "a" : "./a.js" , "b":"bare"}`, `"x"`, `[1]`, `{}`}).Draw(rt, "sv") + rapid.SampledFrom([]string{"", ` ,"/t/":{}`}).Draw(rt, "more") + `}}`
		}
		pol := rapid.SampledFrom([]string{"-", "-", "origin", "no-referrer"}).Draw(rt, "dpol")
		dd := rapid.SampledFrom([]string{"-", "-", "frame", "inert"}).Draw(rt, "ddest")
		want2, _, err := oracle.Ask("importmap", proxy, base, pol, dd, text)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		doc := Mark{}
		if pol != "-" {
			doc.Policy = Policy(pol)
		}
		if dd != "-" {
			doc.Dest = Dest(dd)
		}
		cfg := proxyConfig(rt, proxy)
		got2 := RewriteImportMapTwin(text, func(u string) string { return RewriteDest(u, baseURL, cfg, DestScript) },
			func(u string) string { return RewriteMarked(u, baseURL, cfg, doc) })
		if got2 != want2 {
			rt.Fatalf("RewriteImportMapTwin(%q, %+v) on %s = %q, spec says %q", text, doc, base, got2, want2)
		}
		s := rapid.SampledFrom([]string{"react", "/x", "./x", "../x", "https://a/", "foo:bar", "http:", "x/y", " https://a/", "a:", "1a:b", "data:,x"}).Draw(rt, "spec")
		ul, _, _ := oracle.Ask("urllike", s)
		if got := IsURLLikeSpecifier(s); got != (ul == "yes") {
			rt.Fatalf("IsURLLikeSpecifier(%q) = %v, spec says %s", s, got, ul)
		}
	})
}
