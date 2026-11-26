// @vitest-environment node
//
// Conformance of the runtime's XML rewriter (src/xml/rewriter.ts, a port of
// Go htmlrewrite/xml.go) with spec/XmlDoc.agda, with the oracle's stand-in
// rewriters — the same generator as Go's TestSpecConformance_XmlDoc.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteXml, rewriteXsl, type XmlNs, type XmlRewriters } from "../../src/xml/rewriter";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

// The oracle's stand-ins (spec/Oracle.agda xmlRwReq).
const standIns: XmlRewriters = {
    url: (d, v) => "P" + (d ?? "") + ":" + v,
    urls: (s) => "L(" + s + ")",
    srcset: (s) => "S(" + s + ")",
    cssVal: (s) => "V(" + s + ")",
    cssDecl: (s) => "D(" + s + ")",
    css: (s) => "C(" + s + ")",
    js: (s) => "J(" + s + ")",
    sheet: (s) => "Q" + s,
};
const boot = (ns: XmlNs): string => (ns === "svg" ? "<B/>" : ns === "xhtml" ? "<H/>" : "");

const prologs = ["", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>", "<?xml-stylesheet type=\"text/css\" href=\"s.css\"?>", "<?xml-stylesheet href='a&amp;b.css' ?>", "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">", "<!DOCTYPE x [<!ENTITY e \"v\"> <!ATTLIST a b CDATA \"]>\">]>", "<!-- c -->", "\n", "<?pi data?>"];
const roots = ["<svg xmlns=\"http://www.w3.org/2000/svg\"", "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"", "<s:svg xmlns:s=\"http://www.w3.org/2000/svg\" xmlns:l=\"http://www.w3.org/1999/xlink\"", "<html xmlns=\"http://www.w3.org/1999/xhtml\"", "<root", "<svg", "<p:svg"];
const rootAttrs = ["", " onload=\"f()\"", " style=\"fill:url(#a)\"", " width='1'", " fill=\"url(x.svg#g)\""];
const kids = ["<image href=\"i.png\"/>", "<image xlink:href=\"i.png\"/>", "<image l:href='i.png'/>", "<a href=\"h&amp;1&#x41;&#66;\">x</a>", "<style>a{b:url(c)}</style>", "<style><![CDATA[x<y]]></style>", "<script>if(a&lt;b)f()</script>", "<script><![CDATA[a]]>b<![CDATA[c]]></script>", "<script href=\"s.js\"/>", "<script xlink:href=\"s.js\"></script>", "<use href=\"#u\"/>", "<feImage href=\"f.png\"/>", "<foreignObject><img xmlns=\"http://www.w3.org/1999/xhtml\" src=\"a.png\" srcset=\"b 1x\"/></foreignObject>", "<link xmlns=\"http://www.w3.org/1999/xhtml\" rel=\"preload\" as=\"Script\" href=\"p.js\"/>", "<a href=\"&nbsp;\"/>", "<g><![CDATA[not raw]]></g>", "<g a=\"1\"b=\"2\"/>", "<g a=\"<\"/>", "<g>text &amp; more</g>", "</g>", "<g", "<!-- x -->", "<s:a href=\"h\"/>", "<a ping=\"p q\"/>", "<a href=\"x\" onclick=\"g()\"/>", "<rect style=\"x\"></rect>", "<q:x/>", "<g>]]></g>", "<style>a]]&gt;b</style>", "<x xmlns=\"other\"><img src=\"n\"/></x>", "<animate attributeName=\"href\" values=\"a.svg; b.svg;\"/>", "<set attributeName=\"xlink:href\" to=\"s.svg\"/>", "<set attributeName=\"clip-path\" to=\"url(c.svg#c)\"/>", "<animate attributeName=\"x\" values=\"1;2\" from=\"u\"/>", "<set to=\"t.svg\"/>"];

describe.skipIf(located.skip !== "")("the XML rewriter: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("rewriteXml is XmlDoc.rewriteXml", async () => {
        const doc = fc.tuple(fc.constantFrom(...prologs), fc.constantFrom(...roots), fc.constantFrom(...rootAttrs), fc.integer({ min: 0, max: 6 }),
            fc.array(fc.constantFrom(...kids), { maxLength: 4 }), fc.constantFrom("</svg>", "</s:svg>", "</html>", "</root>", "</p:svg>"), fc.constantFrom("", "\n", "<!-- t -->"))
            .map(([p, r, ra, empty, ks, close, trail]) => p + r + ra + (empty === 0 ? "/>" : ">" + ks.join("") + close) + trail);
        await fc.assert(fc.asyncProperty(doc, async (d) => {
            expect(rewriteXml(d, standIns, boot)).toBe(await oracle.ask("xmlrw", [d]));
        }), { numRuns: 400 });
    });

    it("rewriteXsl is XmlDoc.rewriteXsl", async () => {
        const parts = [
            `<x:stylesheet xmlns:x="http://www.w3.org/1999/XSL/Transform" version="1.0">`, `</x:stylesheet>`,
            `<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform">`, `</xsl:stylesheet>`,
            `<x:import href="a.xsl"/>`, `<x:include href='/b.xsl'/>`, `<xsl:import href="https://o.example/c.xsl"/>`,
            `<x:value-of select="document('d.xml')/r"/>`, `<x:for-each select='count(document("e.xml"))'/>`,
            `<x:value-of select="mydocument('n')"/>`, `<x:value-of select="document ( 'sp' )"/>`, `<x:value-of select="document('open"/>`,
            `<x:copy-of select="document($v)"/>`, `<img src="i.png" title="document('lit')"/>`, `<x:value-of select="document(&apos;q&apos;)"/>`,
            `<r xmlns="http://www.w3.org/1999/XSL/Transform"><import href="z"/></r>`, `<p:a/>`, `<x:t a="&nbsp;"/>`, "<!-- c -->", "text",
        ];
        const doc = fc.array(fc.constantFrom(...parts), { minLength: 1, maxLength: 8 }).map((ps) => ps.join(""));
        await fc.assert(fc.asyncProperty(doc, async (d) => {
            expect(rewriteXsl(d, (u) => "P" + u)).toBe(await oracle.ask("xslrw", [d]));
        }), { numRuns: 300 });
    });
});
