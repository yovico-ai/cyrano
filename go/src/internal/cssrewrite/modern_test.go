package cssrewrite

import (
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Modern CSS must come through byte for byte, apart from its URLs:
// x.com's Tailwind stylesheet went from 3,716 rules to 399 when a debug
// formatter re-spaced it. The rewriter touches url() and @import only.
func TestRewrite_ModernCSSUntouchedExceptURLs(t *testing.T) {
	base, _ := url.Parse("https://cdn.example/assets/styles.css")
	opts := Options{BaseURL: base, Proxy: urlrewrite.ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"}}}
	plain := `/*! tailwindcss v4 */@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-rotate-x:initial}}}` +
		`@layer theme{:root,:host{--font-sans:ui-sans-serif,system-ui;--spacing:.25rem}}` +
		`.min-h-\(--x-page-height\){min-height:var(--x-page-height)}.max-w-\[400px\]{max-width:400px}.md\:ps-9{@media (width>=48rem){padding-inline-start:calc(var(--spacing)*9)}}` +
		`.dark\:\[stop-color\:\#ffffff\]:where(.dark,.dark *){stop-color:#fff}@property --tw-rotate-x{syntax:"*";inherits:false}` +
		`.a{color:color-mix(in oklab,var(--c) 50%,transparent);&:hover{color:red}}`
	if got := string(Rewrite([]byte(plain), opts)); got != plain {
		t.Errorf("CSS without URLs changed:\n got  %s\n want %s", got, plain)
	}
	withURL := plain + `.b{background:url(img/x.png)}`
	got := string(Rewrite([]byte(withURL), opts))
	if !strings.HasPrefix(got, plain) || !strings.Contains(got, "http://localhost:9081/cyrano/https/cdn.example/assets/img/x.png") {
		t.Errorf("only the url() should change:\n got %s", got)
	}
}
