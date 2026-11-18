package htmlrewrite

import "github.com/yovico/cyrano/internal/urlrewrite"

// rewriteSrcset: urlrewrite.RewriteSrcset (shared with the Link header).
func rewriteSrcset(srcset string, rewriteURL func(string) string) string {
	return urlrewrite.RewriteSrcset(srcset, rewriteURL)
}
