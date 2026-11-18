// document.cookie over the browser's own jar (src/patches/document-cookie.ts).
// The rules themselves are checked against the spec and against Chromium
// (tests/spec/cookies-*.test.ts); here: the accessor wiring.

import { describe, expect, it } from "vitest";
import { isPublicSuffix, nativeCookieWrite, patchDocumentCookie } from "../../src/patches/document-cookie";

const page = new URL("https://www.a.example/app/page");

describe("nativeCookieWrite", () => {
    it("writes the wire form with Path=/ and the expiry as written", () => {
        expect(nativeCookieWrite("sid=abc; Path=/app; Max-Age=60; Expires=Wed, 21 Oct 2037 07:28:00 GMT", page))
            .toBe("__crn!h!www.a.example!%2Fapp!sid=iu:abc; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=60");
    });
    it("a deletion deletes the same jar entry", () => {
        expect(nativeCookieWrite("sid=; Path=/app; Max-Age=0", page)).toBe("__crn!h!www.a.example!%2Fapp!sid=iu:; Path=/; Max-Age=0");
    });
    it("stores nothing for what the browser would ignore", () => {
        expect(nativeCookieWrite("a=1; HttpOnly", page)).toBeNull();
        expect(nativeCookieWrite("a=1; Domain=b.example", page)).toBeNull();
        expect(nativeCookieWrite("a=1; Domain=example", page)).toBeNull(); // a public suffix
        expect(nativeCookieWrite("a=1; Secure", new URL("http://www.a.example/"))).toBeNull();
    });
    it("knows public suffixes, private registries included", () => {
        expect([isPublicSuffix("com"), isPublicSuffix("co.uk"), isPublicSuffix("github.io"), isPublicSuffix("a.example"), isPublicSuffix("")])
            .toEqual([true, true, true, false, false]);
    });
});

describe("patchDocumentCookie", () => {
    it("reads the page's cookies from the jar and writes the wire form", () => {
        let jar = "__crn!h!www.a.example!%2F!x=iu:1; __crn!h!b.example!%2F!y=iu:2; other=3";
        const proto = { get cookie(): string { return jar; }, set cookie(v: string) { jar = `${jar}; ${v.split(";")[0]}`; } };
        const doc = Object.create(proto) as Document;
        patchDocumentCookie({ document: doc } as unknown as Window, () => page);
        expect(doc.cookie).toBe("x=1");
        doc.cookie = "z=9";
        expect(doc.cookie).toBe("z=9; x=1"); // /app (default path) is longer than /
        doc.cookie = "bad=1; HttpOnly";
        expect(doc.cookie).toBe("z=9; x=1");
    });
});
