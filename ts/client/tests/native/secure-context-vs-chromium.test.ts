// @vitest-environment node
//
// Secure contexts, in real Chromium (spec/SecureContext.agda). Through the
// proxy every document is served over https, so a page of an http: origin
// was a secure context: cookieStore, crypto.subtle, serviceWorker… where
// directly it has none. The runtime takes that surface away from a
// document whose original URL is not trustworthy.
//   * the table (native/secure-context.ts) is this Chromium's: a secure
//     page's names minus an insecure page's (http://cyrano.test: a name, not
//     loopback), on the same objects;
//   * a proxied http page has what a direct insecure page has, and reads
//     isSecureContext false; a proxied https page keeps it all.
//
// Needs the built bundle, cyrano.test in /etc/hosts and Playwright's
// Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SECURE_ONLY } from "../../src/native/secure-context";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const host = "cyrano.test";
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath) &&
    readFileSync("/etc/hosts", "utf8").split("\n").some((l) => !l.trim().startsWith("#") && l.split(/\s+/).includes(host));

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// The names on each object, its prototype chain included.
const SURFACE = () => {
    const roots: Record<string, object> = { window: globalThis, Navigator: Navigator.prototype, Document: Document.prototype, Crypto: Crypto.prototype, HTMLElement: HTMLElement.prototype };
    const out: Record<string, string[]> = {};
    for (const [n, o] of Object.entries(roots)) {
        const keys = new Set<string>();
        for (let x: object | null = o; x && x !== Object.prototype; x = Object.getPrototypeOf(x) as object | null) for (const k of Object.getOwnPropertyNames(x)) keys.add(k);
        out[n] = [...keys].sort();
    }
    return { surface: out, secure: isSecureContext, probes: [typeof (globalThis as { cookieStore?: unknown }).cookieStore, typeof crypto.subtle, "serviceWorker" in navigator, typeof (crypto as { randomUUID?: unknown }).randomUUID] };
};

describe.skipIf(!wanted)("secure contexts, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            // /proxied/<scheme>: the runtime, given an original URL of that scheme.
            const m = /^\/proxied\/(https?)/.exec(u);
            const boot = m ? `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("${m[1]}://site.example/p");</script>` : "";
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(`<!doctype html><html><head>${boot}</head><body>x</body></html>`);
        });
        await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const read = async (url: string): Promise<ReturnType<typeof SURFACE>> => {
        const page = await browser.newPage();
        await page.goto(url);
        const r = await page.evaluate(SURFACE);
        await page.close();
        return r;
    };

    it("the table is this Chromium's", async () => {
        const sec = await read(`http://127.0.0.1:${port}/`);       // loopback: a secure context
        const ins = await read(`http://${host}:${port}/`);         // a name: not one
        expect([sec.secure, ins.secure]).toEqual([true, false]);
        for (const [k, names] of Object.entries(SECURE_ONLY)) {
            const measured = sec.surface[k]!.filter((n) => !ins.surface[k]!.includes(n)).sort();
            expect([...names].sort(), k).toEqual(measured);
        }
    });

    it("a proxied http page is no secure context, as directly; an https one is", async () => {
        const direct = await read(`http://${host}:${port}/`);
        // Served from a secure context (loopback), as the proxy's https pages are.
        const http = await read(`http://127.0.0.1:${port}/proxied/http`);
        const https = await read(`http://127.0.0.1:${port}/proxied/https`);
        expect(http.secure).toBe(false);
        expect(http.probes).toEqual(direct.probes);
        expect(https.secure).toBe(true);
        expect(https.probes).toEqual(["object", "object", true, "function"]);
        for (const k of Object.keys(SECURE_ONLY)) {
            // The runtime's own names aside ($rewriter…), what is there is what is there directly.
            const strip = (xs: string[]): string[] => xs.filter((n) => !n.startsWith("$"));
            const extra = strip(http.surface[k]!).filter((n) => !direct.surface[k]!.includes(n));
            expect(extra.filter((n) => (SECURE_ONLY as Record<string, readonly string[]>)[k]!.includes(n)), k).toEqual([]);
        }
    });
});
