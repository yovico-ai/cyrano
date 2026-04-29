import { describe, expect, it } from "vitest";
import { readCookieValue } from "../../src/cookies/document-cookie";

function fakeDoc(cookieHeader: string): Document {
    return { cookie: cookieHeader } as Document;
}

describe("readCookieValue", () => {
    it("returns the value for a present cookie", () => {
        const doc = fakeDoc("a=1; b=2; c=3");
        expect(readCookieValue("b", doc)).toBe("2");
    });

    it("URL-decodes the value", () => {
        const doc = fakeDoc("session=hello%20world%21");
        expect(readCookieValue("session", doc)).toBe("hello world!");
    });

    it("returns undefined when the cookie is absent", () => {
        const doc = fakeDoc("a=1; b=2");
        expect(readCookieValue("c", doc)).toBeUndefined();
    });

    it("returns undefined when document.cookie is empty", () => {
        expect(readCookieValue("anything", fakeDoc(""))).toBeUndefined();
    });

    it("does not match a cookie name as a prefix of another", () => {
        const doc = fakeDoc("session_alt=wrong; session=right");
        expect(readCookieValue("session", doc)).toBe("right");
    });

    it("trims leading whitespace before matching", () => {
        const doc = fakeDoc("a=1;   b=2;c=3");
        expect(readCookieValue("b", doc)).toBe("2");
        expect(readCookieValue("c", doc)).toBe("3");
    });
});
