// @vitest-environment node

import { describe, expect, it } from "vitest";
import { rewriteSrcsetAttribute } from "../../src/patches/srcset";

const upper = (url: string): string => url.toUpperCase();

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
});
