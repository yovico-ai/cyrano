// @vitest-environment node
//
// URL-based payment methods (spec/Payment.agda), in real Chromium. Chrome
// fetches a URL-based method's manifest itself when a PaymentRequest is
// constructed, outside the page: Stripe's Google Pay frames fetched
// gstatic off the proxy (kenhub.com, modernhealthcare.com, 2026-11-21).
// Proxied, the request is answered as one for a method without an app —
// as directly for a method whose manifest cannot be had: nothing leaves
// the proxy, and the page sees the same answers and messages.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T | Promise<T>): Promise<T>; waitForTimeout(ms: number): Promise<void>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted)("URL-based payment methods, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const boot = u.startsWith("/cyrano/") ? `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://shop.example/");</script>` : "";
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(`<!doctype html><html><head>${boot}</head><body>shop</body></html>`);
        });
        await new Promise<void>((r) => server.listen(0, "localhost", () => r()));
        origin = `http://localhost:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        // The provider's host answers nothing: its manifest cannot be had.
        // The full browser ("new headless"): the old headless shell has no PaymentRequest service.
        browser = await chromium.launch({ channel: "chromium", args: ["--host-resolver-rules=MAP pay.provider.example 127.0.0.1:9"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; outside: string[] }> => {
        const page = await browser.newPage();
        const outside: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (!u.startsWith(origin)) outside.push(u); });
        await page.goto(origin + path);
        const out = await page.evaluate(async () => {
            const res: Record<string, string> = {};
            const make = (): PaymentRequest => new PaymentRequest([{ supportedMethods: "https://pay.provider.example/pay", data: { v: 1 } }],
                { total: { label: "t", amount: { currency: "USD", value: "1.00" } } });
            const settle = async (k: string, f: () => Promise<unknown>): Promise<void> => {
                try { res[k] = "ok " + String(await f()); } catch (e) { res[k] = (e as Error).name + ": " + (e as Error).message; }
            };
            await settle("canMakePayment", () => make().canMakePayment());
            await settle("hasEnrolledInstrument", () => (make() as unknown as { hasEnrolledInstrument(): Promise<boolean> }).hasEnrolledInstrument());
            await settle("show", () => make().show());
            res["ctor"] = Function.prototype.toString.call(PaymentRequest);
            res["instance"] = String(make() instanceof PaymentRequest);
            // A standardized method stays the browser's.
            await settle("standardized", () => new PaymentRequest([{ supportedMethods: "secure-payment-confirmation", data: {} }], { total: { label: "t", amount: { currency: "USD", value: "1" } } }).canMakePayment());
            return res;
        });
        await page.waitForTimeout(1500);
        await page.close();
        return { out, outside };
    };

    it("answers as a method without an app, and nothing leaves the proxy", async () => {
        const direct = await run("/");
        const proxied = await run("/cyrano/https/shop.example/");
        expect(direct.out).toMatchObject({ canMakePayment: "ok false", ctor: "function PaymentRequest() { [native code] }", instance: "true" });
        // Directly, show()'s message goes on with why the manifest could not be
        // had ("Unable to download payment manifest … ERR_CONNECTION_REFUSED");
        // proxied nothing is downloaded: Chrome's message for a method no app
        // answers, without that (a stated difference, spec/Payment.agda).
        const cut = (o: unknown): unknown => ({ ...(o as Record<string, string>), show: String((o as Record<string, string>)["show"]).split(" Unable to download")[0] });
        expect(cut(proxied.out)).toEqual(cut(direct.out));
        expect((proxied.out as Record<string, string>)["show"]).toBe('NotSupportedError: The payment method "https://pay.provider.example/pay" is not supported.');
        expect(proxied.outside).toEqual([]);
    }, 60_000);
});
