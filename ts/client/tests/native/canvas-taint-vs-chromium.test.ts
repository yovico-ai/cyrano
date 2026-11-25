// @vitest-environment node
//
// Canvas origin-clean, in real Chromium, direct and through the real proxy
// (round K's built-in survey: through the proxy every image is same-origin
// to the browser, so nothing tainted a canvas — getImageData, toDataURL,
// WebGL uploads and VideoFrames read another site's pixels where directly
// they throw; media of another origin played into Web Audio was heard
// where directly it is silence). spec/Canvas.agda imageClean; patches/canvas-taint.ts. Every
// way to taint and every reader measured: each outcome, error name and
// message as directly.
//
// Runs the server binary (go/assets/cyrano: ./go/scripts/build.sh) on a
// free port. Needs it and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const PNG64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG64, "base64");
// 16x16 red, 1 s, VP8 (ffmpeg -f lavfi -i color=c=red:s=16x16:d=1 -c:v libvpx)
// 440 Hz, 2 s, Vorbis (ffmpeg -f lavfi -i sine=frequency=440:duration=2 -c:a libvorbis)
const OGG = Buffer.from("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", "base64");
const WEBM = Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAQlEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggQP7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECPQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYhYzkg1LH+OGZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAJiWgDgibCBELqBEJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYhYzkg1LH+OGWfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnVCaueBAKO9gQAAgPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4A/oCDU0YAP79bvP/45k3MMT/jm3/8WE8DijI//FRAKOVgQAoALEBAAEQEAAYABhYL/QACAAAo5WBAFAAsQEAARAQABgAGFgv9AAIAACjlYEAeACxAQABEBAAGAAYWC/0AAgAAKOVgQCgALEBAAEQEAAYABhYL/QACAAAo5WBAMgAsQEAARAQABgAGFgv9AAIAACjlYEA8ACxAQABEBAAGAAYWC/0AAgAAKOVgQEYALEBAAEQEBRgAGFgv9AAIAAAo5WBAUAAsQEAARAQABgAGFgv9AAIAACjlYEBaACxAQABEBAAGAAYWC/0AAgAAKOVgQGQALEBAAEQEAAYABhYL/QACAAAo5WBAbgAsQEAARAQABgAGFgv9AAIAACjlYEB4ACxAQABEBAAGAAYWC/0AAgAAKOVgQIIALEBAAEQEAAYABhYL/QACAAAo5WBAjAAsQEAARAQABgAGFgv9AAIAACjlYECWACxAQABEBAAGAAYWC/0AAgAAKOVgQKAALEBAAEQEAAYABhYL/QACAAAo5WBAqgAsQEAARAQABgAGFgv9AAIAACjlYEC0ACxAQABEBAUYABhYL/QACAAAKOVgQL4ALEBAAEQEAAYABhYL/QACAAAo5WBAyAAsQEAARAQABgAGFgv9AAIAACjlYEDSACxAQABEBAAGAAYWC/0AAgAAKOVgQNwALEBAAEQEAAYABhYL/QACAAAo5WBA5gAsQEAARAQABgAGFgv9AAIAACjlYEDwACxAQABEBAAGAAYWC/0AAgAABxTu2uRu4+zgQC3iveBAfGCAZ/wgQM=", "base64");

const SCRIPT = `
window.out = (async () => {
  const other = "OTHER";
  const load = (src, co) => new Promise((ok) => { const i = new Image(); if (co) i.crossOrigin = co; i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
  const video = (src, co) => new Promise((ok) => { const v = document.createElement("video"); v.muted = true; if (co) v.setAttribute("crossorigin", co); v.onloadeddata = () => ok(v); v.onerror = () => ok(null); v.src = src; });
  const t = async (f) => { try { await f(); return "ok"; } catch (e) { return e.name + ": " + e.message; } };
  const c = (src) => { const cv = document.createElement("canvas"); const x = cv.getContext("2d"); if (src) x.drawImage(src, 0, 0); return [cv, x]; };
  const read = (x) => x.getImageData(0, 0, 1, 1);
  const xo = await load(other + "/i.png"), same = await load("/i.png"), rel = await load("i.png?rel"), cors = await load(other + "/i.png?cors", "anonymous");
  const data = await load("data:image/png;base64,PNG64");
  const r = {};
  let [cv, x] = c(xo);
  r.read = await t(() => read(x)); r.dataURL = await t(() => cv.toDataURL()); r.blob = await t(() => cv.toBlob(() => {}));
  r.blobNoCallback = await t(() => cv.toBlob()); r.zeroSize = await t(() => x.getImageData(0, 0, 0, 1));
  r.same = await t(() => read(c(same)[1])); r.rel = await t(() => read(c(rel)[1])); r.cors = await t(() => read(c(cors)[1])); r.data = await t(() => read(c(data)[1]));
  r.canvasInCanvas = await t(() => read(c(cv)[1]));
  let [, xp] = c(); xp.fillStyle = xp.createPattern(xo, "repeat"); xp.fillStyle = "red"; r.patternAssigned = await t(() => read(xp));
  [, xp] = c(); xp.createPattern(xo, "repeat"); xp.fillRect(0, 0, 1, 1); r.patternUnused = await t(() => read(xp));
  [, xp] = c(); xp.strokeStyle = xp.createPattern(same, "repeat"); r.patternSame = await t(() => read(xp));
  [cv, x] = c(xo); x.clearRect(0, 0, 300, 150); r.clearRect = await t(() => read(x));
  [cv, x] = c(xo); cv.width = cv.width; r.widthSet = await t(() => read(x));
  const bm = await createImageBitmap(xo); r.bitmap = await t(() => read(c(bm)[1]));
  r.bitmapSame = await t(async () => read(c(await createImageBitmap(same))[1]));
  const oc = new OffscreenCanvas(1, 1); const ox = oc.getContext("2d"); ox.drawImage(xo, 0, 0);
  r.offRead = await t(() => read(ox)); r.offBlob = await t(() => oc.convertToBlob());
  r.offTransfer = await t(() => read(c(oc.transferToImageBitmap())[1]));
  const brc = document.createElement("canvas"); brc.getContext("bitmaprenderer").transferFromImageBitmap(await createImageBitmap(xo)); r.bitmaprenderer = await t(() => brc.toDataURL());
  const gl = document.createElement("canvas").getContext("webgl"); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  const up = (s) => t(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s));
  r.glImage = await up(xo); r.glCanvas = await up(cv); r.glBitmap = await up(bm); r.glSame = await up(same);
  r.glSub = await t(() => gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, xo));
  const gl2 = document.createElement("canvas").getContext("webgl2"); r.gl2 = await t(() => gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, xo));
  r.frame = await t(() => new VideoFrame(xo, { timestamp: 0 }).close()); r.frameSame = await t(() => new VideoFrame(same, { timestamp: 0 }).close());
  const vx = await video(other + "/v.webm"), vc = await video(other + "/v.webm?cors", "anonymous");
  r.videoLoaded = [!!vx, !!vc];
  // a decoded frame first (before one, a WebGL upload of a video is a no-op natively)
  for (const v of [vx, vc]) if (v) { await v.play(); await new Promise((ok) => v.requestVideoFrameCallback(ok)); v.pause(); }
  if (vx) { r.video = await t(() => read(c(vx)[1])); r.glVideo = await up(vx); }
  if (vc) r.videoCors = await t(() => read(c(vc)[1]));
  const level = async (src, co) => {
    const ctx = new AudioContext(); const a = new Audio(); if (co) a.crossOrigin = co; a.src = src; a.loop = true;
    const s = ctx.createMediaElementSource(a); const an = ctx.createAnalyser(); const back = s.connect(an); an.connect(ctx.destination);
    await a.play(); await new Promise((ok) => setTimeout(ok, 700));
    const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v));
    const info = [back === an, s.mediaElement === a, s.numberOfOutputs, await t(() => s.connect(an, 1)), await t(() => s.disconnect(an)), await t(() => s.disconnect(an))];
    a.pause(); await ctx.close(); return [m > 0.01 ? "sound" : "silent", ...info];
  };
  r.audioOther = await level(other + "/t.ogg"); r.audioSame = await level("/t.ogg"); r.audioCors = await level(other + "/t.ogg?cors", "anonymous");
  r.svg = await new Promise((ok) => { const S = "http://www.w3.org/2000/svg"; const sv = document.createElementNS(S, "svg"); const s = document.createElementNS(S, "image"); s.setAttribute("href", other + "/i.png?svg"); sv.appendChild(s); document.body.appendChild(sv); s.onload = async () => ok(await t(() => read(c(s)[1]))); s.onerror = () => ok("error"); });
  return r;
})();
`;

describe.skipIf(!wanted)("canvas origin-clean, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = req.url ?? "/";
            const acao = u.includes("cors") ? { "access-control-allow-origin": "*" } : {};
            if (u.startsWith("/i.png")) { res.writeHead(200, { "content-type": "image/png", ...acao }); return res.end(PNG); }
            if (u.startsWith("/t.ogg")) { res.writeHead(200, { "content-type": "audio/ogg", ...acao }); return res.end(OGG); }
            if (u.startsWith("/v.webm")) { res.writeHead(200, { "content-type": "video/webm", ...acao }); return res.end(WEBM); }
            if (u === "/page.html") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end("<!doctype html><body><script>" + SCRIPT.replace("OTHER", other).replace("PNG64", PNG64) + "</script></body>");
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        const p0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${p0}`;
        other = `http://localhost:${p0}`;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false" },
            stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(proxyOrigin + "/")).ok) break; } catch { /* starting */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        upstream?.close();
    });

    const run = async (url: string): Promise<Record<string, unknown>> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<Record<string, unknown>> }).out);
        await page.close();
        return out;
    };

    it("taints and refuses as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        const tainted = "SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.";
        expect(direct).toMatchObject({ read: tainted, same: "ok", rel: "ok", cors: "ok", data: "ok", patternUnused: "ok", widthSet: "ok", videoLoaded: [true, true], video: tainted, videoCors: "ok", svg: tainted });
        expect([direct.audioOther, direct.audioSame, direct.audioCors].map((a) => (a as string[])[0])).toEqual(["silent", "sound", "sound"]);
        // A WebGL upload of a cross-origin video: headless Chromium refuses it
        // only sometimes (under load it did; WebGL requires it), so it is not
        // compared; the runtime refuses it.
        const { glVideo: _dg, ...d } = direct;
        const { glVideo: pg, ...p } = proxied;
        void _dg;
        expect(p).toEqual(d);
        expect(pg).toBe("SecurityError: Failed to execute 'texImage2D' on 'WebGLRenderingContext': The video element contains cross-origin data, and may not be loaded.");
    }, 90_000);
});
