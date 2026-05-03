// @vitest-environment node
//
// Unit tests for cookieSiteKey / cookiePrefixFor.
// Expected outputs must match Go's cookieSiteKey() in
// internal/proxy/handler.go — any divergence breaks cookie isolation.

import { describe, expect, it } from "vitest";
import { cookieSiteKey, cookiePrefixFor } from "../../src/cookies/site-key";

describe("cookieSiteKey", () => {
    it("strips www subdomain — matches casio.com key", () => {
        expect(cookieSiteKey("www.casio.com")).toBe("casio_com");
    });

    it("CDN subdomain maps to same key as main domain", () => {
        expect(cookieSiteKey("cdn.casio.com")).toBe("casio_com");
    });

    it("bare eTLD+1 is its own key", () => {
        expect(cookieSiteKey("casio.com")).toBe("casio_com");
    });

    it("two-part public suffix (co.uk)", () => {
        expect(cookieSiteKey("www.bbc.co.uk")).toBe("bbc_co_uk");
    });

    it("stackoverflow.com", () => {
        expect(cookieSiteKey("stackoverflow.com")).toBe("stackoverflow_com");
    });

    it("strips port before computing key", () => {
        expect(cookieSiteKey("localhost:9081")).toBe("localhost");
    });
});

describe("cookiePrefixFor", () => {
    it("wraps key in __crn__ sentinels", () => {
        expect(cookiePrefixFor("www.casio.com")).toBe("__crn__casio_com__");
    });

    it("two sites produce distinct prefixes", () => {
        const a = cookiePrefixFor("stackoverflow.com");
        const b = cookiePrefixFor("www.casio.com");
        expect(a).not.toBe(b);
    });
});
