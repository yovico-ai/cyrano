// @vitest-environment node
//
// Mixed content, in real Chromium, direct and through the real proxy
// (a-hospital.com, 2026-11-22: its https page's http share.js ran proxied;
// directly it is blocked). Through the proxy every request is same-origin to
// the browser, so the proxy judges each as the browser would have
// (spec/MixedContent.agda): an https page's http image, audio, video are
// upgraded to https; its script, stylesheet, font, fetch(), frame blocked —
// each asset arrives as directly (over http, over https, or not at all).
//
// The page is https on cyrano.test (in /etc/hosts; the dev CA, trusted by the
// proxy through SSL_CERT_FILE), the assets http on another port of it — a
// host that is not loopback — which also answers TLS (an upgrade goes there).
// Runs the server binary (go/assets/cyrano); needs it, the dev CA and
// Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttp, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { createServer as createNet, type Server as NetServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const ca = "/home/igor/work/cyrano-dev-ca";
const host = "cyrano.test";
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary) && existsSync(`${ca}/cert.pem`) &&
    readFileSync("/etc/hosts", "utf8").split("\n").some((l) => !l.trim().startsWith("#") && l.split(/\s+/).includes(host));

type Page = { goto(u: string, o?: object): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const free = (): Promise<number> => new Promise((r) => { const s = createHttp().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("mixed content, in Chromium, through the proxy", () => {
    let browser: Browser;
    let page: ReturnType<typeof createHttps>;
    let assets: NetServer;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let pageOrigin = "";
    let seen: string[] = [];

    beforeAll(async () => {
        const tls = { cert: readFileSync(`${ca}/cert.pem`), key: readFileSync(`${ca}/key.pem`) };
        // The assets: plain HTTP and TLS on one port (by the first byte).
        const serve = (scheme: string) => (req: IncomingMessage, res: ServerResponse): void => {
            const n = (req.url ?? "").replace(/^\/([a-z]+).*$/, "$1");
            seen.push(`${scheme} ${n}`);
            const types: Record<string, string> = { img: "image/gif", js: "text/javascript", css: "text/css", font: "font/woff2", frame: "text/html", audio: "audio/wav" };
            res.writeHead(200, { "content-type": types[n] ?? "text/plain", "access-control-allow-origin": "*" });
            res.end(n === "img" ? GIF : "");
        };
        const plain: HttpServer = createHttp(serve("http"));
        const secure = createHttps(tls, serve("https"));
        assets = createNet({ pauseOnConnect: true }, (sock) => {
            sock.once("readable", () => {
                const b = sock.read(1) as Buffer | null;
                if (!b) return;
                sock.unshift(b);
                (b[0] === 0x16 ? secure : plain).emit("connection", sock);
            });
            sock.resume();
            sock.pause();
        });
        await new Promise<void>((r) => assets.listen(0, "127.0.0.1", () => r()));
        const a = `http://${host}:${(assets.address() as { port: number }).port}`;
        page = createHttps(tls, (_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<!doctype html><body><img src="${a}/img.gif"><script src="${a}/js.js"></script><link rel=stylesheet href="${a}/css.css">` +
                `<iframe src="${a}/frame.html"></iframe><audio src="${a}/audio.wav" preload=auto></audio>` +
                `<style>@font-face{font-family:f;src:url(${a}/font.woff2)} b{font-family:f}</style><b>x</b>` +
                `<script>fetch("${a}/fetch").catch(() => {});</script></body>`);
        });
        await new Promise<void>((r) => page.listen(0, "127.0.0.1", () => r()));
        pageOrigin = `https://${host}:${(page.address() as { port: number }).port}`;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, SSL_CERT_FILE: `${ca}/ca.pem`, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false" },
            stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(proxyOrigin + "/")).ok) break; } catch { /* starting */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        page?.close();
        assets?.close();
    });

    const run = async (url: string): Promise<string[]> => {
        seen = [];
        const p = await browser.newPage();
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => undefined);
        await new Promise((res) => setTimeout(res, 3000));
        await p.close();
        return [...new Set(seen)].sort();
    };

    it("each asset arrives as directly", async () => {
        const direct = await run(`${pageOrigin}/p`);
        const proxied = await run(`${proxyOrigin}/cyrano/https/${pageOrigin.slice(8)}/p`);
        expect(direct).toEqual(["https audio", "https img"]);
        expect(proxied).toEqual(direct);
    }, 90_000);
});
