package proxy

import "github.com/yovico/cyrano/internal/urlrewrite"

// The CSP translation lives in urlrewrite (shared with <meta> policies in
// htmlrewrite).
func rewriteCSP(csp, proxyOrigin string) string { return urlrewrite.RewriteCSP(csp, proxyOrigin) }

// ScriptNonce: urlrewrite.ScriptNonce.
func ScriptNonce(policies []string) string { return urlrewrite.ScriptNonce(policies) }
