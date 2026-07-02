// Runs under happy-dom — patches the global Blob constructor, then restores
// it so other test files see the native Blob again.

import { afterEach, describe, expect, it } from "vitest";
import type { ClientConfig } from "../../src/config";
import { patchBlobWorkerSource } from "../../src/patches/blob-worker-source";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    cacheKey: "",
    source: "/rewriter.js",
    secretCookieName: "crnsct",
    userDataEncryption: false,
    version: "0.0.1",
    rewrite_css_selectors: false,
};

const NativeBlob = globalThis.Blob;

afterEach(() => {
    globalThis.Blob = NativeBlob;
});

describe("patchBlobWorkerSource", () => {
    it("prepends a worker bootstrap and rewrites JS source for a JS-typed Blob", async () => {
        patchBlobWorkerSource(config, () => new URL("https://claude.ai/cdn-cgi/challenge-platform/x"));

        const blob = new Blob(["location.href"], { type: "text/javascript" });
        const text = await blob.text();

        expect(text).toContain('importScripts("http://localhost:9081/rewriter.js")');
        expect(text).toContain("self.$rewriter=self.$rewriter_init_worker(");
        expect(text).toContain('"https://claude.ai/cdn-cgi/challenge-platform/x"');
        expect(text).toContain("self.$__crn_key__=null;");
        expect(text).toContain("$rewriter.wrap_get_location(location)");
    });

    it("matches on javascript-like types with parameters (e.g. charset)", async () => {
        patchBlobWorkerSource(config, () => new URL("https://claude.ai/"));

        const blob = new Blob(["1+1"], { type: "application/javascript;charset=utf-8" });
        const text = await blob.text();

        expect(text).toContain("importScripts(");
    });

    it("leaves non-JS-typed Blobs untouched", async () => {
        patchBlobWorkerSource(config, () => new URL("https://claude.ai/"));

        const blob = new Blob(["hello world"], { type: "text/plain" });
        const text = await blob.text();

        expect(text).toBe("hello world");
    });

    it("leaves untyped Blobs untouched", async () => {
        patchBlobWorkerSource(config, () => new URL("https://claude.ai/"));

        const blob = new Blob(["some content"]);
        const text = await blob.text();

        expect(text).toBe("some content");
    });

    it("leaves JS-typed Blobs with non-string parts untouched", async () => {
        patchBlobWorkerSource(config, () => new URL("https://claude.ai/"));

        const bytes = new TextEncoder().encode("console.log(1)");
        const blob = new Blob([bytes], { type: "text/javascript" });
        const text = await blob.text();

        expect(text).toBe("console.log(1)");
    });

    it("joins multiple string parts before rewriting", async () => {
        patchBlobWorkerSource(config, () => new URL("https://claude.ai/"));

        const blob = new Blob(["location", ".href"], { type: "text/javascript" });
        const text = await blob.text();

        expect(text).toContain("$rewriter.wrap_get_location(location)");
    });
});
