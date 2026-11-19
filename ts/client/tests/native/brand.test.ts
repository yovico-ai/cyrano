// Runs under happy-dom. isWindowObject / isDocumentObject tell windows and
// documents apart without reading the object. The browser path (a native
// accessor's brand check, which fires no Proxy trap) is checked in Chromium
// (tests/native/hooked-builtins-vs-chromium.test.ts). Here: the emulation
// fallback — happy-dom defines `window` as a data property, so a window is
// an object whose own `window` data property is itself; a document is
// asked through Node.prototype's nodeType accessor.

import { describe, expect, it } from "vitest";
import { isDocumentObject, isWindowObject } from "../../src/native/brand";

describe("isWindowObject (emulation)", () => {
    it("true for the window", () => {
        expect(isWindowObject(window)).toBe(true);
        expect(isWindowObject(globalThis)).toBe(true);
    });

    it("true for a frame's window", () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        expect(isWindowObject(iframe.contentWindow)).toBe(true);
        iframe.remove();
    });

    it("false for primitives, plain objects, documents and functions", () => {
        for (const x of [null, undefined, 0, "window", true, {}, [], document, () => window, Object.create(null)]) {
            expect(isWindowObject(x), typeof x).toBe(false);
        }
    });

    it("false for an object whose `window` points elsewhere or is a getter (and the getter does not run)", () => {
        expect(isWindowObject({ window })).toBe(false);
        let runs = 0;
        const o = {};
        Object.defineProperty(o, "window", { get() { runs++; return o; } });
        expect(isWindowObject(o)).toBe(false);
        expect(runs).toBe(0);
    });

    it("false for a Proxy of the window, and no get trap fires", () => {
        const traps: string[] = [];
        const p = new Proxy(window, {
            get: (t, k) => { traps.push(`get ${String(k)}`); return Reflect.get(t, k); },
            has: (t, k) => { traps.push(`has ${String(k)}`); return Reflect.has(t, k); },
        });
        expect(isWindowObject(p)).toBe(false);
        expect(traps).toEqual([]);
    });

    it("a throwing Proxy is not a window, and does not throw", () => {
        const p = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
        expect(isWindowObject(p)).toBe(false);
    });
});

describe("isDocumentObject (emulation)", () => {
    it("true for the document and a new one", () => {
        expect(isDocumentObject(document)).toBe(true);
        expect(isDocumentObject(document.implementation.createHTMLDocument("x"))).toBe(true);
    });

    it("false for elements, the window, and plain objects that claim nodeType 9", () => {
        expect(isDocumentObject(document.body)).toBe(false);
        expect(isDocumentObject(window)).toBe(false);
        expect(isDocumentObject(null)).toBe(false);
        expect(isDocumentObject({})).toBe(false);
        let runs = 0;
        const fake = { get nodeType() { runs++; return 9; }, defaultView: window };
        expect(isDocumentObject(fake)).toBe(false);
        expect(runs).toBe(0);
    });

    it("a Proxy over a plain object is not a document, and does not throw", () => {
        const p = new Proxy({ nodeType: 9 }, { get: () => { throw new Error("trap"); } });
        expect(isDocumentObject(p)).toBe(false);
    });
});
