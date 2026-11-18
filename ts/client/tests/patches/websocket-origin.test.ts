import { describe, expect, it } from "vitest";
import { withPageOrigin, withoutPageOrigin, WS_ORIGIN_PARAM } from "../../src/patches/websocket";

describe("WebSocket origin marker", () => {
    const o = "https://page.example";
    it("is appended last and removed exactly", () => {
        for (const u of [
            "http://p/cyrano/wss/h/s", "http://p/cyrano/wss/h/s?", "http://p/cyrano/wss/h/s?a=1&b=%7e",
            `http://p/cyrano/wss/h/s?${WS_ORIGIN_PARAM}=page's-own&z=1`,
        ]) {
            const marked = withPageOrigin(u, o);
            expect(marked).not.toBe(u);
            expect(marked.endsWith(`${WS_ORIGIN_PARAM}=${encodeURIComponent(o)}`)).toBe(true);
            expect(withoutPageOrigin(marked)).toBe(u);
        }
    });
    it("leaves a URL with a fragment for the native to reject", () => {
        expect(withPageOrigin("http://p/cyrano/wss/h/s#f", o)).toBe("http://p/cyrano/wss/h/s#f");
    });
    it("leaves an unmarked URL alone", () => {
        expect(withoutPageOrigin("http://p/cyrano/wss/h/s?a=1")).toBe("http://p/cyrano/wss/h/s?a=1");
    });
});
