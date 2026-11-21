// @vitest-environment node
//
// Natives read across the windows of one page, in real Chromium: a script
// takes `Function.prototype.toString` from one window and calls it on a
// function of another. Every proxied document loads its own copy of the
// runtime, and what a copy knows of a stand-in (the native it stands for)
// must be what every copy of the tree knows (native/shared.ts) — a copy's
// private table showed the stand-in's source where two copies met.
//
// Found on techcrunch.com: Cloudflare's Turnstile makes an empty sandboxed
// frame (allow-same-origin, in a closed shadow root) for pristine natives
// and reads `eval` with its toString; given the stand-in's source it
// stringified eval a million times on the page's thread (a 20 s freeze).
//
// The same script runs on a page served directly and on one served as the
// proxy serves it; each read must give the same text.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = {
    goto(u: string): Promise<unknown>;
    evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>;
    on(e: "pageerror", f: (e: Error) => void): void;
    close(): Promise<void>;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted)("natives read across windows, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        const boot = (u: string): string => `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(u)});</script>`;
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const proxied = /^\/cyrano\/https(?:![a-z]+)*\/site\.example\/(page|child)/.exec(u);
            const direct = /^\/(page|child)/.exec(u);
            const name = (proxied ?? direct)?.[1];
            if (name) {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${proxied ? boot("https://site.example/" + name) : ""}</head><body>${name}</body></html>`);
            }
            res.writeHead(204);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    // What the page's script reads. `member` is `o[k]` as rewritten code of
    // window `win` reads it (R5), and plain `o[k]` on the direct page.
    const read = async (child: string): Promise<Record<string, string>> => {
        type W = Window & { $rewriter?: { wrap_member_expression(o: unknown, k: string): Record<string, unknown> }; $__crn_key__?: string; Function: FunctionConstructor; fetch: unknown };
        const member = (win: W, o: unknown, k: string): unknown => {
            const R = win.$rewriter;
            return R ? R.wrap_member_expression(o, (win.$__crn_key__ = k))[win.$__crn_key__!] : (o as Record<string, unknown>)[k];
        };
        const ts = (w: W): ((this: unknown) => string) => w.Function.prototype.toString;
        const loaded = (f: HTMLIFrameElement): Promise<void> => new Promise((r) => f.addEventListener("load", () => r(), { once: true }));
        const out: Record<string, string> = {};
        const self = window as unknown as W;

        // A loaded frame and its parent: two documents, two copies.
        const a = document.createElement("iframe");
        a.src = child;
        const la = loaded(a);
        document.body.appendChild(a);
        await la;
        const aw = a.contentWindow as unknown as W;
        out["child's toString on the parent's fetch"] = ts(aw).call(self.fetch);
        out["child's toString on the parent's eval"] = ts(aw).call(member(self, self, "eval"));
        out["parent's toString on the child's fetch"] = ts(self).call(aw.fetch);
        out["parent's toString on the child's eval"] = ts(self).call(member(self, aw, "eval"));
        out["child's toString on the parent's toString"] = ts(aw).call(ts(self));
        out["parent's toString on the child's toString"] = ts(self).call(ts(aw));
        out["the child's eval, read twice by the parent"] = String(member(self, aw, "eval") === member(self, aw, "eval"));
        out["the child's eval, read by the parent and by the child"] = String(member(self, aw, "eval") === member(aw, aw, "eval"));

        // Turnstile's probe, from inside the loaded frame: an empty
        // sandboxed frame in a closed shadow root, its toString on eval.
        const host = aw.document.createElement("div");
        aw.document.body.appendChild(host);
        const g = aw.document.createElement("iframe");
        g.setAttribute("sandbox", "allow-same-origin");
        host.attachShadow({ mode: "closed" }).appendChild(g);
        const gw = g.contentWindow as unknown as W;
        out["probe frame's toString on its own eval"] = ts(gw).call(member(aw, gw, "eval"));
        out["probe frame's toString on its maker's eval"] = ts(gw).call(member(aw, aw, "eval"));
        out["probe frame's toString on the top window's eval"] = ts(gw).call(member(self, self, "eval"));
        out["probe frame's toString on its maker's fetch"] = ts(gw).call(aw.fetch);
        out["top window's toString on the probe frame's fetch"] = ts(self).call(gw.fetch);
        out["probe frame's toString on the top window's toString"] = ts(gw).call(ts(self));
        return out;
    };

    it("a toString from any window of the page shows every window's natives as natives", async () => {
        const run = async (path: string, child: string): Promise<Record<string, string>> => {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(e.message));
            await page.goto(origin + path);
            const got = await page.evaluate(read, child);
            await page.close();
            expect(errors).toEqual([]);
            return got;
        };
        const direct = await run("/page", "/child");
        const proxied = await run("/cyrano/https/site.example/page", "https://site.example/child");
        expect(direct["probe frame's toString on its own eval"]).toBe("function eval() { [native code] }");
        expect(proxied).toEqual(direct);
    });
});
