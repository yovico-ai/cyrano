package jsrewrite

import (
	"net/url"
	"strings"
	"testing"
)

// A bare module specifier is not a URL: it stays as written, for the
// page's import map (HTML, "resolve a module specifier").
func TestModuleSpecifiers_BareLeftAlone(t *testing.T) {
	base, _ := url.Parse("https://site.example/app/")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = func(u string, b *url.URL) string {
		r, err := b.Parse(u)
		if err != nil {
			return u
		}
		return "http://proxy/cyrano/" + r.Scheme + "/" + r.Host + r.Path
	}
	src := `import a from "react"; import b from "./local.js"; import c from "/abs.js"; import d from "https://cdn.example/x.js"; import("lodash"); import("../up.js");`
	got := string(Rewrite([]byte(src), opts))
	for _, want := range []string{`from "react"`, `import("lodash")`, `"http://proxy/cyrano/https/site.example/app/local.js"`, `"http://proxy/cyrano/https/site.example/abs.js"`, `"http://proxy/cyrano/https/cdn.example/x.js"`, `"http://proxy/cyrano/https/site.example/up.js"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in:\n%s", want, got)
		}
	}
}
