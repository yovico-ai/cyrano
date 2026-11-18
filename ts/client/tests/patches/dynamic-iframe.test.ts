// Runs under happy-dom. Tests that dynamically-appended iframes get the
// rewriter injected synchronously inside the appendChild/insertBefore call —
// before the caller gets control back to access contentDocument.

import { afterEach, describe, expect, it, vi } from "vitest";
import { rewriteUrl } from "../../src/url/containment";
import { patchDynamicIframeAppend, unpatchDynamicIframeAppend } from "../../src/patches/dynamic-iframe";
import * as iframeInjection from "../../src/runtime/iframe-injection";
import { init } from "../../src/runtime/bootstrap";

const PROXY_ORIGIN = "http://localhost:9081";
const BASE_HREF = `${PROXY_ORIGIN}/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS8`;

const config = {
    apiBaseURL: PROXY_ORIGIN,
    cacheKey: "",
    source: "/rewriter.js",
    version: "",
    rewrite_css_selectors: false,
};

const UPSTREAM = "https://pagead2.googlesyndication.com/bg/script.js";
const PROXIED  = `${PROXY_ORIGIN}/cyrano/https/pagead2.googlesyndication.com/bg/script.js`;

// The real containment function, as install.ts passes it.
const rewriteOne = (url: string): string => rewriteUrl(url, new URL(BASE_HREF), config);

function install(): void {
    patchDynamicIframeAppend(window, config, () => BASE_HREF, rewriteOne);
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

// ── URL rewriting before insert ─────────────────────────────────────────────
//
// Elements created in un-bootstrapped realms have upstream URLs in their src/
// href. The patch must rewrite these BEFORE calling origAppendChild so the
// browser fetches the proxied URL, not the upstream URL.

describe("patchDynamicIframeAppend — URL rewriting before insert", () => {
    it("rewrites upstream script.src before appendChild", () => {
        install();
        const script = document.createElement("script");
        script.setAttribute("src", UPSTREAM);
        document.head.appendChild(script);
        expect(script.getAttribute("src")).toBe(PROXIED);
    });

    it("rewrites upstream script.src before insertBefore", () => {
        install();
        const script = document.createElement("script");
        script.setAttribute("src", UPSTREAM);
        document.head.insertBefore(script, null);
        expect(script.getAttribute("src")).toBe(PROXIED);
    });

    it("leaves already-proxied script.src unchanged", () => {
        install();
        const script = document.createElement("script");
        script.setAttribute("src", PROXIED);
        document.head.appendChild(script);
        expect(script.getAttribute("src")).toBe(PROXIED);
    });

    it("proxifies a relative script.src against the page (else it would load from the proxy origin)", () => {
        install();
        const script = document.createElement("script");
        script.setAttribute("src", "/static/bundle.js");
        document.head.appendChild(script);
        expect(script.getAttribute("src")).toBe(rewriteUrl("/static/bundle.js", new URL(BASE_HREF), config));
    });

    it("rewrites upstream iframe.src before appendChild", () => {
        install();
        const iframe = document.createElement("iframe");
        iframe.setAttribute("src", "https://embed.example.com/widget");
        document.body.appendChild(iframe);
        expect(iframe.getAttribute("src")).toMatch(/\/cyrano\//);
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


// happy-dom gives an about:blank iframe no cookie jar; a browser shares the
// parent origin's. Give the child document a jar, as natively.
function giveJar(child: Window): void {
    const jar = new Map<string, string>();
    Object.defineProperty(Object.getPrototypeOf(child.document) as object, "cookie", {
        configurable: true,
        enumerable: true,
        get: () => [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
        set: (v: string) => {
            const pair = v.split(";")[0]!;
            const i = pair.indexOf("=");
            jar.set(pair.slice(0, i), pair.slice(i + 1));
        },
    });
}

describe("iframe bootstrap: one runtime per window (end-to-end)", () => {
    it("without prior injection: bootstrap installs patches with iframe's own URL", () => {
        // No patchDynamicIframeAppend installed — simulates our fix skipping
        // injection for a proxied-src iframe.  Bootstrap runs on a clean window.
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const child = iframe.contentWindow!;
        giveJar(child);


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

    it("a window already initialized by its parent: the page's own bootstrap reaches the same runtime", () => {
        // A parent injects the runtime into a child window; the child's own
        // bootstrap then runs in that same window (a same-origin navigation
        // from about:blank keeps it). The window is patched once, and the
        // second initialization gets the first one's API — so its
        // set_location moves the URL the installed patches read.
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const child = iframe.contentWindow!;
        giveJar(child);

        const parentApi = init(child, config).inject();
        parentApi.set_location("https://www.zerohedge.com/news");

        const bootstrapApi = init(child, config).inject();
        expect(bootstrapApi).toBe(parentApi);
        bootstrapApi.set_location("https://embed.example.com/widget/comments");

        child.document.cookie = "embed_tok=abc; Path=/widget";
        expect(child.document.cookie).toContain("embed_tok=abc");
        // Nothing marks the window itself.
        expect(Object.getOwnPropertySymbols(child).filter((sy) => /rewriter|cyrano/i.test(String(sy)))).toEqual([]);
    });
});
