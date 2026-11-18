// @vitest-environment node
//
// The fundamental principle (REQUIREMENTS.md): page code cannot tell it
// runs through cyrano. For URL containment that is the law
//
//     unwrap(rewrite(base, raw)) = new URL(raw, base).href
//
// — what page code reads back for a URL it wrote is exactly what the
// browser itself would show. Checked here against the real URL parser
// (Node's WHATWG implementation), not against the spec: this is the
// ground truth the spec is meant to capture. Needs no oracle.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ClientConfig } from "../../src/config";
import { PROXIFIABLE_SCHEMES, rewriteUrl, unwrapProxiedUrl } from "../../src/url/containment";
import { bases, proxies, url } from "./gen";

const config = (apiBaseURL: string) => ({ apiBaseURL }) as ClientConfig;

/** What the browser shows for `raw` on a page at `base`, or null when it isn't a proxified URL. */
function direct(raw: string, base: string, proxy: string): string | null {
    let u: URL;
    try {
        u = new URL(raw, base);
    } catch {
        return null;
    }
    if (!PROXIFIABLE_SCHEMES.has(u.protocol)) return null;
    // A page never names the proxy natively; such URLs are cyrano's own.
    if (u.host === new URL(proxy).host) return null;
    return u.href;
}

describe("the page cannot tell", () => {
    it("unwrap(rewrite(raw)) is the browser's own href", () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), url(proxy)));
        fc.assert(fc.property(input, ([proxy, base, raw]) => {
            const want = direct(raw, base, proxy);
            fc.pre(want !== null);
            // A page-written /cyrano/… path on the page's own origin is remapped
            // rather than proxified; that is cyrano's own URL, not the page's.
            fc.pre(!/^\/cyrano\/(http|https|ws|wss)\/[^/]/.test(new URL(raw, base).pathname));
            const rewritten = rewriteUrl(raw, new URL(base), config(proxy));
            // Kept URLs (anchors, a reference to the page itself) never reach
            // the proxy; what page code reads for them is the attribute's job.
            fc.pre(rewritten.startsWith(`${proxy}/cyrano/`));
            const shown = unwrapProxiedUrl(rewritten, config(proxy));
            expect(shown, `raw ${JSON.stringify(raw)} on ${base}`).toBe(want);
        }), { numRuns: 2000 });
    });
});
