// Runs under happy-dom — patches the global Blob constructor, then restores
// it so other test files see the native Blob again.

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
function setUp(href = "https://claude.ai/cdn-cgi/challenge-platform/x") {
    made = new Map();
    let n = 0;
    win = {
        Blob: globalThis.Blob,
        URL: {
            createObjectURL: (b: Blob) => { const u = `blob:test/${++n}`; made.set(u, b); return u; },
            revokeObjectURL: () => undefined,
        },
    };
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
        expect(text).toContain('importScripts("http://localhost:9081/rewriter.js")');
        expect(text).toContain("self.$rewriter=self.$rewriter_init_worker(");
        expect(text).toContain('"https://claude.ai/cdn-cgi/challenge-platform/x"');
        expect(text).toContain("self.$__crn_key__=null;");
        expect(text).toContain("$rewriter.wrap_get_location(location)");
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
        expect(text).toContain("$rewriter.wrap_get_location(location)");
    });
});
