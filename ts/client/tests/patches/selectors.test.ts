// @vitest-environment node
import { describe, expect, it } from "vitest";
import { widenSelector } from "../../src/patches/selectors";

const P = "http://proxy.test";
const rw = (u: string): string => (/^https?:\/\//.test(u) ? `${P}/cyrano/${u.replace("://", "/")}` : u.startsWith("/") ? `${P}/cyrano/https/site.test${u}` : u);
const w = (s: string): string => widenSelector(s, rw, P);

// Each proxied alternative is admitted unmarked and marked js / css (an
// element's URL may be held marked: a script's src is /cyrano/https!js/…).
const marked = (sel: string): string => sel.replace(/\[(\w+)(\^=|\*=|=)"((?:http:\/\/proxy\.test)?\/cyrano\/)(https?)\/([^"]*)"\]/g,
    (_m, a: string, op: string, pre: string, sc: string, rest: string) =>
        [`[${a}${op}"${pre}${sc}/${rest}"]`, `[${a}${op}"${pre}${sc}!js/${rest}"]`, `[${a}${op}"${pre}${sc}!css/${rest}"]`].join(","));


describe("selectors on URL attributes admit the proxied value", () => {
    it("an exact value (Squarespace looks for a script it has loaded)", () => {
        expect(w('script[src="https://cdn.test/a.js"]')).toBe(marked(
            'script:is([src="https://cdn.test/a.js"],[src="http://proxy.test/cyrano/https/cdn.test/a.js"])'));
    });
    it("a prefix, quoted either way or not at all", () => {
        expect(w("a[href^='https://x.test/p/']")).toBe(marked(
            `a:is([href^='https://x.test/p/'],[href^="http://proxy.test/cyrano/https/x.test/p/"])`));
        expect(w("a[href^=/docs]")).toBe(marked('a:is([href^=/docs],[href^="http://proxy.test/cyrano/https/site.test/docs"])'));
    });
    it("a bare scheme prefix means every proxied URL of that scheme", () => {
        expect(w('a[href^="https://"]')).toBe('a:is([href^="https://"],[href^="http://proxy.test/cyrano/https/"],[href^="http://proxy.test/cyrano/https!"])');
        expect(w('a[href^="http"]')).toBe('a:is([href^="http"],[href^="http://proxy.test/cyrano/http/"],[href^="http://proxy.test/cyrano/http!"],[href^="http://proxy.test/cyrano/https/"],[href^="http://proxy.test/cyrano/https!"])');
    });
    it("a contains-test naming a host after // (Ad-Shield's recovery finding its loader)", () => {
        expect(w('script[src*="//html-load.test/loader.min.js"]')).toBe(marked(
            'script:is([src*="//html-load.test/loader.min.js"],[src*="/cyrano/https/html-load.test/loader.min.js"],[src*="/cyrano/http/html-load.test/loader.min.js"])'));
        expect(w('script[src*="https://cdn.test/a.js"]')).toBe(marked(
            'script:is([src*="https://cdn.test/a.js"],[src*="/cyrano/https/cdn.test/a.js"])'));
    });
    it("leaves everything else as written", () => {
        for (const s of ["div.a > p", 'a[href*="x.test"]', 'a[href$=".pdf"]', 'a[href^="#"]', 'a[href^="mailto:"]',
            'input[name="https://x.test/"]', '[data-x="a]b"] a', "a[href]", 'a[title="[src=\\"https://x.test/\\"]"]']) {
            expect(w(s)).toBe(s);
        }
    });
    it("in a list and with combinators", () => {
        expect(w('link[href="/a.css"], div > script[src="/b.js"] ~ p')).toBe(marked(
            'link:is([href="/a.css"],[href="http://proxy.test/cyrano/https/site.test/a.css"]), ' +
            'div > script:is([src="/b.js"],[src="http://proxy.test/cyrano/https/site.test/b.js"]) ~ p'));
    });
});

import { rewriteCssText } from "../../src/css/rewriter";
describe("@import without a space before its string (minified CSS)", () => {
    it("is rewritten", () => {
        expect(rewriteCssText('@import"https://fonts.test/a.css";', rw)).toContain("proxy.test/cyrano/https/fonts.test/a.css");
        expect(rewriteCssText("@IMPORT 'https://fonts.test/a.css';", rw)).toContain("proxy.test/cyrano/https/fonts.test/a.css");
    });
});

// A script holds its src marked (/cyrano/https!js/…) since the marks; the
// unmarked alternative found nothing (Squarespace's check again), and a
// $= naming the scheme's end never matched.
describe("selectors admit marked and scheme-crossing forms", () => {
    it("matches a script's marked src and a $= across the scheme", () => {
        expect(w('script[src="https://cdn.test/a.js"]')).toContain('[src="http://proxy.test/cyrano/https!js/cdn.test/a.js"]');
        expect(w('script[src$="ps://cdn.test/a.js"]')).toContain('[src$="/cyrano/https!js/cdn.test/a.js"]');
        expect(w('script[src$="ps://cdn.test/a.js"]')).not.toContain("/cyrano/http/");
        expect(w('script[src$="/a.js"]')).toBe('script[src$="/a.js"]');
    });
});
