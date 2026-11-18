// @vitest-environment node
//
// Conformance with the Agda spec (spec/Containment.agda, spec/Srcset.agda),
// asked live: the generators draw inputs, the compiled spec says what each
// must become, and the TS runtime must agree byte for byte. `make
// spec-check` runs this with the oracle required; plain `vitest run`
// skips it, with a note, when the oracle has not been built.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientConfig } from "../../src/config";
import { rewriteSrcsetAttribute } from "../../src/patches/srcset";
import { PROXIFIABLE_SCHEMES, rewriteUrl, unwrapProxiedUrl } from "../../src/url/containment";
import { bases, proxiedHref, proxies, srcset, url } from "./gen";
import { OracleClient, OutOfModel, checkSchemes, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "") {
    if (oracleRequired) throw new Error(located.skip);
    console.warn(`${located.skip}: conformance tests skipped`);
}

const config = (apiBaseURL: string) => ({ apiBaseURL }) as ClientConfig;

// The spec follows Chromium; these tests run the TS runtime on Node, whose
// URL parser (Ada) differs from Chromium on exactly these characters: ^ and
// | in paths (Chromium encodes them), a space and '*' in hosts (Chromium
// keeps them, %-encoded). In a real Chrome the runtime gets Chromium's
// behaviour natively; spec-vs-chromium.test.ts checks the spec there.
const nodeIsNotChromium = (s: string) => /[\^|* ]/.test(s);
const runs = { numRuns: 500 };

describe.skipIf(located.skip !== "")("spec conformance", () => {
    let oracle: OracleClient;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        await checkSchemes(oracle, [...PROXIFIABLE_SCHEMES].map((s) => s.slice(0, -1)));
    });
    afterAll(() => oracle?.close());

    // fc.pre discards a draw outside the spec's model.
    const ask = async <T>(q: () => Promise<T>): Promise<T> => {
        try {
            return await q();
        } catch (e) {
            fc.pre(!(e instanceof OutOfModel));
            throw e;
        }
    };

    it("rewriteUrl", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), url(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, raw]) => {
            fc.pre(!nodeIsNotChromium(raw));
            const want = await ask(() => oracle.rewrite(proxy, base, raw));
            const got = rewriteUrl(raw, new URL(base), config(proxy));
            expect(got, `rewriteUrl(${JSON.stringify(raw)}) on ${base} (${want.kind})`).toBe(want.out);
        }), runs);
    });

    it("unwrapProxiedUrl", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), proxiedHref(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([proxy, href]) => {
            fc.pre(!nodeIsNotChromium(href));
            const want = await ask(() => oracle.unwrap(proxy, href));
            const got = unwrapProxiedUrl(href, config(proxy));
            expect(got, `unwrapProxiedUrl(${JSON.stringify(href)}) (${want.kind})`).toBe(want.out);
        }), runs);
    });

    // The spec's notion of "what the browser shows" is the browser's: Url.agda
    // checked against the real WHATWG parser.
    it("direct is Node's href, where Node is Chromium", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constantFrom(...bases), url(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([base, raw]) => {
            fc.pre(!nodeIsNotChromium(raw));
            const want = await ask(() => oracle.direct(base, raw));
            let native: URL | null = null;
            try { native = new URL(raw, base); } catch { /* unparseable */ }
            if (want.kind === "shownDirect") {
                expect(native?.href, `new URL(${JSON.stringify(raw)}, ${base})`).toBe(want.out);
            } else if (want.kind === "unparseable") {
                expect(native, `new URL(${JSON.stringify(raw)}, ${base}) should throw`).toBeNull();
            } else {
                expect(native !== null && !PROXIFIABLE_SCHEMES.has(native.protocol),
                    `${JSON.stringify(raw)}: spec says ${want.kind}`).toBe(true);
            }
        }), runs);
    });

    // The law, against the spec: what page code reads back for a proxified
    // URL is what it would be shown without cyrano.
    it("the page cannot tell (spec)", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), url(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, raw]) => {
            fc.pre(!nodeIsNotChromium(raw));
            const rw = await ask(() => oracle.rewrite(proxy, base, raw));
            fc.pre(rw.kind === "proxified");
            const want = await ask(() => oracle.direct(base, raw));
            const back = await ask(() => oracle.unwrap(proxy, rw.out));
            expect(back.out, `spec: unwrap(rewrite(${JSON.stringify(raw)})) on ${base}`).toBe(want.out);
            const shown = unwrapProxiedUrl(rewriteUrl(raw, new URL(base), config(proxy)), config(proxy));
            expect(shown, `runtime: unwrap(rewrite(${JSON.stringify(raw)})) on ${base}`).toBe(want.out);
        }), runs);
    });

    it("rewriteSrcsetAttribute", async () => {
        await fc.assert(fc.asyncProperty(srcset, async (v) => {
            const want = await oracle.srcset(v);
            const got = rewriteSrcsetAttribute(v, (u) => `[${u}]`);
            expect(got, `rewriteSrcsetAttribute(${JSON.stringify(v)})`).toBe(want);
        }), runs);
    });
});
