// Runs under happy-dom. Tests for the MutationObserver safety net and
// retroactive iframe injection in installMutationObserver.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    installMutationObserver,
    getMissLog,
    clearMissLog,
} from "../../src/patches/mutation-observer";
import * as iframeInjection from "../../src/runtime/iframe-injection";

const PROXY_ORIGIN = "http://localhost:9081";
const config = {
    apiBaseURL: PROXY_ORIGIN,
    cacheKey: "",
    source: "/rewriter.js",
    secretCookieName: "crnsct",
    userDataEncryption: false,
    version: "",
    rewrite_css_selectors: false,
};

const proxify = (url: string): string =>
    url.startsWith(PROXY_ORIGIN) || url.startsWith("#") || url.startsWith("data:")
        ? url
        : `${PROXY_ORIGIN}/?goto=${btoa(url)}`;

// Flush the MutationObserver microtask queue.
const flushObserver = (): Promise<void> =>
    new Promise((r) => setTimeout(r, 0));

afterEach(() => {
    clearMissLog();
    vi.restoreAllMocks();
    // Clean up any elements added to the document.
    document.body.innerHTML = "";
});

describe("retroactive iframe injection", () => {
    it("injects rewriter into pre-existing iframes", () => {
        const spy = vi
            .spyOn(iframeInjection, "injectIntoIframe")
            .mockImplementation(() => {});

        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);

        const nativeSA = Element.prototype.setAttribute;
        installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute);

        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(iframe, window, config, PROXY_ORIGIN);
    });

    it("rewrites the src of an iframe with an unproxified URL", () => {
        const spy = vi
            .spyOn(iframeInjection, "injectIntoIframe")
            .mockImplementation(() => {});

        const iframe = document.createElement("iframe");
        // Set src via native setAttribute to bypass any existing patches.
        iframe.setAttribute("src", "https://widget.example.com/");
        document.body.appendChild(iframe);

        const nativeSA = Element.prototype.setAttribute;
        installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute);

        expect(iframe.getAttribute("src")).toBe(
            proxify("https://widget.example.com/"),
        );
        spy.mockRestore();
    });

    it("leaves already-proxified iframe src unchanged", () => {
        vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});

        const alreadyProxied = `${PROXY_ORIGIN}/?goto=${btoa("https://widget.example.com/")}`;
        const iframe = document.createElement("iframe");
        iframe.setAttribute("src", alreadyProxied);
        document.body.appendChild(iframe);

        const nativeSA = Element.prototype.setAttribute;
        installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute);

        expect(iframe.getAttribute("src")).toBe(alreadyProxied);
    });

    it("does nothing when no iframes exist", () => {
        const spy = vi
            .spyOn(iframeInjection, "injectIntoIframe")
            .mockImplementation(() => {});

        const nativeSA = Element.prototype.setAttribute;
        expect(() =>
            installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute),
        ).not.toThrow();

        expect(spy).not.toHaveBeenCalled();
    });
});

describe("MutationObserver safety net", () => {
    it("logs a miss and rewrites an unproxified src set after install", async () => {
        const nativeSA = Element.prototype.setAttribute;
        vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute);

        const img = document.createElement("img");
        document.body.appendChild(img);
        // Use native setAttribute to simulate a write that bypassed our patches.
        nativeSA.call(img, "src", "https://cdn.example.com/image.png");

        await flushObserver();

        expect(getMissLog()).toHaveLength(1);
        expect(getMissLog()[0]!.tagName).toBe("IMG");
        expect(getMissLog()[0]!.attr).toBe("src");
        expect(getMissLog()[0]!.originalValue).toBe("https://cdn.example.com/image.png");
        expect(getMissLog()[0]!.rewrittenValue).toBe(
            proxify("https://cdn.example.com/image.png"),
        );
        expect(img.getAttribute("src")).toBe(
            proxify("https://cdn.example.com/image.png"),
        );
    });

    it("does not log already-proxified attribute values", async () => {
        const nativeSA = Element.prototype.setAttribute;
        vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute);

        const img = document.createElement("img");
        document.body.appendChild(img);
        const already = proxify("https://cdn.example.com/image.png");
        nativeSA.call(img, "src", already);

        await flushObserver();

        expect(getMissLog()).toHaveLength(0);
    });

    it("does not log passthrough schemes (data:)", async () => {
        const nativeSA = Element.prototype.setAttribute;
        vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute);

        const img = document.createElement("img");
        document.body.appendChild(img);
        nativeSA.call(img, "src", "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==");

        await flushObserver();

        expect(getMissLog()).toHaveLength(0);
    });

    it("is a no-op when MutationObserver is unavailable", () => {
        const win = { document: document, MutationObserver: undefined } as unknown as Window;
        expect(() =>
            installMutationObserver(win, proxify, config, () => PROXY_ORIGIN, Element.prototype.setAttribute, Element.prototype.getAttribute),
        ).not.toThrow();
    });
});

describe("clearMissLog", () => {
    it("empties the miss log", async () => {
        const nativeSA = Element.prototype.setAttribute;
        vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        installMutationObserver(window, proxify, config, () => PROXY_ORIGIN, nativeSA, Element.prototype.getAttribute);

        const img = document.createElement("img");
        document.body.appendChild(img);
        nativeSA.call(img, "src", "https://cdn.example.com/x.png");
        await flushObserver();

        expect(getMissLog().length).toBeGreaterThan(0);
        clearMissLog();
        expect(getMissLog()).toHaveLength(0);
    });
});
