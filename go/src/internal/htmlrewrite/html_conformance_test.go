package htmlrewrite

// Conformance with spec/Html.agda, asked live: the script kind and the
// document base URL.

import (
	"errors"
	"net/url"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

var (
	scriptTypes = []string{"", " ", "text/javascript", "TEXT/JAVASCRIPT", " text/javascript ", "text/javascript; charset=utf-8",
		"application/javascript", "text/javascript1.5", "text/jscript", "text/livescript", "module", " MODULE", "Module",
		"importmap", " importmap", "speculationrules", "application/json", "x", "javascript", "text/javascript\t", "\ftext/jscript"}
	scriptLangs = []string{"", "javascript", "JavaScript1.5", "jscript", "vbscript", " javascript", "module", "livescript "}
	baseHrefs   = []string{"", "/a/", "../b/", "https://other.example/c/", "//proto.example/d", "?q", "#f", "http://[::1/", "e/f",
		" /g/ ", "https://x.example:99999/", "HTTPS://Y.example/", "\t/h"}
)

func TestSpecConformance_ScriptKind(t *testing.T) {
	oracle := specoracle.Need(t)
	names := map[ScriptKind]string{ScriptClassic: "classic", ScriptModule: "module", ScriptImportMap: "importmap",
		ScriptSpeculationRules: "speculationrules", ScriptData: "data"}
	rapid.Check(t, func(rt *rapid.T) {
		hasType, hasLang := rapid.Bool().Draw(rt, "hasType"), rapid.Bool().Draw(rt, "hasLang")
		typ, lang := rapid.SampledFrom(scriptTypes).Draw(rt, "type"), rapid.SampledFrom(scriptLangs).Draw(rt, "lang")
		flag := func(b bool) string {
			if b {
				return "1"
			}
			return "0"
		}
		want, _, err := oracle.Ask("scriptkind", flag(hasType), typ, flag(hasLang), lang)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := names[ScriptKindFor(hasType, typ, hasLang, lang)]; got != want {
			rt.Fatalf("ScriptKindFor(%v %q, %v %q) = %s, spec says %s", hasType, typ, hasLang, lang, got, want)
		}
	})
}

func TestSpecConformance_DocumentBase(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		doc := rapid.SampledFrom([]string{"https://site.example/dir/page?q#f", "http://a.example/", "https://b.example:8443/x/y/"}).Draw(rt, "doc")
		href := rapid.SampledFrom(baseHrefs).Draw(rt, "href")
		want, _, err := oracle.Ask("docbase", doc, href)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		d, _ := url.Parse(doc)
		if got := urlrewrite.DocumentBase(d, href).String(); got != want {
			rt.Fatalf("DocumentBase(%q, %q) = %q, spec says %q", doc, href, got, want)
		}
	})
}
