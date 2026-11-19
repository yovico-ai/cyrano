package urlrewrite

import (
	"net/url"
	"strings"
	"testing"
)

func TestRewriteLinkHeaderAndRefresh(t *testing.T) {
	cfg := ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"}}
	base, _ := url.Parse("https://site.example/a/page")
	P := "http://localhost:9081/cyrano/https/"
	for _, c := range []struct{ in, want string }{
		{`<https://cdn.example/app.js>; rel=preload; as=script`, `<` + strings.Replace(P, "https/", "https!js/", 1) + `cdn.example/app.js>; rel=preload; as=script`},
		{`</s.css>; rel=preload; as=style, <img/x.png>; rel="preload"; title="a, <b>"`, `<` + strings.Replace(P, "https/", "https!css/", 1) + `site.example/s.css>; rel=preload; as=style, <` + P + `site.example/a/img/x.png>; rel="preload"; title="a, <b>"`},
		{`rel=preload`, `rel=preload`},
	} {
		if got := RewriteLinkHeader(c.in, base, cfg); got != c.want {
			t.Errorf("RewriteLinkHeader(%q)\n got  %q\n want %q", c.in, got, c.want)
		}
	}
	for _, c := range []struct{ in, want string }{
		{`5`, `5`},
		{`0; url=/next`, `0; url=` + P + `site.example/next`},
		{`0;URL='https://other.example/x'`, `0;URL='` + P + `other.example/x'`},
		{`3, "rel/y"`, `3, "` + P + `site.example/a/rel/y"`},
		{` 1.5 ;  url = z`, ` 1.5 ;  url = ` + P + `site.example/a/z`},
		{`soon`, `soon`},
	} {
		if got := RewriteRefresh(c.in, base, cfg); got != c.want {
			t.Errorf("RewriteRefresh(%q)\n got  %q\n want %q", c.in, got, c.want)
		}
	}
}

func TestRewriteLinkHeader_ImageSrcset(t *testing.T) {
	base, _ := url.Parse("https://site.example/dir/page")
	cfg := ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "proxy.example"}}
	in := `</a.jpg>; rel=preload; as=image; imagesrcset="a.jpg 1x, https://cdn.example/b.jpg 2x"; imagesizes="50vw", <x.css>; rel=preload; imagesrcset=c.jpg`
	want := `<http://proxy.example/cyrano/https/site.example/a.jpg>; rel=preload; as=image; imagesrcset="http://proxy.example/cyrano/https/site.example/dir/a.jpg 1x, http://proxy.example/cyrano/https/cdn.example/b.jpg 2x"; imagesizes="50vw", <http://proxy.example/cyrano/https/site.example/dir/x.css>; rel=preload; imagesrcset=http://proxy.example/cyrano/https/site.example/dir/c.jpg`
	if got := RewriteLinkHeader(in, base, cfg); got != want {
		t.Errorf("\n got  %s\n want %s", got, want)
	}
}
