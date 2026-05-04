// @vitest-environment node
//
// document.cookie getter/setter patch.
//
// Getter: page JS sees only cookies for the current site, prefix stripped.
// Setter: page JS writes are namespaced with the site prefix before storage.

import { describe, expect, it } from "vitest";
import { patchDocumentCookie, prefixCookieName } from "../../src/patches/document-cookie";

// ── prefixCookieName (pure) ───────────────────────────────────────────────────

describe("prefixCookieName", () => {
    it("prepends prefix to the cookie name", () => {
        expect(prefixCookieName("ak_bmsc=abc123", "__crn__casio_com__"))
            .toBe("__crn__casio_com__ak_bmsc=abc123");
    });

    it("preserves attributes after the semicolon", () => {
        expect(prefixCookieName("bm_sv=xyz; Path=/; SameSite=None", "__crn__casio_com__"))
            .toBe("__crn__casio_com__bm_sv=xyz; Path=/; SameSite=None");
    });

    it("handles deletion string (Max-Age=0)", () => {
        expect(prefixCookieName("session=; Max-Age=0; Path=/", "__crn__so__"))
            .toBe("__crn__so__session=; Max-Age=0; Path=/");
    });

    it("trims leading whitespace from name=value", () => {
        expect(prefixCookieName("  name=val", "__p__"))
            .toBe("__p__name=val");
    });
});

// ── patchDocumentCookie (DOM) ─────────────────────────────────────────────────

// Build a fake window whose document.cookie we can control and inspect.
function makeFakeWindow(initial = ""): {
    win: Window;
    getWritten: () => string[];
} {
    let stored = initial;
    const written: string[] = [];

    const doc = {} as Document;
    Object.defineProperty(doc, "cookie", {
        get: () => stored,
        set: (v: string) => {
            written.push(v as string);
            // Simulate simple store: keep first name=value token only.
            const kv = (v as string).split(";")[0]!.trim();
            stored = stored ? `${stored}; ${kv}` : kv;
        },
        configurable: true,
        enumerable: true,
    });

    const win = { document: doc } as unknown as Window;
    return { win, getWritten: () => written };
}

describe("patchDocumentCookie — getter", () => {
    it("returns only cookies for the current site, prefix stripped", () => {
        const { win } = makeFakeWindow(
            "__crn__casio_com__ak_bmsc=abc; __crn__stackoverflow_com__prov=xyz; crnsct=proxy"
        );
        patchDocumentCookie(win, () => "www.casio.com");
        expect(win.document.cookie).toBe("ak_bmsc=abc");
    });

    it("returns empty string when no cookies match the current site", () => {
        const { win } = makeFakeWindow("__crn__stackoverflow_com__prov=xyz; crnsct=proxy");
        patchDocumentCookie(win, () => "www.casio.com");
        expect(win.document.cookie).toBe("");
    });

    it("strips prefix from multiple matching cookies", () => {
        const { win } = makeFakeWindow(
            "__crn__casio_com__ak_bmsc=abc; __crn__casio_com__bm_sv=def"
        );
        patchDocumentCookie(win, () => "casio.com");
        expect(win.document.cookie).toBe("ak_bmsc=abc; bm_sv=def");
    });

    it("resolves current host at read time (not at patch time)", () => {
        let currentHost = "casio.com";
        const { win } = makeFakeWindow(
            "__crn__casio_com__x=1; __crn__stackoverflow_com__y=2"
        );
        patchDocumentCookie(win, () => currentHost);

        expect(win.document.cookie).toBe("x=1");

        currentHost = "stackoverflow.com";
        expect(win.document.cookie).toBe("y=2");
    });
});

// Simulates Chrome's prototype chain: document instance → HTMLDocument.prototype
// → Document.prototype (where "cookie" lives), matching the real browser layout
// that caused the original "patch silently skipped" bug.
function makeFakeWindowChrome(initial = ""): {
    win: Window;
    getWritten: () => string[];
} {
    let stored = initial;
    const written: string[] = [];

    // Level 2: Document.prototype — this is where "cookie" lives in Chrome.
    const DocumentProto = Object.create(Object.prototype);
    Object.defineProperty(DocumentProto, "cookie", {
        get() { return stored; },
        set(v: string) {
            written.push(v as string);
            const kv = (v as string).split(";")[0]!.trim();
            stored = stored ? `${stored}; ${kv}` : kv;
        },
        configurable: true,
        enumerable: true,
    });

    // Level 1: HTMLDocument.prototype — no "cookie" own property (like Chrome).
    const HTMLDocumentProto = Object.create(DocumentProto);

    // Level 0: document instance — no "cookie" own property (like Chrome).
    const doc = Object.create(HTMLDocumentProto) as Document;

    const win = { document: doc } as unknown as Window;
    return { win, getWritten: () => written };
}

describe("patchDocumentCookie — Chrome prototype chain", () => {
    it("finds cookie descriptor two levels up and patches the instance", () => {
        const { win, getWritten } = makeFakeWindowChrome(
            "__crn__casio_com__ak_bmsc=abc; __crn__stackoverflow_com__prov=xyz"
        );
        patchDocumentCookie(win, () => "www.casio.com");
        // Getter must filter and strip prefix.
        expect(win.document.cookie).toBe("ak_bmsc=abc");
        // Setter must add prefix.
        win.document.cookie = "bm_sv=newval; Path=/";
        expect(getWritten()[0]).toBe("__crn__casio_com__bm_sv=newval; Path=/");
    });

    it("does not leave the patch unapplied when cookie is on a distant prototype", () => {
        const { win } = makeFakeWindowChrome(
            "__crn__iaac_space__preferred_language=en; other=x"
        );
        patchDocumentCookie(win, () => "iaac.space");
        // If the patch were skipped (old bug), this would return the raw string.
        expect(win.document.cookie).toBe("preferred_language=en");
    });
});

describe("patchDocumentCookie — setter", () => {
    it("prefixes the cookie name on write", () => {
        const { win, getWritten } = makeFakeWindow();
        patchDocumentCookie(win, () => "www.casio.com");
        win.document.cookie = "bm_sv=newval; Path=/";
        expect(getWritten()[0]).toBe("__crn__casio_com__bm_sv=newval; Path=/");
    });

    it("prefixes a deletion write (Max-Age=0)", () => {
        const { win, getWritten } = makeFakeWindow();
        patchDocumentCookie(win, () => "casio.com");
        win.document.cookie = "ak_bmsc=; Max-Age=0; Path=/";
        expect(getWritten()[0]).toBe("__crn__casio_com__ak_bmsc=; Max-Age=0; Path=/");
    });

    it("uses the current host at write time, not at patch time", () => {
        let currentHost = "first.com";
        const { win, getWritten } = makeFakeWindow();
        patchDocumentCookie(win, () => currentHost);

        win.document.cookie = "x=1";
        currentHost = "second.com";
        win.document.cookie = "y=2";

        expect(getWritten()[0]).toBe("__crn__first_com__x=1");
        expect(getWritten()[1]).toBe("__crn__second_com__y=2");
    });
});
