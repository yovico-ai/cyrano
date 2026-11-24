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
import { netDestination } from "../../src/patches/navigation";
import { rewriteSrcsetAttribute } from "../../src/patches/srcset";
import { PROXIFIABLE_SCHEMES, frameDest, rewriteUrl, targetDest, unwrapProxiedUrl, type Dest } from "../../src/url/containment";
import { bases, policies, proxiedHref, proxies, srcset, url } from "./gen";
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

    // A request made under its own referrer policy: marked (spec rewriteUrlWith).
    it("rewriteUrl with a referrer policy", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), fc.constantFrom(...policies), url(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, pol, raw]) => {
            fc.pre(!nodeIsNotChromium(raw));
            const want = await ask(() => oracle.ask("rewritewith", [proxy, base, pol, raw]));
            expect(rewriteUrl(raw, new URL(base), config(proxy), pol), `rewriteUrl(${JSON.stringify(raw)}, ${pol}) on ${base}`).toBe(want);
        }), runs);
    });

    // A script's or stylesheet's URL: marked (spec rewriteUrlWith), read back (targetDest).
    it("rewriteUrl with a destination mark, and targetDest", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), fc.constantFrom("-", "-", ...policies), fc.constantFrom("-", "js", "css", "frame", "inert", "set", "mjs", "cred", "jsc", "cssc"), url(proxy), proxiedHref(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, pol, dest, raw, href]) => {
            fc.pre(!nodeIsNotChromium(raw) && !nodeIsNotChromium(href));
            const want = await ask(() => oracle.ask("rewritemark", [proxy, base, pol, dest, raw]));
            const got = rewriteUrl(raw, new URL(base), config(proxy), pol === "-" ? undefined : pol, dest === "-" ? undefined : (dest as Dest));
            expect(got, `rewriteUrl(${JSON.stringify(raw)}, ${pol}, ${dest}) on ${base}`).toBe(want);
            const td = await oracle.ask("targetdest", [href]);
            let onProxy = false;
            try { onProxy = new URL(href).origin === proxy; } catch { onProxy = false; }
            expect(onProxy ? targetDest(href) : null, `targetDest(${JSON.stringify(href)})`).toBe(td ?? null);
        }), runs);
    });

    // The navigation net (spec Route.netDestination): where a navigation
    // to an absolute URL goes instead, or nowhere else.
    it("netDestination", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), fc.oneof(url(proxy), proxiedHref(proxy))));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, raw]) => {
            fc.pre(!nodeIsNotChromium(raw));
            // A navigation's destination is an absolute URL, as the browser serializes it.
            let dest: string;
            try { dest = new URL(raw, base).href; } catch { return; }
            fc.pre(!nodeIsNotChromium(dest));
            const want = await ask(() => oracle.ask("netdest", [proxy, dest]));
            const got = netDestination(dest, new URL(proxy).origin, (u) => rewriteUrl(u, new URL(base), config(proxy)));
            expect(got ?? "none", `netDestination(${JSON.stringify(dest)}) under ${proxy}`).toBe(want);
        }), runs);
    });

    // An iframe's sandbox attribute: the mark its document's URL gets (spec Frames.frameDest).
    it("frameDest", async () => {
        const token = fc.constantFrom("allow-scripts", "ALLOW-SCRIPTS", "Allow-Scripts", "allow-same-origin", "allow-forms", "allow-scriptsx", "xallow-scripts", "allow", "allow-scripts,", "");
        const sep = fc.constantFrom(" ", "  ", "\t", "\n", "\f", "\r", "\v", ",");
        const input = fc.tuple(fc.boolean(), fc.array(fc.tuple(sep, token), { maxLength: 4 }), fc.constantFrom("", " ", "\t", "\v"));
        await fc.assert(fc.asyncProperty(input, async ([has, parts, tail]) => {
            const sandbox = parts.map(([a, b]) => a + b).join("") + tail;
            const want = await oracle.ask("framedest", [has ? "1" : "0", sandbox]);
            expect(frameDest(has ? sandbox : null), `frameDest(${JSON.stringify(has ? sandbox : null)})`).toBe(want);
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
