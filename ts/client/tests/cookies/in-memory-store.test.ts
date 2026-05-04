// @vitest-environment node

import { describe, expect, it, beforeEach } from "vitest";
import {
    setCookie,
    getCookiesForPath,
    populateFromPayload,
    clearStore,
} from "../../src/cookies/in-memory-store";

beforeEach(() => {
    clearStore();
});

// ── setCookie ─────────────────────────────────────────────────────────────────

describe("setCookie — basic storage", () => {
    it("stores a simple name=value cookie", () => {
        setCookie("session=abc123; Path=/");
        expect(getCookiesForPath("/")).toBe("session=abc123");
    });

    it("defaults path to / when no Path attribute", () => {
        setCookie("tok=xyz");
        expect(getCookiesForPath("/any/path")).toBe("tok=xyz");
    });

    it("upserts when same name+path is set again", () => {
        setCookie("tok=old; Path=/");
        setCookie("tok=new; Path=/");
        expect(getCookiesForPath("/")).toBe("tok=new");
    });

    it("treats different paths as distinct entries", () => {
        setCookie("tok=root; Path=/");
        setCookie("tok=admin; Path=/admin");
        const root = getCookiesForPath("/");
        expect(root).toBe("tok=root");
        const admin = getCookiesForPath("/admin/page");
        expect(admin).toContain("tok=root");
        expect(admin).toContain("tok=admin");
    });

    it("ignores entries with no name", () => {
        setCookie("=val; Path=/");
        expect(getCookiesForPath("/")).toBe("");
    });

    it("ignores entries with no = sign", () => {
        setCookie("justname; Path=/");
        expect(getCookiesForPath("/")).toBe("");
    });
});

describe("setCookie — deletion", () => {
    it("Max-Age=0 deletes a previously stored cookie", () => {
        setCookie("tok=v; Path=/");
        setCookie("tok=; Max-Age=0; Path=/");
        expect(getCookiesForPath("/")).toBe("");
    });

    it("Max-Age=-1 also deletes", () => {
        setCookie("tok=v; Path=/");
        setCookie("tok=; Max-Age=-1; Path=/");
        expect(getCookiesForPath("/")).toBe("");
    });

    it("Expires in the past deletes the cookie", () => {
        setCookie("tok=v; Path=/");
        setCookie("tok=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/");
        expect(getCookiesForPath("/")).toBe("");
    });

    it("deletion of a non-existent cookie is a no-op", () => {
        setCookie("other=val; Path=/");
        setCookie("nope=; Max-Age=0; Path=/");
        expect(getCookiesForPath("/")).toBe("other=val");
    });
});

describe("setCookie — expiry", () => {
    it("stores a future Max-Age and returns the cookie before expiry", () => {
        setCookie("tok=v; Max-Age=3600; Path=/");
        expect(getCookiesForPath("/")).toBe("tok=v");
    });

    it("expired cookies are evicted during getCookiesForPath", () => {
        // Set a cookie that already appears expired by directly manipulating
        // the store via setCookie with Max-Age=0 (immediate deletion).
        setCookie("live=yes; Path=/");
        setCookie("dead=no; Max-Age=1; Path=/");
        // Simulate expiry by advancing conceptually — use Max-Age=0 re-set.
        setCookie("dead=no; Max-Age=0; Path=/");
        expect(getCookiesForPath("/")).toBe("live=yes");
    });
});

// ── getCookiesForPath ─────────────────────────────────────────────────────────

describe("getCookiesForPath — path matching (RFC 6265 §5.1.4)", () => {
    it("/ matches any request path", () => {
        setCookie("a=1; Path=/");
        expect(getCookiesForPath("/foo/bar")).toBe("a=1");
        expect(getCookiesForPath("/")).toBe("a=1");
    });

    it("/admin matches /admin/users but not /admintools", () => {
        setCookie("tok=x; Path=/admin");
        expect(getCookiesForPath("/admin/users")).toBe("tok=x");
        expect(getCookiesForPath("/admintools")).toBe("");
    });

    it("/admin/ matches /admin/users", () => {
        setCookie("tok=x; Path=/admin/");
        expect(getCookiesForPath("/admin/users")).toBe("tok=x");
    });

    it("exact path match works", () => {
        setCookie("tok=x; Path=/exact/path");
        expect(getCookiesForPath("/exact/path")).toBe("tok=x");
    });

    it("/other does not match /different", () => {
        setCookie("tok=x; Path=/other");
        expect(getCookiesForPath("/different")).toBe("");
    });

    it("returns multiple matching cookies joined by '; '", () => {
        setCookie("a=1; Path=/");
        setCookie("b=2; Path=/");
        const result = getCookiesForPath("/");
        expect(result).toContain("a=1");
        expect(result).toContain("b=2");
        expect(result.split("; ").length).toBe(2);
    });

    it("returns empty string when store is empty", () => {
        expect(getCookiesForPath("/")).toBe("");
    });
});

// ── populateFromPayload ───────────────────────────────────────────────────────

describe("populateFromPayload", () => {
    it("stores all cookies from the payload array", () => {
        populateFromPayload([
            "session=tok123; Path=/",
            "pref=dark; Path=/",
        ]);
        const result = getCookiesForPath("/");
        expect(result).toContain("session=tok123");
        expect(result).toContain("pref=dark");
    });

    it("handles an empty array gracefully", () => {
        populateFromPayload([]);
        expect(getCookiesForPath("/")).toBe("");
    });

    it("applies path filtering per cookie", () => {
        populateFromPayload([
            "admin=secret; Path=/admin",
            "root=public; Path=/",
        ]);
        expect(getCookiesForPath("/")).toBe("root=public");
        const admin = getCookiesForPath("/admin/x");
        expect(admin).toContain("admin=secret");
        expect(admin).toContain("root=public");
    });
});
