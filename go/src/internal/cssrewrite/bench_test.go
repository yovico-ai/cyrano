package cssrewrite

import (
	"strings"
	"testing"
)

// A large inline stylesheet that names a few URLs (a news front page's).
func BenchmarkRewriteText(b *testing.B) {
	css := strings.Repeat(".card__title{font:700 16px/1.2 cnn,Helvetica,sans-serif;color:#0c0c0c;margin:0 0 8px}\n.card__img{background:url(/media/sprite.png) no-repeat 0 -24px;width:24px}\n", 8000)
	b.SetBytes(int64(len(css)))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		RewriteText(css, func(u string) string { return "/cyrano/https/site.example" + u })
	}
}
