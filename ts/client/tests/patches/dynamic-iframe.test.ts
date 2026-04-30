// Runs under happy-dom. Tests that dynamically-appended iframes get the
// rewriter injected synchronously inside the appendChild/insertBefore call —
// before the caller gets control back to access contentDocument.

import { afterEach, describe, expect, it, vi } from "vitest";
import { patchDynamicIframeAppend, unpatchDynamicIframeAppend } from "../../src/patches/dynamic-iframe";
import * as iframeInjection from "../../src/runtime/iframe-injection";

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
    it("calls injectIntoIframe when an iframe is appended", () => {
        const spy = vi.spyOn(iframeInjection, "injectIntoIframe").mockImplementation(() => {});
        install();

        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);

        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(iframe, window, config, BASE_HREF);
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
