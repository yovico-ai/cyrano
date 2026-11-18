// A <script>'s or <style>'s content is JS or CSS, never markup — on every
// path that sets it.

import { afterEach, describe, expect, it } from "vitest";
import { patchDynamicHtml, unpatchDynamicHtml, rawText } from "../../src/patches/dynamic-html";

const tag = (u: string): string => `P(${u})`;
afterEach(() => unpatchDynamicHtml());

describe("raw-text elements", () => {
    it("script.innerHTML is rewritten as JS, not parsed as HTML", () => {
        patchDynamicHtml(window, tag, (u) => u);
        const s = document.createElement("script");
        s.innerHTML = "if (a<b && c>d) { x = location.href; }";
        expect(s.textContent).not.toContain("&lt;"); // not treated as markup
        expect(s.textContent).toMatch(/a\s*<\s*b\s*&&\s*c\s*>\s*d/);
        expect(s.textContent).toContain("$rewriter.wrap_get_location(location)");
    });
    it("script.textContent and script.text are rewritten as JS", () => {
        patchDynamicHtml(window, tag, (u) => u);
        const a = document.createElement("script");
        a.textContent = "var h = location.host;";
        expect(a.textContent).toContain("wrap_get_location");
        const b = document.createElement("script");
        b.text = "var h = location.host;";
        expect(b.textContent).toContain("wrap_get_location");
    });
    it("style text has its url()s proxified on every path", () => {
        patchDynamicHtml(window, tag, (u) => u);
        const st = document.createElement("style");
        st.textContent = "a{background:url(/x.png)}";
        expect(st.textContent).toContain("P(/x.png)");
        const st2 = document.createElement("style");
        st2.append("b{background:url(/y.png)}", document.createTextNode("c{background:url(/z.png)}"));
        expect(st2.textContent).toContain("P(/y.png)");
        expect(st2.textContent).toContain("P(/z.png)");
    });
    it("a script that is not JavaScript is left as written", () => {
        const s = document.createElement("script");
        s.setAttribute("type", "application/ld+json");
        expect(rawText(s, '{"url":"location"}', tag)).toBe('{"url":"location"}');
    });
    it("an import map's URLs are proxified, bare specifiers kept, integrity dropped", () => {
        const s = document.createElement("script");
        s.setAttribute("type", "importmap");
        const out = JSON.parse(rawText(s, '{"imports":{"react":"https://cdn.example/react.js","/x.js":"./y.js"},"scopes":{"/a/":{"b":"/c.js"}},"integrity":{"k":"v"}}', tag)!) as Record<string, unknown>;
        expect(out).toEqual({
            imports: { react: "P(https://cdn.example/react.js)", "P(/x.js)": "P(./y.js)" },
            scopes: { "P(/a/)": { b: "P(/c.js)" } },
        });
    });
    it("other elements are untouched by the raw-text path", () => {
        patchDynamicHtml(window, tag, (u) => u);
        const d = document.createElement("div");
        d.textContent = "location.href url(/x.png)";
        expect(d.textContent).toBe("location.href url(/x.png)");
    });
});

describe("Trusted Types values at HTML sinks", () => {
    // What a page under a Trusted Types policy passes instead of a string.
    class TrustedHTML {
        constructor(private readonly s: string) {}
        toString(): string { return this.s; }
        get [Symbol.toStringTag](): string { return "TrustedHTML"; }
    }
    it("innerHTML given a TrustedHTML is rewritten like the string it wraps", () => {
        patchDynamicHtml(window, tag, (u) => u);
        const d = document.createElement("div");
        (d as unknown as { innerHTML: unknown }).innerHTML = new TrustedHTML('<a href="/x">l</a>');
        expect(d.querySelector("a")!.getAttribute("href")).toBe("P(/x)");
    });
    it("setAttribute stringifies a non-string value before rewriting", () => {
        patchDynamicHtml(window, tag, (u) => u);
        const a = document.createElement("a");
        a.setAttribute("href", { toString: () => "/y" } as unknown as string);
        expect(a.getAttribute("href")).toBe("P(/y)");
    });
});
