package cssrewrite

import (
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Minified CSS writes @import with no space before the string
// (healthline.com's widget: `@import"https://fonts.googleapis.com/…"`).
func TestImportWithoutSpace(t *testing.T) {
	pub, _ := url.Parse("http://proxy.test")
	base, _ := url.Parse("https://site.test/")
	for _, in := range []string{`@import"https://fonts.test/a.css";`, `@import'https://fonts.test/a.css';`, `@IMPORT url(https://fonts.test/a.css);`} {
		out := string(Rewrite([]byte(in), Options{BaseURL: base, Proxy: urlrewrite.ProxyConfig{PublicURL: pub}}))
		if !strings.Contains(out, "proxy.test/cyrano/https/fonts.test/a.css") {
			t.Errorf("%s → %s", in, out)
		}
	}
}
