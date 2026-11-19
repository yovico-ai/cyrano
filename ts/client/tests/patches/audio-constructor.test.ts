// Runs under happy-dom. new Audio(url): the browser sets the element's src
// itself, past the src setter — the wrapped constructor proxifies the URL,
// and the page reads back the one it gave.
//
// happy-dom's Audio assigns `this.src`, through the (patched) setter, which
// a browser's does not; the window gets an Audio that sets the attribute
// directly, as the browser's does, before the patches run.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { patchAudioConstructor, patchUrlAttributes } from "../../src/patches/url-attributes";
import { initOriginals, originalAttr } from "../../src/native/originals";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";
const untag = (url: string): string => url.replace(/[?&]proxified=1/, "");

// Everything the two patches redefine, put back after the file.
const saved: Array<[object, PropertyKey, PropertyDescriptor]> = [];
function snapshot(owner: object, key: PropertyKey): void {
    for (let o: object | null = owner; o; o = Object.getPrototypeOf(o) as object | null) {
        const d = Object.getOwnPropertyDescriptor(o, key);
        if (d) { saved.push([o, key, d]); return; }
    }
}

const nativeGetAttribute = Element.prototype.getAttribute;
const nativeSetAttribute = Element.prototype.setAttribute;

// The browser's Audio: an <audio preload=auto>, src set past the setter.
function BrowserAudio(this: unknown, src?: string): HTMLAudioElement {
    const el = document.createElement("audio");
    nativeSetAttribute.call(el, "preload", "auto");
    if (src !== undefined) nativeSetAttribute.call(el, "src", String(src));
    return el;
}
BrowserAudio.prototype = HTMLAudioElement.prototype;
Object.defineProperty(BrowserAudio, "name", { value: "Audio" });

beforeAll(() => {
    snapshot(window, "Audio");
    snapshot(HTMLAudioElement.prototype, "constructor");
    for (const ctor of ["HTMLImageElement", "HTMLScriptElement", "HTMLIFrameElement", "HTMLSourceElement", "HTMLEmbedElement",
        "HTMLAudioElement", "HTMLVideoElement", "HTMLTrackElement", "HTMLBaseElement", "HTMLLinkElement", "HTMLAnchorElement",
        "HTMLAreaElement", "HTMLFormElement", "HTMLInputElement", "HTMLButtonElement", "HTMLObjectElement"]) {
        const proto = (window as unknown as Record<string, { prototype: object } | undefined>)[ctor]?.prototype;
        if (!proto) continue;
        for (const k of ["src", "srcset", "poster", "href", "imageSrcset", "action", "formAction", "data"]) snapshot(proto, k);
    }
    Object.defineProperty(window, "Audio", { value: BrowserAudio, writable: true, configurable: true });
    initOriginals(window);
    patchUrlAttributes(window, tag, untag);
    patchAudioConstructor(window, tag);
});

afterAll(() => {
    while (saved.length) {
        const [o, k, d] = saved.pop()!;
        Object.defineProperty(o, k, d);
    }
});

describe("new Audio(url)", () => {
    it("the element loads the proxified URL", () => {
        const a = new Audio("https://media.example/clip.mp3");
        expect(nativeGetAttribute.call(a, "src")).toBe("https://media.example/clip.mp3?proxified=1");
    });

    it("reading .src back gives the original URL", () => {
        const a = new Audio("https://media.example/clip.mp3");
        expect(a.src).toBe("https://media.example/clip.mp3");
    });

    it("the attribute's original is recorded (read-back of getAttribute)", () => {
        const a = new Audio("https://media.example/clip.mp3");
        expect(originalAttr(a, "src")).toEqual({ value: "https://media.example/clip.mp3" });
    });

    it("is still an HTMLAudioElement, and new Audio() sets no src", () => {
        const a = new Audio("https://media.example/clip.mp3");
        expect(a).toBeInstanceOf(HTMLAudioElement);
        const empty = new Audio();
        expect(nativeGetAttribute.call(empty, "src")).toBeNull();
        expect(originalAttr(empty, "src")).toBeUndefined();
    });

    it("a relative URL is handed to the rewriter as written", () => {
        const a = new Audio("sounds/ding.mp3");
        expect(nativeGetAttribute.call(a, "src")).toBe("sounds/ding.mp3?proxified=1");
        expect(originalAttr(a, "src")).toEqual({ value: "sounds/ding.mp3" });
    });
});
