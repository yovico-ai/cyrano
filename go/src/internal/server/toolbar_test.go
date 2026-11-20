package server

import (
	"net/url"
	"testing"

	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// The portal toolbar is handed to the runtime — with the portal's main
// page as its home — only when the vhost turns it on.
func TestClientPassthrough_Toolbar(t *testing.T) {
	pub, _ := url.Parse("https://vpn.example:8443")
	proxy := urlrewrite.ProxyConfig{PublicURL: pub}
	on := buildClientPassthrough(&config.VHost{RewriterJSPath: "/rewriter.js", Toolbar: true}, proxy)
	tb, ok := on["toolbar"].(map[string]any)
	if !ok || tb["home"] != "https://vpn.example:8443/" {
		t.Fatalf("toolbar on: %#v", on["toolbar"])
	}
	off := buildClientPassthrough(&config.VHost{RewriterJSPath: "/rewriter.js"}, proxy)
	if _, has := off["toolbar"]; has {
		t.Fatalf("toolbar off: %#v", off["toolbar"])
	}
}
