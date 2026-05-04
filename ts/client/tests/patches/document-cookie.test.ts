// @vitest-environment node
//
// document.cookie getter/setter patch — in-memory store wiring.
//
// The new implementation replaces native document.cookie with direct reads
// and writes to the module-level in-memory store. Path filtering is done by
// the store; the patch just wires up the accessor.

import { describe, expect, it, beforeEach } from "vitest";
import { patchDocumentCookie } from "../../src/patches/document-cookie";
import { setCookie, getCookiesForPath, clearStore } from "../../src/cookies/in-memory-store";

function makeFakeWindow(): Window {
    const doc = {} as Document;
    Object.defineProperty(doc, "cookie", {
        get: () => "",
        set: (_v: string) => { /* native — will be replaced by patch */ },
        configurable: true,
        enumerable: true,
    });
    return { document: doc } as unknown as Window;
}

beforeEach(() => {
    clearStore();
});

describe("patchDocumentCookie — getter", () => {
    it("returns cookies matching the current pathname", () => {
        setCookie("admin_tok=abc; Path=/admin");
        setCookie("root_tok=xyz; Path=/");
        const win = makeFakeWindow();
        patchDocumentCookie(win, () => "/admin/page");
        // Both root and /admin cookies should be visible
        const result = win.document.cookie;
        expect(result).toContain("admin_tok=abc");
        expect(result).toContain("root_tok=xyz");
    });

    it("hides cookies whose path does not match", () => {
        setCookie("admin_tok=abc; Path=/admin");
        const win = makeFakeWindow();
        patchDocumentCookie(win, () => "/public");
        expect(win.document.cookie).toBe("");
    });

    it("resolves pathname at read time, not patch time", () => {
        setCookie("a=1; Path=/first");
        setCookie("b=2; Path=/second");
        let pathname = "/first";
        const win = makeFakeWindow();
        patchDocumentCookie(win, () => pathname);

        expect(win.document.cookie).toBe("a=1");

        pathname = "/second";
        expect(win.document.cookie).toBe("b=2");
    });

    it("returns empty string when store is empty", () => {
        const win = makeFakeWindow();
        patchDocumentCookie(win, () => "/");
        expect(win.document.cookie).toBe("");
    });
});

describe("patchDocumentCookie — setter", () => {
    it("writes a cookie into the in-memory store", () => {
        const win = makeFakeWindow();
        patchDocumentCookie(win, () => "/");
        win.document.cookie = "tok=secret; Path=/";
        expect(getCookiesForPath("/")).toBe("tok=secret");
    });

    it("setter deletion removes the cookie from the store", () => {
        setCookie("tok=old; Path=/");
        const win = makeFakeWindow();
        patchDocumentCookie(win, () => "/");
        win.document.cookie = "tok=; Max-Age=0; Path=/";
        expect(getCookiesForPath("/")).toBe("");
    });

    it("getter reflects setter writes immediately", () => {
        const win = makeFakeWindow();
        patchDocumentCookie(win, () => "/");
        win.document.cookie = "x=1; Path=/";
        win.document.cookie = "y=2; Path=/";
        const result = win.document.cookie;
        expect(result).toContain("x=1");
        expect(result).toContain("y=2");
    });
});
