// Runs under happy-dom. Patches the URL-bearing attribute setters on the
// HTMLImageElement / HTMLAnchorElement prototypes, then restores them after
// each test to keep cross-test isolation.

import { afterEach, describe, expect, it } from "vitest";
import { patchUrlAttributes } from "../../src/patches/url-attributes";

// Tag-suffix rewriter survives URL canonicalization (the DOM resolves attribute
// values through its URL parser, which lowercases scheme+host but preserves
// path and query verbatim).
const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";

interface SavedDescriptor {
    proto: object;
    attribute: string;
    descriptor: PropertyDescriptor;
}

const savedDescriptors: SavedDescriptor[] = [];

function snapshotProperty(proto: object, attribute: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(proto, attribute);
    if (!descriptor) return;
    savedDescriptors.push({ proto, attribute, descriptor });
}

afterEach(() => {
    while (savedDescriptors.length > 0) {
        const entry = savedDescriptors.pop()!;
        Object.defineProperty(entry.proto, entry.attribute, entry.descriptor);
    }
});

function snapshotAll(): void {
    snapshotProperty(HTMLImageElement.prototype, "src");
    snapshotProperty(HTMLImageElement.prototype, "srcset");
    snapshotProperty(HTMLAnchorElement.prototype, "href");
    snapshotProperty(HTMLLinkElement.prototype, "href");
    snapshotProperty(HTMLScriptElement.prototype, "src");
    snapshotProperty(HTMLIFrameElement.prototype, "src");
}

describe("patchUrlAttributes", () => {
    it("rewrites img.src on assignment (raw attribute reflects the rewritten value)", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const img = document.createElement("img");
        img.src = "http://example.com/a.png";
        // getAttribute returns the raw stored value, before any URL resolution.
        expect(img.getAttribute("src")).toBe("http://example.com/a.png?proxified=1");
    });

    it("rewrites img.srcset using srcset semantics (URL + descriptor)", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const img = document.createElement("img");
        img.srcset = "a.jpg 1x, b.jpg 2x";
        expect(img.getAttribute("srcset")).toBe("a.jpg?proxified=1 1x, b.jpg?proxified=1 2x");
    });

    it("rewrites a.href on assignment", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const a = document.createElement("a");
        a.href = "http://example.com/x";
        expect(a.getAttribute("href")).toBe("http://example.com/x?proxified=1");
    });

    it("rewrites script.src and iframe.src on assignment", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const script = document.createElement("script");
        script.src = "http://example.com/lib.js";
        expect(script.getAttribute("src")).toBe("http://example.com/lib.js?proxified=1");

        const iframe = document.createElement("iframe");
        iframe.src = "http://example.com/page";
        expect(iframe.getAttribute("src")).toBe("http://example.com/page?proxified=1");
    });

    it("passes through non-string assignments without invoking the rewriter", () => {
        const calls: unknown[] = [];
        const trackingTag = (url: string): string => {
            calls.push(url);
            return url;
        };
        snapshotAll();
        patchUrlAttributes(window, trackingTag);

        const img = document.createElement("img");
        // Setting to a non-string should not crash and should not call our
        // rewriter (which only takes strings).
        (img as unknown as { src: unknown }).src = null;
        expect(calls).toEqual([]);
    });
});
