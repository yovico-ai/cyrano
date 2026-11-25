// @vitest-environment node
//
// A child frame reached by name, in real Chromium, direct and through the
// real proxy (it was the raw window: a parent read another origin's frame's
// document). A frame of another origin is the cross-origin view, by name as
// by index; one of the page's origin is its window.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("a child frame by name, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/child") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<p>child</p>"); }
            const b = `http://localhost:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><iframe name="kid" src="${b}/child"></iframe><iframe name="own" src="/child"></iframe><script>
window.out = null;
onload = () => {
  const t = (f) => { try { return String(f()); } catch (e) { return e.name; } };
  out = { kidDoc: t(() => kid.document.title), kidWin: t(() => window["kid"].document), ownDoc: t(() => own.document.querySelector("p").textContent),
    type: typeof kid, same: String(kid === frames[0]), ownSame: String(own === frames[1]), missing: typeof nothingNamedSo,
    listed: String(Object.getOwnPropertyNames(Window.prototype).includes("kid")), described: String(Object.getOwnPropertyDescriptor(Window.prototype, "kid")),
    own: String(Window.prototype.hasOwnProperty("kid")), inWin: String("kid" in window) };
  const late = document.createElement("iframe"); late.name = "late"; late.src = "${b}/child"; document.body.append(late);
  out.late = t(() => late.contentWindow === window.late);
  // still its initial about:blank: readable and writable until the navigation commits
  const w = late.contentWindow;
  out.lateDoc = t(() => w.document.URL); out.lateLoc = t(() => w.location.href);
  out.lateWrite = t(() => { w.crnProbe = 7; return w.crnProbe; }); out.lateSelf = t(() => w.window === w && w.self === w);
  out.lateFn = t(() => w.setTimeout === w.setTimeout && typeof w.setTimeout); out.lateIn = t(() => "document" in w);
  late.addEventListener("load", () => { out.lateAfter = t(() => w.document); out.lateKept = t(() => w === late.contentWindow && w === window.late); });
  // the refusals in Blink's words (crazygames.com: the bare message)
  const m = (f) => { try { f(); return "ok"; } catch (e) { return e.name + ": " + e.message; } };
  const k = frames[0];
  out.msgs = [m(() => k.document), m(() => k[Symbol.iterator]), m(() => { k.foo = 1; }), m(() => "foo" in k), m(() => Object.getOwnPropertyDescriptor(k, "foo")),
    m(() => Object.defineProperty(k, "foo", { value: 1 })), m(() => { delete k.foo; }), m(() => k.location.href), m(() => { k.location.foo = 1; }),
    m(() => { const d = Object.getOwnPropertyDescriptor(k.location, "href"); return [typeof d.get, typeof d.set, d.enumerable, d.configurable].join(); }), m(() => k.alert())].join(" | ");
  window.kid = 5; out.assigned = String(kid) + "/" + String(window.hasOwnProperty("kid"));
};
</script>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${port0}`;
        void self;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", process.env.CYRANO_ASSETS ?? resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false" },
            stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(proxyOrigin + "/")).ok) break; } catch { /* starting */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        upstream?.close();
    });

    const run = async (proxied: boolean): Promise<unknown> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const p = await browser.newPage();
        await p.goto(url);
        await new Promise((res) => setTimeout(res, 1500));
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await p.close();
        return out;
    };

    it("is the cross-origin view, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toMatchObject({ kidDoc: "SecurityError", kidWin: "SecurityError", ownDoc: "child", type: "object", same: "true", ownSame: "true", missing: "undefined",
            listed: "false", described: "undefined", own: "false", inWin: "true", late: "true", assigned: "5/true",
            lateDoc: "about:blank", lateLoc: "about:blank", lateWrite: "7", lateSelf: "true", lateFn: "function", lateIn: "true", lateAfter: "SecurityError", lateKept: "true" });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
