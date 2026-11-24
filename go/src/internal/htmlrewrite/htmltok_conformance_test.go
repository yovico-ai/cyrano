package htmlrewrite

// Conformance of the server's token stream with spec/HtmlTok.agda, asked
// live: which start tags it reads and in which namespace, and where the
// bootstrap goes (TS: tests/spec/html-tok-conformance.test.ts; the spec
// against Chromium: html-tok-vs-chromium).

import (
	"bytes"
	"fmt"
	"io"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"golang.org/x/net/html"
	"pgregory.net/rapid"
)

// The pieces of tests/spec/html-gen.ts.
var (
	tokNames = strings.Fields("div p b i span a svg math mi mtext mglyph g foreignObject desc title annotation-xml style script textarea xmp noscript iframe noembed noframes font image img br circle ul li h1 em address pre listing form hr h3 H6 plaintext button section")
	tokEnds  = strings.Fields("p br svg math div b style script title textarea foreignObject desc mi annotation-xml noscript iframe xmp SCRIPT Style")
	tokAttrs = []string{"", ` x="a>b"`, ` y='<p data-i=0>'`, " z=<", " w=a/b", ` q=""`, " encoding=text/html", ` encoding="APPLICATION/XHTML+XML"`,
		" color=red", " face", ` style="c:d"`, " STYLE=e", " =f", ` "g"=h`, " k = 'l'", " m/n", " src=x"}
	tokText = []string{"x", " ", "\n", "<", "< b", "</", "</>", "</ x>", "<?php y>", "<!x>", "<![CDATA[", "]]>", "<svg><foreignObject><![CDATA[", "<math><mi><![CDATA[", "<!DOCTYPE x>", "-->",
		"<!--", "<!-->", "<!--->", "<!--a--!>", "--!>", "&lt;", `"`, "'", "<script>", "</script>", "</script ", "<!-- <script>",
		"</style>", "</title x>", "</textarea/>", "\t", "\r\n", "<a", "<1>", "<é>"}
)

func drawMarkup(rt *rapid.T) string {
	n := rapid.IntRange(1, 18).Draw(rt, "n")
	var b strings.Builder
	id := 1
	for k := 0; k < n; k++ {
		switch rapid.IntRange(0, 12).Draw(rt, "kind") {
		case 0, 1, 2, 3, 4:
			name := rapid.SampledFrom(tokNames).Draw(rt, "name")
			t := ""
			if name == "script" {
				t = " type=x"
			}
			sc := ""
			if rapid.Bool().Draw(rt, "self") {
				sc = "/"
			}
			fmt.Fprintf(&b, "<%s data-i=%d%s%s%s%s>", name, id, t, rapid.SampledFrom(tokAttrs).Draw(rt, "a"), rapid.SampledFrom(tokAttrs).Draw(rt, "b"), sc)
			id++
		case 5, 6, 7:
			fmt.Fprintf(&b, "</%s>", rapid.SampledFrom(tokEnds).Draw(rt, "end"))
		case 8:
			fmt.Fprintf(&b, "<!-- <b data-i=%d> -->", id)
			id++
		default:
			b.WriteString(rapid.SampledFrom(tokText).Draw(rt, "text"))
		}
	}
	return b.String()
}

// streamStartTags: the start tags the server reads, as the spec's htmltags.
func streamStartTags(doc string) string {
	st := newTokenStream(strings.NewReader(doc))
	var lines []string
	for {
		tt := st.z.Next()
		switch tt {
		case html.ErrorToken:
			return strings.Join(lines, "\n")
		case html.StartTagToken, html.SelfClosingTagToken:
			tok := st.z.Token()
			ns := st.startTag(tok, tt == html.SelfClosingTagToken)
			id, ok := getAttr(tok.Attr, "data-i")
			if !ok {
				id = "-"
			}
			name := ns.String()
			if st.ignored {
				name = "none" // a <form> inside an open form: no element
			}
			lines = append(lines, tok.Data+" "+name+" "+id)
		case html.EndTagToken:
			name, _ := st.z.TagName()
			st.endTag(string(name))
		}
	}
}

// The form element pointer (spec formIgnored): a <form> inside an open
// form makes no element — not inside a template, not in foreign content.
func TestSpecConformance_NestedForms(t *testing.T) {
	oracle := specoracle.Need(t)
	for m, ignores := range map[string]bool{
		`<form data-i=1><form data-i=2><b data-i=3></b></form><form data-i=4></form>`:                       true,
		`<p data-i=1><form data-i=2></p><form data-i=3><b data-i=4>`:                                        true,
		`<template data-i=1><form data-i=2><form data-i=3></form></template><form data-i=4><form data-i=5>`: true,
		`<form data-i=1><template data-i=2><form data-i=3></form></template></form><form data-i=4>`:         false,
		`<form data-i=1><svg data-i=2><form data-i=3></form></svg><form data-i=4>`:                          true,
		`</form><form data-i=1></form></form><form data-i=2>`:                                               false,
	} {
		want, _, err := oracle.Ask("htmltags", "1", m)
		if err != nil {
			t.Fatalf("oracle: %v", err)
		}
		if got := streamStartTags(m); got != want {
			t.Errorf("%q:\n got  %q\n spec %q", m, got, want)
		}
		if strings.Contains(want, " none ") != ignores {
			t.Errorf("%q: spec %q, ignored tag expected: %v", m, want, ignores)
		}
	}
}

func TestSpecConformance_StartTags(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		doc := drawMarkup(rt)
		want, _, err := oracle.Ask("htmltags", "1", doc)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := streamStartTags(doc); got != want {
			rt.Fatalf("%q:\n got  %q\n spec %q", doc, got, want)
		}
	})
}

var docPieces = []string{"<!doctype html>", `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">`, "<!--c-->", " ", "\n", "<html>", "<html lang=en>",
	"<head>", `<head x="<body>">`, "</head>", "<meta charset=utf-8>", "<title>t</title>", "<base href=/b/>", "<body>", "<body class=k>",
	"text", "<!-- <head> -->", "<link rel=x href=y>", "<style>p{}</style>", "<noscript><p>n</p></noscript>", "<template><p>t</p></template>",
	"<svg><title>s</title></svg>", "<frameset>", "<frame>", "</html>", "<p>", "<head/>", "<div>d</div>", "<script>s()</script>",
	"<svg><style><head></style></svg>", "<textarea><body></textarea>"}

// countStartTags: how many start tags the server's stream reads in doc.
func countStartTags(doc string) int {
	s := streamStartTags(doc)
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}

func TestSpecConformance_BootstrapPlace(t *testing.T) {
	oracle := specoracle.Need(t)
	const marker = "\x00BOOT\x00"
	base, _ := url.Parse("https://site.example/d/")
	rapid.Check(t, func(rt *rapid.T) {
		doc := strings.Join(rapid.SliceOfN(rapid.SampledFrom(docPieces), 0, 9).Draw(rt, "pieces"), "")
		want, _, err := oracle.Ask("bootat", marker, doc)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		cfg := Config{BaseURL: base, Proxy: urlrewrite.ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "p:1"}},
			NoOriginals: true, InjectBootstrap: true, bootstrapText: marker}
		var out bytes.Buffer
		if err := Rewrite(&out, strings.NewReader(doc), cfg); err != nil && err != io.EOF {
			rt.Fatal(err)
		}
		got := out.String()
		// The same place: as many start tags before it (the server writes
		// tags its own way, so the texts differ).
		wi, gi := strings.Index(want, marker), strings.Index(got, marker)
		if (wi < 0) != (gi < 0) || wi >= 0 && countStartTags(want[:wi]) != countStartTags(got[:gi]) {
			rt.Fatalf("%q:\n server %q\n spec   %q", doc, got, want)
		}
	})
}

// Bugs the spec found: foreign content is not raw text, so its URLs are
// rewritten; an SVG script's text is markup text.
func TestForeignContentIsMarkup(t *testing.T) {
	base, _ := url.Parse("https://site.example/d/")
	cfg := Config{BaseURL: base, Proxy: urlrewrite.ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "p:1"}}, NoOriginals: true,
		RewriteInlineJS: func(b []byte) []byte { return append([]byte("/*js*/"), b...) }}
	P := "http://p:1/cyrano/https/site.example/"
	for _, c := range []struct{ in, want string }{
		{`<svg><style><image href="/i.png"/></style></svg>`, `<svg><style><image href="` + P + `i.png" /></style></svg>`},
		{`<svg><title><a href="/t">t</a></title></svg>`, `<svg><title><a href="` + P + `t">t</a></title></svg>`},
		{`<math><style><img src="/m.png"></style></math>`, `<math><style><img src="` + P + `m.png"></style></math>`},
		{`<svg><![CDATA[<img src="/c.png">]]></svg>`, `<svg><![CDATA[<img src="/c.png">]]></svg>`},
		{`<style><img src="/s.png"></style>`, `<style><img src="/s.png"></style>`},
		{`<svg><script>a&lt;b</script></svg>`, `<svg><script>/*js*/a&lt;b</script></svg>`},
		{`<script>a&lt;b</script>`, `<script>/*js*/a&lt;b</script>`},
		// </foreignObject> while an HTML element is open is ignored (it stops
		// at no special element of its name): the <style> after it is HTML's,
		// raw text.
		{`<svg><foreignObject><b>x</foreignObject><style><img src="/f.png"></style></svg>`, `<svg><foreignObject><b>x</foreignObject><style><img src="/f.png"></style></svg>`},
	} {
		var out bytes.Buffer
		if err := Rewrite(&out, strings.NewReader(c.in), cfg); err != nil {
			t.Fatal(err)
		}
		if out.String() != c.want {
			t.Errorf("%s\n got  %s\n want %s", c.in, out.String(), c.want)
		}
	}
}
