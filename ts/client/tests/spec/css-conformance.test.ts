// @vitest-environment node
//
// Conformance of src/css/rewriter.ts with spec/Css.agda, asked live: the
// rewritten text (`css`) and the URLs found (`cssurls`). (Go:
// go/src/internal/cssrewrite/conformance_test.go; the spec against
// Chromium: css-vs-chromium.test.ts.)

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cssUrls, rewriteCssText } from "../../src/css/rewriter";
import { rewriteUrl } from "../../src/url/containment";
import type { ClientConfig } from "../../src/config";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

// Fragments the tokenizer must get right, joined at random.
const pieces = [
    "url(a.png)", "url( b.png )", "URL(c.png)", 'url("d.png")', "url( 'e.png' )", "\\75rl(f.png)", "url(g\\.png)",
    "url(h\\2e png)", "url(i\\(1\\).png)", 'url("j\\\n.png")', "url(bad k.png)", 'url(l".png)', "url(m(.png)",
    'image-set("n.png" 1x)', '-webkit-image-set(url(o.png) 2x)', 'image-set("p" type("image/avif") 1x, "q" 2x)',
    '@import"r.css";', "@import url(s.css);", "@IMPORT 't.css';", '@import /* c */ "u.css";',
    'content:"url(v.png)"', "/* url(w.png) */", "1url(x.png)", "#url(y)", "-url(z)", "--x:url(aa.png)", "-->", "<!--",
    "url(data:image/png;base64,AA)", "url(#frag)", "url()", 'url("")', "url(http://ex.com/a b)", "url(https://cdn.example/q?a=1&b=2)",
    "url(\\\n)", "url(é.png)", '"str\\"ing"', "'unterminated\n", "{", "}", "(", ")", "[", "]", ";", ":", ",", " ", "\n", "\r\n", "\t",
    "a", "b-c", "1.5e3px", "+.5", "-.5", "url(\\0 x.png)", "url(\\110000 y.png)", "url(\\", "\\",
];
const css = fc.array(fc.constantFrom(...pieces), { maxLength: 14 }).map((ps) => ps.join(""));
const config = (proxy: string): ClientConfig => ({ apiBaseURL: proxy, source: "/rewriter.js", cacheKey: "t", version: "t", rewrite_css_selectors: false });

describe.skipIf(located.skip !== "")("CSS: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("rewriteCssText is rewriteCss", async () => {
        const proxy = "http://localhost:9081", base = "https://site.example/dir/page";
        await fc.assert(fc.asyncProperty(css, async (text) => {
            const want = await oracle.ask("css", [proxy, base, text]);
            expect(rewriteCssText(text, (u) => rewriteUrl(u, new URL(base), config(proxy))), JSON.stringify(text)).toBe(want);
        }), { numRuns: 800 });
    });

    it("cssUrls", async () => {
        await fc.assert(fc.asyncProperty(css, async (text) => {
            const want = ((await oracle.ask("cssurls", [text])) ?? "");
            expect(cssUrls(text).join("\n"), JSON.stringify(text)).toBe(want);
        }), { numRuns: 800 });
    });
});
