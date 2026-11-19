package urlrewrite

// Conformance of csp.go with spec/Csp.agda, asked live.

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

var (
	cspNames = []string{"default-src", "script-src", "Script-Src", "script-src-elem", "style-src", "style-src-attr",
		"img-src", "connect-src", "frame-src", "object-src", "worker-src", "font-src", "media-src", "child-src",
		"frame-ancestors", "base-uri", "form-action", "report-uri", "report-to", "trusted-types",
		"require-trusted-types-for", "upgrade-insecure-requests", "block-all-mixed-content", "sandbox",
		"foo-src", "navigate-to", "é-src"}
	cspValues = []string{"'self'", "'none'", "'NONE'", "'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'",
		"'nonce-abc'", "'Nonce-XyZ'", "'nonce-'", "'sha256-AAAA'", "'SHA384-bb'", "https:", "data:", "blob:", "*",
		"https://cdn.example", "*.example.com", "http://localhost:9081", "HTTP://LOCALHOST:9081", "/r", "'script'",
		"default", "allow-scripts", "_crnpolicy"}
	cspSpaces = []string{" ", "  ", "\t", "\n", "\f", "\r", "\v", " ", ""}
)

// drawPolicy draws a serialized policy; header values (noLF) hold no CR or
// LF (HTTP), a <meta> content may.
func drawPolicy(rt *rapid.T, label string, noLF bool) string {
	spaces := cspSpaces
	if noLF {
		spaces = []string{" ", "  ", "\t", "\f", "\v", "\u00a0", ""}
	}
	var b strings.Builder
	n := rapid.IntRange(0, 5).Draw(rt, label+"-n")
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(rapid.SampledFrom([]string{";", "; ", " ;", ";;", ", ", ","}).Draw(rt, label+"-sep"))
		}
		b.WriteString(rapid.SampledFrom(spaces).Draw(rt, label+"-lead"))
		b.WriteString(rapid.SampledFrom(cspNames).Draw(rt, label+"-name"))
		for j, m := 0, rapid.IntRange(0, 4).Draw(rt, label+"-m"); j < m; j++ {
			sp := rapid.SampledFrom(spaces).Draw(rt, label+"-sp")
			if sp == "" {
				sp = " "
			}
			b.WriteString(sp)
			b.WriteString(rapid.SampledFrom(cspValues).Draw(rt, label+"-val"))
		}
		b.WriteString(rapid.SampledFrom(spaces).Draw(rt, label+"-trail"))
	}
	return b.String()
}

func TestSpecConformance_CSP(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		v := drawPolicy(rt, "csp", false)
		proxy := rapid.SampledFrom([]string{"http://localhost:9081", "https://proxy.example", ""}).Draw(rt, "proxy")
		header, _ := ask(rt, oracle, "csp", "header", proxy, TrustedTypesPolicy, v)
		if got := RewriteCSP(v, proxy); got != header {
			rt.Fatalf("RewriteCSP(%q, %q) = %q; spec says %q", v, proxy, got, header)
		}
		meta, _ := ask(rt, oracle, "csp", "meta", proxy, TrustedTypesPolicy, v)
		if got := RewriteMetaCSP(v, proxy); got != meta {
			rt.Fatalf("RewriteMetaCSP(%q, %q) = %q; spec says %q", v, proxy, got, meta)
		}
	})
}

func TestSpecConformance_CSPBootstrap(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		var headers []string
		for i, n := 0, rapid.IntRange(0, 2).Draw(rt, "headers"); i < n; i++ {
			headers = append(headers, drawPolicy(rt, "h", true))
		}
		joined := strings.Join(headers, "\n")
		nonce, has := ask(rt, oracle, "cspnonce", joined)
		if !has {
			nonce = ""
		}
		if got := ScriptNonce(headers); got != nonce {
			rt.Fatalf("ScriptNonce(%q) = %q; spec says %q", headers, got, nonce)
		}
		inline, _ := ask(rt, oracle, "cspinline", joined)
		if got := InlineScriptAllowed(headers); got != (inline == "yes") {
			rt.Fatalf("InlineScriptAllowed(%q) = %v; spec says %s", headers, got, inline)
		}
	})
}

func TestSpecConformance_FrameAncestors(t *testing.T) {
	oracle := specoracle.Need(t)
	sources := []string{"'self'", "'none'", "*", "http:", "https:", "ws:", "wss:", "HTTPS:", "data:", "a.example", "*.example",
		"*.a.example", "https://a.example", "http://a.example", "https://a.example:443", "https://a.example:8443", "a.example:*",
		"https://a.example/", "https://a.example/x", "HTTPS://A.EXAMPLE", "doc.example", "https://*.example:*", "://a.example",
		"1a://a.example", "a.example:", "a.example:8x", "'unsafe-inline'", "*a.example", "https://a.example:0443", "*:*"}
	urls := []string{"https://a.example/", "http://a.example/", "https://a.example:8443/", "https://sub.a.example/",
		"https://doc.example/", "http://doc.example/", "https://b.example/", "wss://a.example/", "https://example/"}
	rapid.Check(t, func(rt *rapid.T) {
		var b strings.Builder
		for i, n := 0, rapid.IntRange(1, 2).Draw(rt, "policies"); i < n; i++ {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(rapid.SampledFrom([]string{"", "script-src *; "}).Draw(rt, "pre"))
			b.WriteString("frame-ancestors")
			for j, m := 0, rapid.IntRange(0, 3).Draw(rt, "m"); j < m; j++ {
				b.WriteString(" " + rapid.SampledFrom(sources).Draw(rt, "src"))
			}
		}
		header := b.String()
		anc := rapid.SampledFrom(urls).Draw(rt, "ancestor")
		self := rapid.SampledFrom(urls).Draw(rt, "self")
		want, has := ask(rt, oracle, "frameanc", header, anc, self)
		present, allowed := FrameAncestors(header, anc, self)
		if present != has || (has && allowed != (want == "allow")) {
			rt.Fatalf("FrameAncestors(%q, %q, %q) = %v,%v; spec says %q,%v", header, anc, self, present, allowed, want, has)
		}
	})
}

func TestSpecConformance_XFrameOptions(t *testing.T) {
	oracle := specoracle.Need(t)
	vals := []string{"DENY", "deny", " SameOrigin ", "SAMEORIGIN", "ALLOWALL", "ALLOW-FROM https://a", "bogus", "", "deny, sameorigin", "sameorigin,sameorigin", "\tdeny"}
	rapid.Check(t, func(rt *rapid.T) {
		lines := rapid.SliceOfN(rapid.SampledFrom(vals), 1, 3).Draw(rt, "lines")
		if len(lines) == 1 && lines[0] == "" {
			rt.Skip("a lone empty line: the oracle field cannot carry it")
		}
		same := rapid.Bool().Draw(rt, "same")
		so := "cross"
		if same {
			so = "same"
		}
		want, _ := ask(rt, oracle, "xfo", strings.Join(lines, "\n"), so)
		if got := XFrameOptionsAllows(lines, same); got != (want == "yes") {
			rt.Fatalf("XFrameOptionsAllows(%q, %v) = %v; spec says %s", lines, same, got, want)
		}
	})
}
