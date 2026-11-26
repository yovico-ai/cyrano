package htmlrewrite

import (
	"bytes"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// An import map told to OnImportMap (its integrity, proxy.RecordImportMap)
// is still rewritten into the document: the tokenizer's text can be read
// once, and reading it for the hook left the browser an empty map.
func TestImportMapHookKeepsTheMap(t *testing.T) {
	base, _ := url.Parse("https://a.example/p")
	src := `<!doctype html><script type="importmap">{"imports":{"x":"/x.js"},"integrity":{"/x.js":"sha384-A"}}</script>`
	for _, hooked := range []bool{false, true} {
		var told string
		cfg := Config{BaseURL: base, Proxy: urlrewrite.ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "p:1"}}, NoOriginals: true}
		if hooked {
			cfg.OnImportMap = func(text, b string) { told = text + " @" + b }
		}
		var out bytes.Buffer
		if err := Rewrite(&out, strings.NewReader(src), cfg); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), `"x":"http://p:1/cyrano/https!js/a.example/x.js"`) || !strings.Contains(out.String(), `"integrity":{}`) {
			t.Errorf("hooked=%v: map written as %s", hooked, out.String())
		}
		if hooked && told != `{"imports":{"x":"/x.js"},"integrity":{"/x.js":"sha384-A"}} @https://a.example/p` {
			t.Errorf("told %q", told)
		}
	}
}
