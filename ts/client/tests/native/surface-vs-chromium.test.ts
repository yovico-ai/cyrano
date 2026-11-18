// @vitest-environment node
//
// The whole native surface (REQUIREMENTS.md): with the runtime installed,
// what page code can learn about every native member must be what it learns
// on a clean page. For each global and each member of every native
// prototype, compare in real Chromium:
//
//   typeof, own-property descriptor shape (value vs accessor, writable,
//   enumerable, configurable), and for every function involved (value,
//   getter, setter): name, length, own `prototype`, and toString() as page
//   code sees it (through the page's own Function.prototype.toString).
//
// Also the set of own global names: every extra global is listed (the
// AST-rewritten code needs `$rewriter`; anything else is a tell).
//
// Needs the built bundle (npm run build) and Playwright's Chromium from
// ts/e2e; `make browser-check` runs it. Skipped otherwise.

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

// Globals the runtime defines on purpose: the AST rewriter emits calls to
// $rewriter, and $__crn_key__ is its bracket-key temporary.
const intendedGlobals = new Set(["$rewriter", "$rewriter_init", "$rewriter_init_worker", "$__crn_key__", "__nativeGetAttribute" /* this test's own probe */]);

type Page = {
    goto(u: string): Promise<unknown>;
    evaluate<T, A = undefined>(f: (a: A) => T, a?: A): Promise<T>;
    addScriptTag(o: { content: string }): Promise<unknown>;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// Runs in the page: a JSON-able snapshot of the native surface.
function snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    const toStr = Function.prototype.toString;
    const fnInfo = (f: unknown): string => {
        if (typeof f !== "function") return typeof f;
        let src: string;
        try { src = toStr.call(f); } catch (e) { src = `throws ${(e as Error).name}`; }
        const d = (k: string) => Object.getOwnPropertyDescriptor(f, k);
        return JSON.stringify([f.name, f.length, Object.prototype.hasOwnProperty.call(f, "prototype"),
            src, d("name")?.writable, d("length")?.writable]);
    };
    const describeProp = (o: object, k: string): string => {
        let d: PropertyDescriptor | undefined;
        try { d = Object.getOwnPropertyDescriptor(o, k); } catch { return "throws"; }
        if (!d) return "absent";
        if ("value" in d) {
            return JSON.stringify(["value", d.writable, d.enumerable, d.configurable, typeof d.value === "function" ? fnInfo(d.value) : typeof d.value]);
        }
        return JSON.stringify(["accessor", d.enumerable, d.configurable, fnInfo(d.get), fnInfo(d.set)]);
    };
    const g = globalThis as unknown as Record<string, unknown>;
    out["@globals"] = JSON.stringify(Object.getOwnPropertyNames(g).sort());
    for (const name of Object.getOwnPropertyNames(g)) {
        out[`window.${name}`] = describeProp(g, name);
        let v: unknown;
        try { v = g[name]; } catch { continue; }
        if (typeof v === "function" && /^[A-Z]/.test(name)) {
            const proto = (v as { prototype?: object }).prototype;
            if (proto && typeof proto === "object") {
                for (const k of Object.getOwnPropertyNames(proto)) out[`${name}.prototype.${k}`] = describeProp(proto, k);
            }
            for (const k of Object.getOwnPropertyNames(v)) out[`${name}.${k}`] = describeProp(v, k);
        }
    }
    // Instances page code holds, their own members — string and symbol keys.
    const instances: Array<[string, object]> = [
        ["document", document], ["Document.prototype", Document.prototype], ["location", location], ["navigator", navigator],
        ["history", history], ["performance", performance], ["screen", screen], ["localStorage", localStorage],
        ["sessionStorage", sessionStorage], ["console", console], ["window", window], ["Function.prototype", Function.prototype],
        ["Object.prototype", Object.prototype], ["Error", Error], ["Symbol", Symbol],
    ];
    for (const [label, o] of instances) {
        for (const k of Object.getOwnPropertyNames(o)) if (label !== "window") out[`${label}#${k}`] = describeProp(o, k);
        out[`${label}@symbols`] = JSON.stringify(Object.getOwnPropertySymbols(o).map(String).sort());
    }
    // Symbol-keyed members of every native prototype.
    for (const name of Object.getOwnPropertyNames(g)) {
        let v: unknown;
        try { v = g[name]; } catch { continue; }
        const proto = typeof v === "function" && /^[A-Z]/.test(name) ? (v as { prototype?: object }).prototype : undefined;
        if (!proto || typeof proto !== "object") continue;
        const syms = Object.getOwnPropertySymbols(proto);
        if (syms.length) out[`${name}.prototype@symbols`] = JSON.stringify(syms.map((sy) => [String(sy), describeProp(proto, sy as unknown as string)]));
    }
    // The global symbol registry: keys a script can ask for by name.
    out["@registry"] = JSON.stringify(["rewriter.patched", "cyrano.native.postMessage", "cyrano.postMessage.send"].map((k) =>
        Object.getOwnPropertySymbols(window).some((sy) => Symbol.keyFor(sy) === k)));
    return out;
}

describe.skipIf(!wanted)("native surface in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        server = createServer((req, res) => {
            if ((req.url ?? "").endsWith(".js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end("window.__stack = (function inPage(){ try { null.x } catch (e) { return [e.stack, e instanceof TypeError, e.constructor === TypeError, Object.getPrototypeOf(TypeError) === Error, 'prepareStackTrace' in Error, Object.getOwnPropertyNames(Error).includes('prepareStackTrace')]; } })();");
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end("<!doctype html><html><head></head><body></body></html>");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        const addr = server.address() as { port: number };
        origin = `http://127.0.0.1:${addr.port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    it("every native member reads as native", async () => {
        const pageURL = `${origin}/cyrano/https/example.com/a/b`;
        const clean = await browser.newPage();
        await clean.goto(pageURL);
        const before = await clean.evaluate(snapshot);

        const patched = await browser.newPage();
        await patched.goto(pageURL);
        await patched.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/unbound-method
            Object.defineProperty(window, "__nativeGetAttribute", { value: Element.prototype.getAttribute, enumerable: false });
        });
        await clean.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/unbound-method
            Object.defineProperty(window, "__nativeGetAttribute", { value: Element.prototype.getAttribute, enumerable: false });
        });
        await patched.addScriptTag({ content: readFileSync(bundlePath, "utf8") });
        await patched.evaluate((o: string) => {
            const w = window as unknown as { $rewriter_init(w: Window, c: object): { inject(): { set_location(u: string): void } }; $rewriter: unknown };
            const api = w.$rewriter_init(window, { apiBaseURL: o }).inject();
            w.$rewriter = api;
            api.set_location("https://example.com/a/b");
        }, origin);
        const after = await patched.evaluate(snapshot);

        // …and the patches are really there: a surface match alone would
        // also hold if nothing had been installed.
        const works = await patched.evaluate((o: string) => {
            const img = document.createElement("img");
            img.src = "https://cdn.example/x.png";
            const f = new Function("return location.href");
            return {
                // What the element really holds, read with the native kept
                // from before the runtime was installed.
                stored: (window as unknown as { __nativeGetAttribute: (n: string) => string | null }).__nativeGetAttribute.call(img, "src"),
                attr: img.getAttribute("src"),
                readBack: img.src,
                documentURL: document.URL,
                fetchText: Function.prototype.toString.call(fetch),
                fnText: f.toString(),
                wsCtor: WebSocket.prototype.constructor === WebSocket,
                fnCtor: (function () { /* */ }).constructor === Function,
                origin: o,
            };
        }, origin);
        expect(works.stored).toBe(`${origin}/cyrano/https/cdn.example/x.png`);
        expect(works.readBack).toBe("https://cdn.example/x.png");
        expect(works.attr).toBe("https://cdn.example/x.png"); // the page reads what it set
        expect(works.documentURL).toBe("https://example.com/a/b");
        expect(works.fetchText).toBe("function fetch() { [native code] }");
        expect(works.fnText).toBe("function anonymous(\n) {\nreturn location.href\n}");
        expect(works.wsCtor).toBe(true);
        expect(works.fnCtor).toBe(true);

        // document.cookie: the page's own cookies, scoped as natively; the
        // real jar holds the wire form.
        const cookies = await patched.evaluate(() => {
            const realGet = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!.get!;
            document.cookie = "k=v; Path=/a";
            document.cookie = "elsewhere=1; Path=/zzz";
            document.cookie = "nope=1; Domain=other.example";
            document.cookie = "h=1; HttpOnly";
            const seen = document.cookie;
            document.cookie = "k=; Path=/a; Max-Age=0";
            return { seen, after: document.cookie, real: Function.prototype.toString.call(realGet) };
        });
        expect(cookies.seen).toBe("k=v");
        expect(cookies.after).toBe("");
        expect(cookies.real).toBe("function get cookie() { [native code] }");

        // The location rewritten code sees is shaped as the native one:
        // same own members and descriptors, native-looking functions, and
        // the original page's values.
        const loc = await patched.evaluate(() => {
            const fnInfo = (f: unknown) => typeof f === "function"
                ? [f.name, f.length, Function.prototype.toString.call(f), Object.prototype.hasOwnProperty.call(f, "prototype")]
                : typeof f;
            const shape = (o: object) => Reflect.ownKeys(o).map((k) => {
                const d = Object.getOwnPropertyDescriptor(o, k)!;
                return [String(k), d.enumerable, d.configurable, "value" in d ? ["value", d.writable, fnInfo(d.value)] : ["accessor", fnInfo(d.get), fnInfo(d.set)]];
            });
            const v = (window as unknown as { $rewriter: { wrap_get_location(l: Location): Location } }).$rewriter.wrap_get_location(location);
            return {
                same: JSON.stringify(shape(v)) === JSON.stringify(shape(location)),
                diff: JSON.stringify(shape(v)).slice(0, 400),
                real: JSON.stringify(shape(location)).slice(0, 400),
                isLocation: v instanceof Location,
                tag: Object.prototype.toString.call(v),
                href: v.href, host: v.host, str: String(v),
                aoIsList: v.ancestorOrigins instanceof DOMStringList,
            };
        });
        expect(loc.same, `${loc.diff}\n${loc.real}`).toBe(true);
        expect([loc.isLocation, loc.tag, loc.aoIsList]).toEqual([true, "[object Location]", true]);
        expect([loc.href, loc.host, loc.str]).toEqual(["https://example.com/a/b", "example.com", "https://example.com/a/b"]);

        // Stacks name the original script URL, and no cyrano frame. The page's
        // script below is loaded from a proxied URL, as on a proxied page.
        const stack = await patched.evaluate(async (o: string) => {
            const s = document.createElement("script");
            s.textContent = "";
            const code = "window.__stack = (function inPage(){ try { null.x } catch (e) { return [e.stack, e instanceof TypeError, e.constructor === TypeError, Object.getPrototypeOf(TypeError) === Error, 'prepareStackTrace' in Error, Object.getOwnPropertyNames(Error).includes('prepareStackTrace')]; } })();";
            const blobless = `${o}/cyrano/https/example.com/app.js`;
            await new Promise<void>((res) => {
                const el = document.createElement("script");
                el.onload = () => res();
                el.onerror = () => res();
                // Served by the test server: any path returns `code` for .js.
                (window as unknown as { __code: string }).__code = code;
                el.src = blobless;
                document.head.appendChild(el);
            });
            return (window as unknown as { __stack: unknown[] }).__stack;
        }, origin);
        expect(stack?.[0]).toContain("at inPage (https://example.com/app.js:");
        expect(String(stack?.[0])).not.toContain("/cyrano/");
        expect(stack?.slice(1)).toEqual([true, true, true, false, false]);

        const globalsBefore = new Set(JSON.parse(before["@globals"]!) as string[]);
        const extraGlobals = (JSON.parse(after["@globals"]!) as string[])
            .filter((n) => !globalsBefore.has(n) && !intendedGlobals.has(n));
        const tells: string[] = [];
        for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (k === "@globals") continue;
            if (k.startsWith("window.") && intendedGlobals.has(k.slice(7))) continue;
            if (before[k] !== after[k]) tells.push(`${k}\n    clean:   ${before[k] ?? "absent"}\n    patched: ${after[k] ?? "absent"}`);
        }
        const report = [`extra globals: ${extraGlobals.join(", ") || "none"}`, `${tells.length} members differ:`, ...tells].join("\n");
        expect.soft(extraGlobals, report).toEqual([]);
        expect(tells.length, report).toBe(0);
    }, 120_000);
});
