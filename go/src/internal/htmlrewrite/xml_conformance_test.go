package htmlrewrite

// Conformance of RewriteXML with spec/XmlDoc.agda, with the oracle's
// stand-in rewriters: what each part of a document is taken for, entities,
// places, the bootstrap, and when a document is left as sent.

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

// The oracle's stand-ins (spec/Oracle.agda xmlRwReq).
var xmlStandIns = XMLRewriters{
	URL:     func(d urlrewrite.Dest, v string) string { return "P" + string(d) + ":" + v },
	URLs:    func(s string) string { return "L(" + s + ")" },
	Srcset:  func(s string) string { return "S(" + s + ")" },
	CSSVal:  func(s string) string { return "V(" + s + ")" },
	CSSDecl: func(s string) string { return "D(" + s + ")" },
	CSS:     func(s string) string { return "C(" + s + ")" },
	JS:      func(s string) string { return "J(" + s + ")" },
	Sheet:   func(s string) string { return "Q" + s },
}

func xmlStandInBoot(ns XMLNs) string {
	switch ns {
	case XMLSvg:
		return "<B/>"
	case XMLXhtml:
		return "<H/>"
	}
	return ""
}

func TestSpecConformance_XmlDoc(t *testing.T) {
	oracle := specoracle.Need(t)
	prologs := []string{"", `<?xml version="1.0" encoding="UTF-8"?>`, `<?xml-stylesheet type="text/css" href="s.css"?>`,
		`<?xml-stylesheet href='a&amp;b.css' ?>`, `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">`,
		`<!DOCTYPE x [<!ENTITY e "v"> <!ATTLIST a b CDATA "]>">]>`, "<!-- c -->", "\n", `<?pi data?>`}
	roots := []string{`<svg xmlns="http://www.w3.org/2000/svg"`, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
		`<s:svg xmlns:s="http://www.w3.org/2000/svg" xmlns:l="http://www.w3.org/1999/xlink"`, `<html xmlns="http://www.w3.org/1999/xhtml"`,
		`<root`, `<svg`, `<p:svg`}
	rootAttrs := []string{"", ` onload="f()"`, ` style="fill:url(#a)"`, ` width='1'`, ` fill="url(x.svg#g)"`}
	kids := []string{`<image href="i.png"/>`, `<image xlink:href="i.png"/>`, `<image l:href='i.png'/>`, `<a href="h&amp;1&#x41;&#66;">x</a>`,
		`<style>a{b:url(c)}</style>`, `<style><![CDATA[x<y]]></style>`, `<script>if(a&lt;b)f()</script>`, `<script><![CDATA[a]]>b<![CDATA[c]]></script>`,
		`<script href="s.js"/>`, `<script xlink:href="s.js"></script>`, `<use href="#u"/>`, `<feImage href="f.png"/>`,
		`<foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="a.png" srcset="b 1x"/></foreignObject>`,
		`<link xmlns="http://www.w3.org/1999/xhtml" rel="preload" as="Script" href="p.js"/>`, `<a href="&nbsp;"/>`,
		`<g><![CDATA[not raw]]></g>`, `<g a="1"b="2"/>`, `<g a="<"/>`, `<g>text &amp; more</g>`, `</g>`, `<g`, `<!-- x -->`,
		`<s:a href="h"/>`, `<a ping="p q"/>`, `<a href="x" onclick="g()"/>`, `<rect style="x"></rect>`, `<q:x/>`, `<g>]]></g>`,
		`<style>a]]&gt;b</style>`, `<x xmlns="other"><img src="n"/></x>`,
		`<animate attributeName="href" values="a.svg; b.svg;"/>`, `<set attributeName="xlink:href" to="s.svg"/>`,
		`<set attributeName="clip-path" to="url(c.svg#c)"/>`, `<animate attributeName="x" values="1;2" from="u"/>`, `<set to="t.svg"/>`}
	rapid.Check(t, func(rt *rapid.T) {
		doc := rapid.SampledFrom(prologs).Draw(rt, "prolog") + rapid.SampledFrom(roots).Draw(rt, "root") + rapid.SampledFrom(rootAttrs).Draw(rt, "rootattrs")
		closing := ""
		if rapid.IntRange(0, 6).Draw(rt, "empty") == 0 {
			doc += "/>"
		} else {
			doc += ">"
			for _, k := range rapid.SliceOfN(rapid.SampledFrom(kids), 0, 4).Draw(rt, "kids") {
				doc += k
			}
			closing = rapid.SampledFrom([]string{"</svg>", "</s:svg>", "</html>", "</root>", "</p:svg>"}).Draw(rt, "close")
		}
		doc += closing + rapid.SampledFrom([]string{"", "\n", "<!-- t -->"}).Draw(rt, "trail")
		want, _, err := oracle.Ask("xmlrw", doc)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := RewriteXML(doc, xmlStandIns, xmlStandInBoot); got != want {
			rt.Fatalf("RewriteXML(%q)\n got  %q\n spec %q", doc, got, want)
		}
	})
}
