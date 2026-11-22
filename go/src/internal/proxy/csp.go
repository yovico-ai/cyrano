package proxy

import (
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// The CSP translation lives in urlrewrite (shared with <meta> policies in
// htmlrewrite).
func rewriteCSP(csp, proxyOrigin string) string { return urlrewrite.RewriteCSP(csp, proxyOrigin) }

// ScriptNonce: urlrewrite.ScriptNonce.
func ScriptNonce(policies []string) string { return urlrewrite.ScriptNonce(policies) }

// sitesCSP (host mode, prototype): wherever the translated policy admits
// the proxy's origin, it admits every site's host too (TODO spec/Csp.agda:
// translate host-sources to their sites' hosts and paths instead).
func sitesCSP(csp string, cfg urlrewrite.ProxyConfig) string {
	if !cfg.Sites || cfg.PublicURL == nil {
		return csp
	}
	o := cfg.PublicURL.Scheme + "://" + cfg.PublicURL.Host
	w := cfg.PublicURL.Scheme + "://*." + cfg.PublicURL.Host
	ws := "ws"
	if cfg.PublicURL.Scheme == "https" {
		ws = "wss"
	}
	out := strings.ReplaceAll(" "+csp+" ", " "+o+" ", " "+o+" "+w+" ")
	out = strings.ReplaceAll(out, " "+ws+"://"+cfg.PublicURL.Host+" ", " "+ws+"://"+cfg.PublicURL.Host+" "+ws+"://*."+cfg.PublicURL.Host+" ")
	out = strings.ReplaceAll(out, " "+o+";", " "+o+" "+w+";")
	return strings.TrimSpace(out)
}
