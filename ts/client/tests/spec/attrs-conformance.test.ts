// @vitest-environment node
//
// Conformance of the URL-attribute table (src/patches/url-attribute-map.ts)
// and URL lists with spec/Attrs.agda, asked live (Go:
// htmlrewrite/attrs_conformance_test.go, over the same vocabulary).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteUrlList, urlAttrKind, urlDest } from "../../src/patches/url-attribute-map";
import { rewriteUrl } from "../../src/url/containment";
import type { ClientConfig } from "../../src/config";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";
import { bases, proxies } from "./gen";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const tags = "a area audio base blockquote body button del embed form frame iframe image img input ins link object q script source table tbody td tfoot th thead tr track video use feimage svg div span p meta html applet portal fencedframe g rect path text pattern".split(" ");
const names = "src href xlink:href action formaction data poster background ping attributionsrc srcset imagesrcset cite longdesc lowsrc codebase manifest archive classid usemap style id content dynsrc itemid clip-path cursor fill filter marker-start marker-mid marker-end mask stroke stroke-width opacity CLIP-PATH onclick onload onerror onfoo one on onClick on-x on1 onx2 o".split(" ");
const pieces = [" ", "\t", "\n", "\f", "\r", "  ", "/a", "b/c", "https://x.example/p", "//h.example/", "?q", "#f", "http://[::1", "%zz", "é", "data:,x"];
const config = (proxy: string): ClientConfig => ({ apiBaseURL: proxy, source: "/rewriter.js", cacheKey: "t", version: "t", rewrite_css_selectors: false });

describe.skipIf(located.skip !== "")("URL attributes: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("urlAttrKind is attrKind", async () => {
        const bad: string[] = [];
        for (const ns of ["html", "svg"]) for (const t of tags) for (const a of names) {
            const want = await oracle.ask("attrkind", [ns, t, a]);
            const got = urlAttrKind(ns === "svg", t, a);
            if (got !== want) bad.push(`${ns} ${t} ${a}: ${got}, spec ${want}`);
        }
        expect(bad).toEqual([]);
    });

    it("urlDest is urlDest", async () => {
        const rels = ["", "stylesheet", "alternate stylesheet", "preload", "prefetch", "modulepreload", "icon", "preload prefetch", "dns-prefetch"];
        const ases = ["-", "script", "style", "font", "image", ""];
        const bad: string[] = [];
        for (const ns of ["html", "svg"]) for (const t of ["script", "link", "img", "a", "image"]) for (const a of ["src", "href", "xlink:href"])
            for (const rel of rels) for (const as of ases) {
                const want = await oracle.ask("urldest", [ns, t, a, rel, as]);
                const got = urlDest(ns === "svg", t, a, rel.split(" ").filter((x) => x !== ""), as === "-" ? null : as) ?? "-";
                if (got !== want) bad.push(`${ns} ${t} ${a} rel=${rel} as=${as}: ${got}, spec ${want}`);
            }
        expect(bad).toEqual([]);
    });

    it("rewriteUrlList is rewriteUrlList", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...proxies), fc.constantFrom(...bases), fc.array(fc.constantFrom(...pieces), { maxLength: 8 }), async (proxy, base, p) => {
            const v = p.join("");
            const want = await oracle.ask("urllist", [proxy, base, v]);
            expect(rewriteUrlList(v, (u) => rewriteUrl(u, new URL(base), config(proxy))), JSON.stringify(v)).toBe(want);
        }), { numRuns: 600 });
    });
});
