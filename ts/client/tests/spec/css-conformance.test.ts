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
            const rw = Object.assign((u: string) => rewriteUrl(u, new URL(base), config(proxy)), {
                withMark: (u: string, p: string | null, d: "js" | "css" | "frame" | "inert" | "set" | "mjs" | null) => rewriteUrl(u, new URL(base), config(proxy), p ?? undefined, d ?? undefined),
            });
            expect(rewriteCssText(text, rw), JSON.stringify(text)).toBe(want);
        }), { numRuns: 800 });
    });

    it("cssUrls", async () => {
        await fc.assert(fc.asyncProperty(css, async (text) => {
            const want = ((await oracle.ask("cssurls", [text])) ?? "");
            expect(cssUrls(text).join("\n"), JSON.stringify(text)).toBe(want);
        }), { numRuns: 800 });
    });

    // The runtime rewrites a style value only when it holds "(" (patches/
    // css-style-declaration.ts mayHoldUrl): text with neither "(" nor "@"
    // (no url(, image-set(, @import) is left as it is by the spec.
    it("a value without ( or @ is left as it is", async () => {
        const proxy = "http://localhost:9081", base = "https://site.example/dir/page";
        const plain = css.map((t) => t.replace(/[(@]/g, ""));
        await fc.assert(fc.asyncProperty(plain, async (text) => {
            expect(await oracle.ask("css", [proxy, base, text]), JSON.stringify(text)).toBe(text);
        }), { numRuns: 800 });
    });
});
