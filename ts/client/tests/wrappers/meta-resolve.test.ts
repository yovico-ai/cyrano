// @vitest-environment node
//
// R15's stand-in for import.meta.resolve (src/wrappers/meta-resolve.ts),
// without a browser: the "native" here resolves as Chromium's does, against
// the module's own (proxied) URL. The answer must be what the native gives
// for the original module: the original URL, resolved against the
// original. (Against Chromium: tests/native/meta-resolve-vs-chromium.)

import { describe, expect, it } from "vitest";
import type { ClientConfig } from "../../src/config";
import { metaResolver } from "../../src/wrappers/meta-resolve";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    source: "/rewriter.js",
    cacheKey: "test",
    version: "test",
    rewrite_css_selectors: false,
};

const ORIGINAL = "https://shop.example/assets/app.js";
const PROXIED = "http://localhost:9081/cyrano/https!js/shop.example/assets/app.js";

function meta(url: string): { url: string; resolve: (s: unknown) => string } {
    return {
        url,
        resolve(s: unknown): string {
            const spec = `${s as string}`;
            if (!/^(\/|\.\/|\.\.\/|[a-z][a-z0-9+.-]*:)/i.test(spec)) throw new TypeError(`Failed to resolve module specifier "${spec}"`);
            return new URL(spec, url).href;
        },
    };
}

describe("wrap_meta_resolve", () => {
    const wrap = metaResolver(config);
    const direct = meta(ORIGINAL);
    const proxied = meta(PROXIED);
    const resolve = wrap(proxied) as (s: unknown) => string;

    it("resolves as direct: root-relative, relative, absolute", () => {
        for (const s of ["/a.js", "./b.js", "../c/d.js", "https://cdn.example/e.js", "/f.js?q=1#h", "data:text/javascript,1"]) {
            expect(resolve(s), s).toBe(direct.resolve(s));
        }
    });

    it("ToString of the specifier, as the native", () => {
        expect(resolve({ toString: () => "/x.js" })).toBe(direct.resolve("/x.js"));
        expect(() => resolve(Symbol("s"))).toThrow(TypeError);
    });

    it("the native's error for a bare specifier with no import map", () => {
        for (const s of ["lodash", "?q=1", "#h"]) {
            let message = "";
            try { direct.resolve(s); } catch (e) { message = (e as Error).message; }
            expect(message, s).not.toBe("");
            expect(() => resolve(s), s).toThrow(message);
        }
    });

    it("one stand-in per native: resolve === resolve", () => {
        expect(wrap(proxied)).toBe(resolve);
        expect(wrap(meta(PROXIED))).not.toBe(resolve);
    });

    it("no resolve: whatever is there", () => {
        expect(wrap({ url: PROXIED })).toBeUndefined();
    });
});
