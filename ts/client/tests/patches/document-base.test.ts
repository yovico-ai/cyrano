// Runs under happy-dom. A URL a script hands over resolves against the
// document's base URL — a <base href> where the page has one — not the
// page's location (install.ts documentBase). The browser holds the base
// proxied; its original is the document's base.
//
// happy-dom's Node.baseURI throws on a Document (it looks for the
// document's ownerDocument) and reads the <base> element's `href` property,
// which the runtime wraps (a browser's baseURI runs no page-visible
// getter). The file gives Node.prototype a baseURI as the browser's —
// the first <base href> resolved against the document URL, from the
// attribute itself — before the runtime captures it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rewriteUrl } from "../../src/url/containment";
import { init } from "../../src/runtime/bootstrap";
import type { ClientConfig } from "../../src/config";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    cacheKey: "",
    source: "/rewriter.js",
    version: "",
    rewrite_css_selectors: false,
};

const nativeGetAttribute = Element.prototype.getAttribute;
const nativeSetAttribute = Element.prototype.setAttribute;
const savedBaseURI = Object.getOwnPropertyDescriptor(Node.prototype, "baseURI")!;

beforeAll(() => {
    Object.defineProperty(Node.prototype, "baseURI", {
        configurable: true,
        enumerable: true,
        get(this: Node): string {
            const doc = this.nodeType === 9 ? (this as Document) : this.ownerDocument!;
            const docUrl = doc.location?.href ?? "about:blank";
            const base = doc.querySelector("base[href]");
            if (!base) return docUrl;
            try { return new URL(nativeGetAttribute.call(base, "href")!, docUrl).href; } catch { return docUrl; }
        },
    });
});

afterAll(() => {
    Object.defineProperty(Node.prototype, "baseURI", savedBaseURI);
});

const PAGE = "https://page.example/dir/page.html";
const proxify = (absolute: string): string => rewriteUrl(absolute, new URL(PAGE), config);

// One frame with one runtime for the file (happy-dom frames share their
// parent's prototypes, so a second runtime would wrap the first one's
// wrappers); each test sets the frame's <base> itself.
let child: Window;
const calls: unknown[][] = [];

beforeAll(() => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    child = iframe.contentWindow!;
    const fake = (...a: unknown[]): Promise<Response> => { calls.push(a); return Promise.resolve(new Response("ok")); };
    Object.defineProperty(child, "fetch", { value: fake, writable: true, configurable: true });
    const api = init(child, config).inject();
    api.set_location(PAGE);
});

function setBase(href: string | null): void {
    for (const b of Array.from(child.document.querySelectorAll("base"))) b.remove();
    calls.length = 0;
    if (href === null) return;
    const base = child.document.createElement("base");
    // As the server leaves it in the page: the attribute holds the proxied URL.
    nativeSetAttribute.call(base, "href", href);
    child.document.head.appendChild(base);
    expect(nativeGetAttribute.call(base, "href")).toBe(href);
}

describe("relative URLs resolve against <base href>", () => {
    it("fetch('x.js') with a <base> on another host goes to the base's host", async () => {
        setBase(proxify("https://cdn.example/assets/"));
        await child.fetch("x.js");
        expect(calls[0]![0]).toBe(proxify("https://cdn.example/assets/x.js"));
    });

    it("script.src = 'lib.js' with a <base>: the script comes from the base's host", () => {
        setBase(proxify("https://cdn.example/assets/"));
        const script = child.document.createElement("script");
        script.src = "lib.js";
        expect(nativeGetAttribute.call(script, "src")).toBe(rewriteUrl("https://cdn.example/assets/lib.js", new URL(PAGE), config, undefined, "js"));
    });

    it("an absolute URL is unaffected by the base", async () => {
        setBase(proxify("https://cdn.example/assets/"));
        await child.fetch("https://api.example/v1");
        expect(calls[0]![0]).toBe(proxify("https://api.example/v1"));
    });

    it("without a <base>: the page's URL", async () => {
        setBase(null);
        await child.fetch("x.js");
        expect(calls[0]![0]).toBe(proxify("https://page.example/dir/x.js"));
    });

    it("a <base> that is not a proxied URL: the page's URL", async () => {
        // (A base the server did not rewrite is on the proxy's own origin: it has no original.)
        setBase("http://localhost:9081/other/");
        await child.fetch("x.js");
        expect(calls[0]![0]).toBe(proxify("https://page.example/dir/x.js"));
    });
});
