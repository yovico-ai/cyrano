// @vitest-environment node
//
// Host mode (config.sites; spec/SiteContainment.agda) against the spec,
// asked live, with the oracle's stand-in registrable domain (spec Oracle
// regStandIn) given to the runtime: rewriting puts each URL on its target
// site's host; unwrapping reads it back from any of the proxy's hosts,
// exactly as the browser shows the original (Unwrap ∘ Rewrite = direct).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientConfig } from "../../src/config";
import { rewriteUrl, unwrapProxiedUrl, type Dest } from "../../src/url/containment";
import { labelOrigin, originLabel } from "../../src/url/site-host";
import { bases, policies, proxiedHref, proxies, url } from "./gen";
import { OracleClient, OutOfModel, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const config = (apiBaseURL: string) => ({ apiBaseURL, sites: true }) as ClientConfig;
// Node's URL parser differs from Chromium's here (see conformance.test.ts).
const nodeIsNotChromium = (s: string) => /[\^|* ]/.test(s);
const runs = { numRuns: 400 };

describe.skipIf(located.skip !== "")("host mode: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    const ask = async <T>(q: () => Promise<T>): Promise<T> => {
        try { return await q(); } catch (e) { fc.pre(!(e instanceof OutOfModel)); throw e; }
    };

    it("origin labels, and reading them back", async () => {
        const host = fc.stringMatching(/^[a-z0-9.\-\[\]:é]{0,70}$/);
        const input = fc.tuple(fc.constantFrom("http", "https", "ws", "wss"), fc.oneof(host, fc.constantFrom("www.example.com", "a-b.c-d.example", "xn--bcher-kva.example", "6093eccf-6734-4877-ac8b-83d6d0e27b46.edgeoptimize.net", "[::1]", "127.0.0.1")), fc.constantFrom("", "", "8080", "1", "x"));
        await fc.assert(fc.asyncProperty(input, async ([sc, h, p]) => {
            const want = await oracle.ask("originlabel", [sc, h, p]);
            const got = originLabel(sc, h, p);
            expect(got, `originLabel(${sc}, ${h}, ${p})`).toBe(want);
            const back = await oracle.ask("labelorigin", [got]);
            const mine = labelOrigin(got);
            expect(mine === null ? "" : mine.join(" ")).toBe(back);
            if (got !== "") expect(back).toBe(`${sc} ${h} ${p}`); // round trip
        }), { numRuns: 500 });
        for (const l of ["", "q", "s", "s-", "s-3", "s-2", "sa-2", "sa-28x", "sa-0", "s-0a", "sA"]) {
            const mine = labelOrigin(l);
            expect(mine === null ? "" : mine.join(" "), l).toBe(await oracle.ask("labelorigin", [l]));
        }
    });

    it("rewriteUrl", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), fc.constantFrom("-", "-", ...policies), fc.constantFrom("-", "-", "js", "css", "frame", "inert"), url(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, pol, dest, raw]) => {
            fc.pre(!nodeIsNotChromium(raw));
            const want = await ask(() => oracle.ask("siterewrite", [proxy, base, pol, dest, raw]));
            const got = rewriteUrl(raw, new URL(base), config(proxy), pol === "-" ? undefined : pol, dest === "-" ? undefined : (dest as Dest));
            expect(got, `rewriteUrl(${JSON.stringify(raw)}, ${pol}, ${dest}) on ${base}`).toBe(want);
        }), runs);
    });

    it("unwrapProxiedUrl, from any of the proxy's hosts", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) =>
            fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), url(proxy), proxiedHref(proxy), fc.constantFrom("", "x.", "user@", "aaaa.")));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, raw, other, prefix]) => {
            fc.pre(!nodeIsNotChromium(raw) && !nodeIsNotChromium(other));
            for (const href of [rewriteUrl(raw, new URL(base), config(proxy)).replace("://", "://" + prefix), other]) {
                fc.pre(!nodeIsNotChromium(href));
                const want = await ask(() => oracle.ask("siteunwrap", [proxy, href]));
                expect(unwrapProxiedUrl(href, config(proxy)), `unwrap(${JSON.stringify(href)})`).toBe(want);
            }
        }), runs);
    });

    it("the page cannot tell: unwrap(rewrite(raw)) is the browser's href", async () => {
        const input = fc.constantFrom(...proxies).chain((proxy) => fc.tuple(fc.constant(proxy), fc.constantFrom(...bases), url(proxy)));
        await fc.assert(fc.asyncProperty(input, async ([proxy, base, raw]) => {
            fc.pre(!nodeIsNotChromium(raw));
            const rw = await ask(() => oracle.rewrite(proxy, base, raw));
            fc.pre(rw.kind === "proxified");
            const direct = await oracle.direct(base, raw);
            const cfg = config(proxy);
            expect(unwrapProxiedUrl(rewriteUrl(raw, new URL(base), cfg), cfg)).toBe(direct.out);
        }), runs);
    });
});
