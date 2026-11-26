package htmlrewrite

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

// An XSLT stylesheet's own loads proxified (spec XmlDoc.rewriteXsl), with
// the oracle's stand-in URL rewriter ("P" before the URL).
func TestSpecConformance_RewriteXSL(t *testing.T) {
	oracle := specoracle.Need(t)
	parts := []string{
		`<x:stylesheet xmlns:x="http://www.w3.org/1999/XSL/Transform" version="1.0">`, `</x:stylesheet>`,
		`<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform">`, `</xsl:stylesheet>`,
		`<x:import href="a.xsl"/>`, `<x:include href='/b.xsl'/>`, `<xsl:import href="https://o.example/c.xsl"/>`,
		`<x:value-of select="document('d.xml')/r"/>`, `<x:for-each select='count(document("e.xml"))'/>`,
		`<x:value-of select="mydocument('n')"/>`, `<x:value-of select="document ( 'sp' )"/>`, `<x:value-of select="document('open"/>`,
		`<x:copy-of select="document($v)"/>`, `<img src="i.png" title="document('lit')"/>`, `<x:value-of select="document(&apos;q&apos;)"/>`,
		`<r xmlns="http://www.w3.org/1999/XSL/Transform"><import href="z"/></r>`, `<p:a/>`, `<x:t a="&nbsp;"/>`, "<!-- c -->", "text",
	}
	rapid.Check(t, func(rt *rapid.T) {
		s := strings.Join(rapid.SliceOfN(rapid.SampledFrom(parts), 1, 8).Draw(rt, "parts"), "")
		want, _, err := oracle.Ask("xslrw", s)
		if err != nil {
			rt.Fatal(err)
		}
		if got := RewriteXSL(s, func(u string) string { return "P" + u }); got != want {
			rt.Fatalf("RewriteXSL(%q) = %q; spec says %q", s, got, want)
		}
	})
}
