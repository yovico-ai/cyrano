// @vitest-environment node
//
// WebRTC through cyrano's relay, in real Chromium, direct and through the
// real proxy with its TURN relay (spec/WebRtc.agda; internal/turn): two
// peer connections of a page join over a data channel. Directly they gather
// host candidates and ask the page's STUN server; proxied every candidate is
// a relay one, the page's STUN server hears nothing, the message still
// arrives, and getConfiguration reads back the page's own servers.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createSocket, type Socket } from "node:dgram";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("WebRTC through the relay, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    let stun: Socket;
    let stunHits = 0;
    beforeAll(async () => {
        stun = createSocket("udp4");
        stun.on("message", () => { stunHits++; });
        await new Promise<void>((r) => stun.bind(0, "127.0.0.1", () => r()));
        const stunPort = stun.address().port;
        upstream = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = null;
(async () => {
  const cfg = { iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }] };
  const a = new RTCPeerConnection(cfg), b = new RTCPeerConnection(cfg);
  const types = new Set();
  a.onicecandidate = (e) => { if (e.candidate) { types.add(e.candidate.type); b.addIceCandidate(e.candidate); } };
  b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate); };
  const got = new Promise((res) => { b.ondatachannel = (e) => { e.channel.onmessage = (m) => res(m.data); }; });
  const ch = a.createDataChannel("x");
  ch.onopen = () => ch.send("hello");
  await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
  const msg = await Promise.race([got, new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
  const c = a.getConfiguration();
  let bad = "";
  try { new RTCPeerConnection({ iceServers: [{ urls: "http://x" }] }); } catch (e) { bad = e.name + ": " + e.message; }
  const d = new RTCPeerConnection();
  d.setConfiguration({ iceServers: [{ urls: ["turn:t.example:3478"], username: "u", credential: "c" }] });
  const set = JSON.stringify(d.getConfiguration().iceServers);
  window.out = { msg, types: [...types].sort(), servers: JSON.stringify(c.iceServers), policy: c.iceTransportPolicy, bad, set };
})();
</script>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${port0}`;
        void self;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", process.env.CYRANO_ASSETS ?? resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false",
                CYRANO_TURN_PORT: String(await free()), CYRANO_TURN_IP: "127.0.0.1" },
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
        stun?.close();
    });

    const run = async (proxied: boolean): Promise<{ out: unknown; stunHits: number }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        stunHits = 0;
        const p = await browser.newPage();
        await p.goto(url);
        let out: unknown = null;
        for (let i = 0; i < 60 && out === null; i++) {
            await new Promise((res) => setTimeout(res, 200));
            out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        }
        await p.close();
        return { out, stunHits };
    };

    it("relays every connection, as the page set it up", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const servers = JSON.stringify([{ credential: "", urls: [`stun:127.0.0.1:${stun.address().port}`], username: "" }]);
        const bad = "SyntaxError: Failed to construct 'RTCPeerConnection': 'http://x' is not a valid stun or turn URL.";
        const set = JSON.stringify([{ credential: "c", urls: ["turn:t.example:3478"], username: "u" }]);
        expect(direct.out).toMatchObject({ msg: "hello", servers, policy: "all", bad, set });
        expect((direct.out as { types: string[] }).types).toContain("host");
        expect(direct.stunHits).toBeGreaterThan(0);
        expect(proxied.out).toEqual({ msg: "hello", types: ["relay"], servers, policy: "all", bad, set });
        expect(proxied.stunHits).toBe(0);
    }, 90_000);
});
