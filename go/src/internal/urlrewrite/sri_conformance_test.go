package urlrewrite

// Conformance of the SRI functions with spec/Sri.agda, and of an
// integrity-marked URL with spec/Containment.agda (rewriteUrlWithI,
// targetIntegrity; the spec against Chromium: sri-vs-chromium).

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

var sriTokens = []string{"sha256-AbC+/d=", "SHA384-xyz_-", "sha512-" + strings.Repeat("Q", 86), "sha256-", "sha1-abc", "md5-x", "sha256-a?opt", "sha384-ab=cd", "sha256-a*b",
	"sha384-" + strings.Repeat("B", 64) + "==", "nonsense", "", "sha512-a-b", "sha256-AAA="}

func TestSpecConformance_SRI(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		toks := rapid.SliceOfN(rapid.SampledFrom(sriTokens), 0, 4).Draw(rt, "tokens")
		md := strings.Join(toks, rapid.SampledFrom([]string{" ", "  ", "\t", "\n "}).Draw(rt, "sep"))
		want, has, err := oracle.Ask("srimark", md)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got, ok := SRIMark(md)
		if ok != has || (ok && got != want) {
			rt.Fatalf("SRIMark(%q) = %q %v, spec %q %v", md, got, ok, want, has)
		}
		if !ok {
			return
		}
		ds := map[string]string{
			"sha256": rapid.SampledFrom([]string{"AbC-_d", "a", "xyz"}).Draw(rt, "d256"),
			"sha384": rapid.SampledFrom([]string{"xyz_-", strings.Repeat("B", 64), "q"}).Draw(rt, "d384"),
			"sha512": rapid.SampledFrom([]string{strings.Repeat("Q", 86), "a-b", "z"}).Draw(rt, "d512"),
		}
		w, _, err := oracle.Ask("sripasses", got, ds["sha256"], ds["sha384"], ds["sha512"])
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if p := SRIPasses(got, func(a string) string { return ds[a] }); (w == "yes") != p {
			rt.Fatalf("SRIPasses(%q, %v) = %v, spec %s", got, ds, p, w)
		}
	})
}

func TestSpecConformance_SRIHonored(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		svg := rapid.Bool().Draw(rt, "svg")
		tag := rapid.SampledFrom([]string{"script", "link", "img", "iframe"}).Draw(rt, "tag")
		attr := rapid.SampledFrom([]string{"src", "href", "xlink:href"}).Draw(rt, "attr")
		rels := rapid.SliceOfN(rapid.SampledFrom([]string{"stylesheet", "preload", "modulepreload", "prefetch", "icon", "alternate"}), 0, 2).Draw(rt, "rels")
		sv := "0"
		if svg {
			sv = "1"
		}
		want, _, err := oracle.Ask("srihonored", sv, tag, attr, strings.Join(rels, " "))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := SRIHonored(svg, tag, attr, rels); got != (want == "yes") {
			rt.Fatalf("SRIHonored(%v, %s, %s, %v) = %v, spec %s", svg, tag, attr, rels, got, want)
		}
	})
}

// An element's integrity in its proxified URL: written as the spec writes
// it, read back by the proxy, ignored by unwrap.
func TestSpecConformance_RewriteMarkedIntegrity(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)
		pol := rapid.SampledFrom(append([]string{"-", "-"}, specoracle.Policies...)).Draw(rt, "policy")
		dest := rapid.SampledFrom([]string{"-", "js", "css", "jsc", "cssc"}).Draw(rt, "dest")
		im := rapid.SampledFrom([]string{"sha256-AbC-_d", "sha384-x.sha384-y", "sha512-" + strings.Repeat("Q", 86)}).Draw(rt, "integrity")
		want, _, err := oracle.Ask("rewritemarki", proxy, base, pol, dest, im, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		m := Mark{Integrity: im}
		if pol != "-" {
			m.Policy = Policy(pol)
		}
		if dest != "-" {
			m.Dest = Dest(dest)
		}
		got := RewriteMarked(raw, baseURL, proxyConfig(rt, proxy), m)
		if got != want {
			rt.Fatalf("RewriteMarked(%q, %+v) on %s = %q, spec says %q", raw, m, base, got, want)
		}
		// the proxy reads it back
		wi, has, err := oracle.Ask("targetintegrity", got)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		// the path as the request line carries it (the browser's escaping;
		// EscapedPath would re-escape a "!" next to an unescaped "{")
		rest := got
		if i := strings.Index(rest, "://"); i >= 0 {
			rest = rest[i+3:]
		}
		j := strings.IndexAny(rest, "/?#")
		if j < 0 || rest[j] != '/' {
			return
		}
		path := rest[j:]
		if k := strings.IndexAny(path, "?#"); k >= 0 {
			path = path[:k]
		}
		gi := TargetMark(path).Integrity
		if !has {
			wi = ""
		}
		if gi != wi {
			rt.Fatalf("TargetMark(%q).Integrity = %q, spec %q", got, gi, wi)
		}
	})
}

func TestSpecConformance_SRICarry(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		svg := rapid.Bool().Draw(rt, "svg")
		tag := rapid.SampledFrom([]string{"script", "link", "img", "iframe"}).Draw(rt, "tag")
		attr := rapid.SampledFrom([]string{"src", "href", "xlink:href"}).Draw(rt, "attr")
		rels := rapid.SliceOfN(rapid.SampledFrom([]string{"stylesheet", "preload", "modulepreload", "prefetch", "icon", "alternate"}), 0, 2).Draw(rt, "rels")
		mod := rapid.Bool().Draw(rt, "module")
		sv, m := "0", "0"
		if svg {
			sv = "1"
		}
		if mod {
			m = "1"
		}
		want, _, err := oracle.Ask("sricarry", sv, tag, attr, strings.Join(rels, " "), m)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := map[SRICarryKind]string{SRIUnchecked: "unchecked", SRIInURL: "url", SRIInDocument: "document"}[SRICarry(svg, tag, attr, rels, mod)]
		if got != want {
			rt.Fatalf("SRICarry(%v, %s, %s, %v, %v) = %s, spec %s", svg, tag, attr, rels, mod, got, want)
		}
	})
}
