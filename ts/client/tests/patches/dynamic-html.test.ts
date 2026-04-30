// Runs under happy-dom. Patches Element.prototype methods/setters globally,
// so we restore them in afterEach via the module's own unpatch hook.

import { afterEach, describe, expect, it } from "vitest";
import { patchDynamicHtml, unpatchDynamicHtml } from "../../src/patches/dynamic-html";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";

afterEach(() => {
    unpatchDynamicHtml();
});

describe("patchDynamicHtml — innerHTML setter", () => {
    it("rewrites URL attrs in the assigned HTML before the parser sees it", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        div.innerHTML = '<img src="/a.png"><a href="/x">link</a>';

        const img = div.querySelector("img")!;
        const link = div.querySelector("a")!;
        expect(img.getAttribute("src")).toBe("/a.png?proxified=1");
        expect(link.getAttribute("href")).toBe("/x?proxified=1");
    });

    it("preserves non-URL content untouched", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        div.innerHTML = "<p>plain text</p>";
        expect(div.textContent).toBe("plain text");
    });

    it("ignores non-string assignments", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        // Implementations differ on whether non-string innerHTML coerces to
        // string; we only assert it doesn't throw and our rewriter doesn't
        // mangle anything.
        expect(() => {
            (div as unknown as { innerHTML: unknown }).innerHTML = 42;
        }).not.toThrow();
    });

    it("getter still returns the (rewritten) live HTML — not the input string", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        div.innerHTML = '<img src="/x.png">';
        // Reading innerHTML reflects what's actually in the DOM, which is the
        // rewritten value.
        expect(div.innerHTML).toContain("proxified=1");
    });
});

describe("patchDynamicHtml — outerHTML setter", () => {
    it("rewrites URL attrs in replacement HTML", () => {
        patchDynamicHtml(window, tag);
        const parent = document.createElement("div");
        const child = document.createElement("span");
        parent.appendChild(child);
        child.outerHTML = '<a href="/replaced">new</a>';

        const link = parent.querySelector("a")!;
        expect(link.getAttribute("href")).toBe("/replaced?proxified=1");
    });
});

describe("patchDynamicHtml — insertAdjacentHTML", () => {
    it("rewrites URL attrs in inserted HTML", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        document.body.appendChild(div);
        div.insertAdjacentHTML("beforeend", '<img src="/y.png">');

        const img = div.querySelector("img")!;
        expect(img.getAttribute("src")).toBe("/y.png?proxified=1");
        div.remove();
    });

    it("rewrites at all four insertion positions", () => {
        patchDynamicHtml(window, tag);
        const wrapper = document.createElement("section");
        wrapper.innerHTML = "<p id=anchor>x</p>";
        document.body.appendChild(wrapper);
        const anchor = wrapper.querySelector("#anchor")! as HTMLElement;

        anchor.insertAdjacentHTML("beforebegin", '<a id=bb href="/bb">bb</a>');
        anchor.insertAdjacentHTML("afterbegin", '<a id=ab href="/ab">ab</a>');
        anchor.insertAdjacentHTML("beforeend", '<a id=be href="/be">be</a>');
        anchor.insertAdjacentHTML("afterend", '<a id=ae href="/ae">ae</a>');

        for (const id of ["bb", "ab", "be", "ae"]) {
            const a = wrapper.querySelector(`#${id}`)!;
            expect(a.getAttribute("href")).toBe(`/${id}?proxified=1`);
        }
        wrapper.remove();
    });
});

describe("patchDynamicHtml — setAttribute", () => {
    it("rewrites img.setAttribute('src', …)", () => {
        patchDynamicHtml(window, tag);
        const img = document.createElement("img");
        img.setAttribute("src", "/a.png");
        expect(img.getAttribute("src")).toBe("/a.png?proxified=1");
    });

    it("rewrites a.setAttribute('href', …)", () => {
        patchDynamicHtml(window, tag);
        const a = document.createElement("a");
        a.setAttribute("href", "/x");
        expect(a.getAttribute("href")).toBe("/x?proxified=1");
    });

    it("rewrites srcset with descriptor preservation", () => {
        patchDynamicHtml(window, tag);
        const img = document.createElement("img");
        img.setAttribute("srcset", "a.jpg 1x, b.jpg 2x");
        expect(img.getAttribute("srcset")).toBe(
            "a.jpg?proxified=1 1x, b.jpg?proxified=1 2x",
        );
    });

    it("matches attribute names case-insensitively", () => {
        patchDynamicHtml(window, tag);
        const img = document.createElement("img");
        img.setAttribute("SRC", "/upper.png");
        expect(img.getAttribute("src")).toBe("/upper.png?proxified=1");
    });

    it("does not rewrite non-URL attributes", () => {
        patchDynamicHtml(window, tag);
        const a = document.createElement("a");
        a.setAttribute("class", "btn /not-a-url");
        expect(a.getAttribute("class")).toBe("btn /not-a-url");
    });

    it("rewrites the style=\"...\" attribute value through the CSS rewriter on every element", () => {
        patchDynamicHtml(window, tag);
        // The style attribute applies to every element, not just URL-bearing ones.
        const div = document.createElement("div");
        div.setAttribute("style", "background: url('bg.png')");
        expect(div.getAttribute("style")).toContain("bg.png?proxified=1");
    });

    it("rewrites @import inside a style attribute (rare but valid)", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        // @import is technically allowed only at the start of a stylesheet, but
        // our rewriter is content-driven — anything matching the regex gets
        // rewritten regardless of legality.
        div.setAttribute("style", '@import "/x.css"');
        expect(div.getAttribute("style")).toContain("/x.css?proxified=1");
    });

    it("does not rewrite URL attribute names on non-URL-bearing elements", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        // <div href="..."> is not standard; we should not rewrite.
        div.setAttribute("href", "/should-not-rewrite");
        expect(div.getAttribute("href")).toBe("/should-not-rewrite");
    });

    it("passes non-string values through unchanged", () => {
        patchDynamicHtml(window, tag);
        const img = document.createElement("img");
        // happy-dom coerces non-strings, but our rewriter must not run on them.
        img.setAttribute("src", null as unknown as string);
        expect(img.getAttribute("src")).not.toContain("proxified=1");
    });
});

describe("patchDynamicHtml — idempotence", () => {
    it("re-installing on the same prototype is a no-op (no double-wrap)", () => {
        patchDynamicHtml(window, tag);
        patchDynamicHtml(window, tag); // second call must not double-rewrite

        const img = document.createElement("img");
        img.setAttribute("src", "/x.png");
        expect(img.getAttribute("src")).toBe("/x.png?proxified=1");
        // Single rewrite — not /x.png?proxified=1?proxified=1 etc.
        expect(img.getAttribute("src")).not.toMatch(/proxified=1.*proxified=1/);
    });
});

// ── HTML_INTEGRITY — strip integrity attrs from dynamic content ──────────────

describe("patchDynamicHtml — integrity stripping", () => {
    it("setAttribute('integrity', ...) is silently dropped", () => {
        patchDynamicHtml(window, tag);
        const script = document.createElement("script");
        script.setAttribute("integrity", "sha384-abc");
        expect(script.getAttribute("integrity")).toBeNull();
    });

    it("integrity in innerHTML is stripped before insertion", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        div.innerHTML = '<script src="/x.js" integrity="sha384-abc"></script>';
        const s = div.querySelector("script")!;
        expect(s.getAttribute("integrity")).toBeNull();
        // src should still be rewritten
        expect(s.getAttribute("src")).toBe("/x.js?proxified=1");
    });

    it("integrity in insertAdjacentHTML is stripped", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        document.body.appendChild(div);
        div.insertAdjacentHTML("beforeend", '<link rel="stylesheet" href="/s.css" integrity="sha384-xyz">');
        const link = div.querySelector("link")!;
        expect(link.getAttribute("integrity")).toBeNull();
        expect(link.getAttribute("href")).toBe("/s.css?proxified=1");
        div.remove();
    });

    it(".integrity property setter is nooped (returns empty string from getter)", () => {
        patchDynamicHtml(window, tag);
        const script = document.createElement("script") as HTMLScriptElement;
        script.integrity = "sha384-shouldbedropped";
        expect(script.integrity).toBe("");
    });
});

// ── HTML_CROSSORIGIN — normalize crossorigin to use-credentials ───────────────

describe("patchDynamicHtml — crossorigin normalization", () => {
    it("setAttribute('crossorigin', 'anonymous') becomes use-credentials", () => {
        patchDynamicHtml(window, tag);
        const script = document.createElement("script");
        script.setAttribute("crossorigin", "anonymous");
        expect(script.getAttribute("crossorigin")).toBe("use-credentials");
    });

    it("crossorigin in innerHTML is normalized", () => {
        patchDynamicHtml(window, tag);
        const div = document.createElement("div");
        div.innerHTML = '<script src="/x.js" crossorigin="anonymous"></script>';
        const s = div.querySelector("script")!;
        expect(s.getAttribute("crossorigin")).toBe("use-credentials");
    });
});
