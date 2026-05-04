// Runs under happy-dom. Tests that dynamically-appended iframes get the
// rewriter injected synchronously inside the appendChild/insertBefore call —
// before the caller gets control back to access contentDocument.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patchDynamicIframeAppend, unpatchDynamicIframeAppend } from "../../src/patches/dynamic-iframe";
import * as iframeInjection from "../../src/runtime/iframe-injection";
import { init } from "../../src/runtime/bootstrap";
import { clearStore } from "../../src/cookies/in-memory-store";

const PROXY_ORIGIN = "http://localhost:9081";
const BASE_HREF = `${PROXY_ORIGIN}/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS8`;

const config = {
    apiBaseURL: PROXY_ORIGIN,
    cacheKey: "",
    source: "/rewriter.js",
    secretCookieName: "crnsct",
    userDataEncryption: false,
    version: "",
    rewrite_css_selectors: false,
};

function install(): void {
    patchDynamicIframeAppend(window, config, () => BASE_HREF);
}

afterEach(() => {
    unpatchDynamicIframeAppend(window);
    // Restore real Node prototype methods in case happy-dom kept the patched ones.
    // unpatch only clears the WeakSet; the prototype methods need manual restore.
    // We do this by re-running the setup so vitest's happy-dom reset handles it.
    vi.restoreAllMocks();
});

describe("patchDynamicIframeAppend — appendChild", () => {
    it("calls injectIntoIframe when an iframe with no src is appended", () => {
        const spy = vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);

        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(iframe, window, config, BASE_HREF);
    });

    it("skips injection for iframes whose src is already a proxied URL", () => {
        // When src is set before appendChild, patchDynamicIframeAppend must NOT
        // inject. Same-origin navigations reuse the window object; injecting now
        // would stamp PATCHED_FLAG onto the about:blank window and prevent the
        // server-injected bootstrap from reinstalling patches with the correct
        // base URL for the iframe's own origin.
        const spy = vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        const iframe = document.createElement("iframe");
        iframe.src = `${PROXY_ORIGIN}/cyrano/https/embed.example.com/widget`;
        document.body.appendChild(iframe);

        expect(spy).not.toHaveBeenCalled();
    });

    it("injects for iframes with about:blank src", () => {
        const spy = vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        const iframe = document.createElement("iframe");
        iframe.src = "about:blank";
        document.body.appendChild(iframe);

        expect(spy).toHaveBeenCalledOnce();
    });

    it("does not call injectIntoIframe for non-iframe elements", () => {
        const spy = vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        document.body.appendChild(document.createElement("div"));
        document.body.appendChild(document.createElement("script"));
        document.body.appendChild(document.createElement("img"));

        expect(spy).not.toHaveBeenCalled();
    });

    it("returns the appended node", () => {
        vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        const iframe = document.createElement("iframe");
        const result = document.body.appendChild(iframe);
        expect(result).toBe(iframe);
    });

    it("is idempotent — installing twice on the same window patches only once", () => {
        const spy = vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();
        install(); // second call should be a no-op

        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);

        expect(spy).toHaveBeenCalledOnce();
    });
});

describe("patchDynamicIframeAppend — insertBefore", () => {
    it("calls injectIntoIframe when an iframe is inserted", () => {
        const spy = vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        const iframe = document.createElement("iframe");
        document.body.insertBefore(iframe, null);

        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(iframe, window, config, BASE_HREF);
    });

    it("returns the inserted node", () => {
        vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        const iframe = document.createElement("iframe");
        const result = document.body.insertBefore(iframe, null);
        expect(result).toBe(iframe);
    });
});

// ── End-to-end: PATCHED_FLAG / bootstrap compatibility ─────────────────────
//
// When patchDynamicIframeAppend injects the rewriter into an iframe window it
// stamps Symbol.for("rewriter.patched") on that window.  Same-origin
// navigations reuse the window object, so if a proxied-src iframe was injected
// synchronously at appendChild time the stamp would still be present when the
// server-injected bootstrap runs — causing installPatches to bail out early.
// The DOM patches (fetch, XHR, URL attrs, document.cookie) would then remain
// wired to the PARENT's closure, using the parent's URL for cookie path
// filtering instead of the iframe's own URL.
//
// The fix: skip injection for iframes whose src is already a proxied URL.
// The two tests below verify both sides of the invariant.

const PATCHED_FLAG = Symbol.for("rewriter.patched");

describe("iframe bootstrap / PATCHED_FLAG (end-to-end)", () => {
    beforeEach(() => {
        clearStore();
    });

    it("without prior injection: bootstrap installs patches with iframe's own URL", () => {
        // No patchDynamicIframeAppend installed — simulates our fix skipping
        // injection for a proxied-src iframe.  Bootstrap runs on a clean window.
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const child = iframe.contentWindow!;

        expect((child as Record<symbol, unknown>)[PATCHED_FLAG]).toBeUndefined();

        // Bootstrap: install with the iframe's own URL.
        const api = init(child, config).inject();
        api.set_location("https://embed.example.com/widget/comments");

        // Cookie with Path=/widget should be visible at /widget/comments.
        child.document.cookie = "embed_tok=abc; Path=/widget";
        expect(child.document.cookie).toContain("embed_tok=abc");

        // Cookie scoped to an unrelated path must NOT leak through.
        child.document.cookie = "other=xyz; Path=/other";
        expect(child.document.cookie).not.toContain("other=xyz");
    });

    it("with PATCHED_FLAG pre-set (old behaviour): bootstrap is a no-op, patches use parent URL", () => {
        // Demonstrates the bug that the proxied-src skip prevents.
        // We manually simulate the pre-fix scenario: parent injection stamps
        // PATCHED_FLAG before the bootstrap runs.
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const child = iframe.contentWindow!;

        // Parent injection: stamp flag, set parent URL.
        const parentApi = init(child, config).inject();
        parentApi.set_location("https://www.zerohedge.com/news");

        // Bootstrap runs but inject() is a no-op — PATCHED_FLAG is already set.
        const bootstrapApi = init(child, config).inject();
        bootstrapApi.set_location("https://embed.example.com/widget/comments");

        // document.cookie is stuck on the parent closure's URL (/news).
        // A cookie at Path=/widget does NOT match /news → invisible to the iframe.
        child.document.cookie = "embed_tok=abc; Path=/widget";
        expect(child.document.cookie).not.toContain("embed_tok=abc");

        // A cookie at Path=/news matches — parent-scoped cookies bleed in.
        child.document.cookie = "news_tok=xyz; Path=/news";
        expect(child.document.cookie).toContain("news_tok=xyz");
    });
});
