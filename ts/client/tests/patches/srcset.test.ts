// @vitest-environment node

import { describe, expect, it } from "vitest";
import { rewriteSrcsetAttribute } from "../../src/patches/srcset";

const upper = (url: string): string => url.toUpperCase();
const identity = (u: string) => `R(${u})`;

describe("rewriteSrcsetAttribute", () => {
    it("rewrites a single bare URL", () => {
        expect(rewriteSrcsetAttribute("img.jpg", upper)).toBe("IMG.JPG");
    });

    it("preserves descriptors after the URL", () => {
        expect(rewriteSrcsetAttribute("img.jpg 2x", upper)).toBe("IMG.JPG 2x");
    });

    it("handles a comma-separated list of candidates", () => {
        const got = rewriteSrcsetAttribute("a.jpg 1x, b.jpg 2x, c.jpg 480w", upper);
        expect(got).toBe("A.JPG 1x, B.JPG 2x, C.JPG 480w");
    });

    it("trims whitespace around candidates", () => {
        const got = rewriteSrcsetAttribute("  a.jpg 1x  ,  b.jpg 2x  ", upper);
        expect(got).toBe("A.JPG 1x, B.JPG 2x");
    });

    // ── Cloudflare Image Resizing — commas inside URL path ───────────────────

    it("does not split Cloudflare Image Resizing URLs at commas in the path", () => {
        // /cdn-cgi/image/width=640,quality=75,format=auto/<origin-url>
        // The commas in the transform params are INSIDE the URL, not separators.
        const cf1 = "https://cdn.example.com/cdn-cgi/image/width=640,quality=75,format=auto/https://origin.com/img.jpg";
        const cf2 = "https://cdn.example.com/cdn-cgi/image/width=1280,quality=75,format=auto/https://origin.com/img.jpg";
        const out = rewriteSrcsetAttribute(`${cf1} 640w, ${cf2} 1280w`, identity);
        expect(out).toContain(`R(${cf1}) 640w`);
        expect(out).toContain(`R(${cf2}) 1280w`);
    });

    it("handles empty srcset", () => {
        expect(rewriteSrcsetAttribute("", identity)).toBe("");
    });

    it("handles comma-only/whitespace-only srcset without crash", () => {
        expect(() => rewriteSrcsetAttribute(", ,", identity)).not.toThrow();
    });

    it("handles descriptor-less final candidate", () => {
        const out = rewriteSrcsetAttribute("a.png 1x, b.png", identity);
        expect(out).toContain("R(a.png) 1x");
        expect(out).toContain("R(b.png)");
    });
});
