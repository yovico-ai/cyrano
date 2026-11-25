package htmlrewrite

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
)

func TestSpecConformance_XSLType(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, ty := range []string{"text/xsl", "TEXT/XSL", "text/xml", "application/xml", "application/xslt+xml", "text/css", "application/rss+xml", "application/atom+xml", "application/xhtml+xml", "", "text/html"} {
		want, _, err := oracle.Ask("xsltype", ty)
		if err != nil {
			t.Fatal(err)
		}
		if XSLType(ty) != (want == "yes") {
			t.Errorf("XSLType(%q) = %v, spec %s", ty, XSLType(ty), want)
		}
	}
	net, _, err := oracle.Ask("xslnet")
	if err != nil {
		t.Fatal(err)
	}
	if net != XSLNetPolicy {
		t.Errorf("XSLNetPolicy %q, spec %q", XSLNetPolicy, net)
	}
	for _, c := range []struct {
		doc  string
		want bool
	}{
		{`<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="/s.xsl"?><urlset/>`, true},
		{`<?xml version="1.0"?><?xml-stylesheet href="/s.css" type="text/css"?><urlset/>`, false},
		{`<?xml version="1.0"?><urlset/>`, false},
		{`<?xml-stylesheet type='application/xml' href='x'?><a/>`, true},
	} {
		if got := XSLTStyled([]byte(c.doc)); got != c.want {
			t.Errorf("XSLTStyled(%q) = %v", c.doc, got)
		}
	}
}
