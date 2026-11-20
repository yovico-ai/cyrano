// Runs under happy-dom — patches the global Blob constructor, then restores
// it so other test files see the native Blob again.

import { unmarked } from "../../src/js/marks";
import { describe, expect, it } from "vitest";
import type { ClientConfig } from "../../src/config";
import { patchBlobWorkerSource } from "../../src/patches/blob-worker-source";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    cacheKey: "",
    source: "/rewriter.js",
    version: "0.0.1",
    rewrite_css_selectors: false,
};

// A window of our own: the native Blob, and a stand-in URL whose
// createObjectURL remembers each Blob, so the private worker script can be
// read back. (happy-dom's URL statics cannot be redefined.)
let made: Map<string, Blob>;
let win: { Blob: typeof Blob; URL: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void } };
function setUp(href = "https://claude.ai/cdn-cgi/challenge-platform/x", XMLHttpRequest?: unknown) {
    made = new Map();
    let n = 0;
    win = {
        Blob: globalThis.Blob,
        URL: {
            createObjectURL: (b: Blob) => { const u = `blob:test/${++n}`; made.set(u, b); return u; },
            revokeObjectURL: () => undefined,
        },
        ...(XMLHttpRequest ? { XMLHttpRequest } : {}),
    } as typeof win;
    return patchBlobWorkerSource(win as unknown as Window, config, () => new URL(href));
}

const workerText = async (scriptFor: (u: string, module: boolean) => string | undefined, blob: Blob) => {
    const priv = scriptFor(win.URL.createObjectURL(blob), false);
    return priv === undefined ? undefined : made.get(priv)!.text();
};

describe("patchBlobWorkerSource", () => {
    it("leaves the page's own JS Blob exactly as made (the page cannot tell)", async () => {
        setUp();
        const blob = new win.Blob(["location.href"], { type: "text/javascript" });
        expect(await blob.text()).toBe("location.href");
        expect(blob.size).toBe("location.href".length);
        expect(blob.type).toBe("text/javascript");
    });

    it("gives the Worker a private script: worker runtime + rewritten source", async () => {
        const scriptFor = setUp();
        const text = await workerText(scriptFor, new win.Blob(["location.href"], { type: "text/javascript" }));
        // (Loaded as a TrustedScriptURL where Trusted Types are enforced.)
        expect(text).toContain('importScripts(p?p.createScriptURL("http://localhost:9081/rewriter.js"):"http://localhost:9081/rewriter.js")');
        expect(unmarked(String(text))).toContain("self.$rewriter=self.$rewriter_init_worker(");
        expect(text).toContain('"https://claude.ai/cdn-cgi/challenge-platform/x"');
        expect(text).toContain("self.$__crn_key__=null");
        expect(unmarked(String(text))).toContain("$rewriter.wrap_get_location(location)");
    });

    it("matches on javascript-like types with parameters (e.g. charset)", async () => {
        const scriptFor = setUp();
        const text = await workerText(scriptFor, new win.Blob(["1+1"], { type: "application/javascript;charset=utf-8" }));
        expect(text).toContain("importScripts(");
    });

    it("has no private script for non-JS, untyped or binary Blobs", async () => {
        const scriptFor = setUp();
        expect(await workerText(scriptFor, new win.Blob(["hello world"], { type: "text/plain" }))).toBeUndefined();
        expect(await workerText(scriptFor, new win.Blob(["some content"]))).toBeUndefined();
        const bytes = new TextEncoder().encode("console.log(1)");
        expect(await workerText(scriptFor, new win.Blob([bytes], { type: "text/javascript" }))).toBeUndefined();
    });

    it("joins multiple string parts before rewriting", async () => {
        const scriptFor = setUp();
        const text = await workerText(scriptFor, new win.Blob(["location", ".href"], { type: "text/javascript" }));
        expect(unmarked(String(text))).toContain("$rewriter.wrap_get_location(location)");
    });

    // Measured in Chromium (spec/WorkerSource.agda): a module worker whose
    // script is not of a JavaScript MIME type fails natively; it ran under
    // the proxy, from a text/javascript copy.
    it("a module worker gets a private script only for a JavaScript MIME type", () => {
        const scriptFor = setUp();
        const odd = win.URL.createObjectURL(new win.Blob(["1"], { type: "application/javascriptx" }));
        expect(scriptFor(odd, true)).toBeUndefined();
        expect(scriptFor(odd, false)).toBeDefined();
        const js = win.URL.createObjectURL(new win.Blob(["1"], { type: "Text/JavaScript; charset=utf-8" }));
        expect(scriptFor(js, true)).toBeDefined();
    });

    it("a script read back keeps its type: classic runs, module only if JavaScript", () => {
        let type = "text/plain;charset=US-ASCII";
        class XHR {
            status = 200;
            responseText = "postMessage(1)";
            open(): void { /* sync */ }
            overrideMimeType(): void { /* kept */ }
            send(): void { /* done */ }
            getResponseHeader(n: string): string | null { return n.toLowerCase() === "content-type" ? type : null; }
        }
        // (There at load: it reads with the XMLHttpRequest it saved then.)
        const scriptFor = setUp(undefined, XHR);
        expect(scriptFor("data:,postMessage(1)", true)).toBeUndefined();
        expect(scriptFor("data:,postMessage(1)", false)).toBeDefined();
        type = "text/livescript";
        expect(scriptFor("data:text/livescript,postMessage(1)", true)).toBeDefined();
    });

    // The module worker's init import carries the page URL in ?u= (the Go
    // server's workerInitHandler reads it back): what it reads is the URL.
    it("a module worker's init import carries the page URL exactly", async () => {
        for (const href of ["https://h.example/p?a=b&u=c#f", "https://h.example/%25/x+y/é?q=a b;c", "https://h.example/😀?</script>"]) {
            const scriptFor = setUp(href);
            const priv = scriptFor(win.URL.createObjectURL(new win.Blob(["1"], { type: "text/javascript" })), true)!;
            const text = await made.get(priv)!.text();
            const spec = JSON.parse(text.slice(text.indexOf("import ") + 7, text.indexOf(";\n"))) as string;
            expect(new URL(spec).searchParams.get("u")).toBe(new URL(href).href);
        }
    });
});

