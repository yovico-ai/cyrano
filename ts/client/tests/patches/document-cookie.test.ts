// document.cookie over the page tree's memory and the channel through the
// browser's own jar (src/patches/document-cookie.ts, src/cookies/memory.ts).
// The rules themselves are checked against the spec and against Chromium
// (tests/spec/cookie*.test.ts); here: the wiring.

import { describe, expect, it } from "vitest";
import { cookieWrite, isPublicSuffix, patchDocumentCookie } from "../../src/patches/document-cookie";
import { chanName, chanValue, unchan, unpackSlot } from "../../src/cookies/jar";
import { givenSnapshot, takeSnapshot } from "../../src/cookies/memory";

const page = new URL("https://www.a.example/app/page");

describe("cookieWrite", () => {
    it("is the cookie the write makes, with its expiry", () => {
        const ch = cookieWrite("sid=abc; Path=/app; Max-Age=60", page)!;
        expect(ch.gone).toBe(false);
        expect([ch.cookie.name, ch.cookie.value, ch.cookie.path, ch.cookie.domain, ch.cookie.hostOnly]).toEqual(["sid", "abc", "/app", "www.a.example", true]);
        expect(ch.expiry.session).toBe(false);
    });
    it("a deletion is gone", () => {
        expect(cookieWrite("sid=; Path=/app; Max-Age=0", page)!.gone).toBe(true);
    });
    it("stores nothing for what the browser would ignore", () => {
        expect(cookieWrite("a=1; HttpOnly", page)).toBeNull();
        expect(cookieWrite("a=1; Domain=b.example", page)).toBeNull();
        expect(cookieWrite("a=1; Domain=example", page)).toBeNull(); // a public suffix
        expect(cookieWrite("a=1; Secure", new URL("http://www.a.example/"))).toBeNull();
    });
    it("knows public suffixes, private registries included", () => {
        expect([isPublicSuffix("com"), isPublicSuffix("co.uk"), isPublicSuffix("github.io"), isPublicSuffix("a.example"), isPublicSuffix("")])
            .toEqual([true, true, true, false, false]);
    });
});

describe("patchDocumentCookie", () => {
    // A browser jar on the proxy origin: name → value, Max-Age=0 deletes.
    function fakeWindow(initial: Record<string, string>): { win: Window; jar: Map<string, string> } {
        const jar = new Map(Object.entries(initial));
        class Doc {
            get cookie(): string { return [...jar].map(([n, v]) => `${n}=${v}`).join("; "); }
            set cookie(s: string) {
                const [nv, ...attrs] = s.split(";");
                const i = nv!.indexOf("=");
                const n = nv!.slice(0, i), v = nv!.slice(i + 1);
                if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(n); else jar.set(n, v);
            }
        }
        const doc = new Doc();
        return { win: { Document: Doc, document: doc } as unknown as Window, jar };
    }

    it("reads memory and the old wire form; a write goes to memory and the outbox", () => {
        const { win, jar } = fakeWindow({ "__crn!h!www.a.example!%2F!x": "iu:1", "__crn!h!b.example!%2F!y": "iu:2", other: "3" });
        givenSnapshot(win, undefined);
        patchDocumentCookie(win, () => page);
        const doc = win.document;
        expect(doc.cookie).toBe("x=1");
        doc.cookie = "z=9";
        expect(doc.cookie).toBe("z=9; x=1"); // /app (default path) is longer than /
        const slot = [...jar].find(([n]) => n.startsWith("__crn~o!"));
        expect(slot?.[0]).toMatch(/^__crn~o![0-9a-z]+!0$/);
        const tab = slot![0].slice("__crn~o!".length, -"!0".length);
        const [rec] = unpackSlot(slot![1]);
        const o = unchan(false, rec![0], rec![1])!;
        expect([o.change.cookie.name, o.change.cookie.value, o.change.gone]).toEqual(["z", "9", false]);
        doc.cookie = "bad=1; HttpOnly";
        expect(doc.cookie).toBe("z=9; x=1");

        // A burst of writes is one slot or a few, never a cookie each.
        for (let i = 0; i < 150; i++) doc.cookie = `c${i}=${i}`;
        const slots = [...jar.keys()].filter((n) => n.startsWith("__crn~o!"));
        expect(slots.length).toBeLessThan(5);
        expect(unpackSlot(slots.map((n) => jar.get(n)!).join("~")).length).toBe(151);

        // The server's ack (it read them all): the slots are cleared.
        jar.set("__crn~a!" + tab, String(Date.now() * 1000 + 999) + "!151");
        expect(doc.cookie.split("; ").length).toBe(152);
        expect([...jar.keys()].some((n) => n.startsWith("__crn~o!"))).toBe(false);

        // A change another response made: shown at once.
        const w = cookieWrite("w=5", page)!;
        jar.set(chanName(true, w), chanValue(w, 3, 0));
        expect(doc.cookie).toContain("w=5");
    });

    // nfl.com: a frame's snapshot made before the server had the page's
    // writes, given later, took them for gone — the ack's generation stands.
    it("an acknowledged write outlives an older snapshot", () => {
        const { win, jar } = fakeWindow({});
        givenSnapshot(win, undefined);
        patchDocumentCookie(win, () => page);
        const doc = win.document;
        doc.cookie = "consent=yes; Path=/";
        const tab = [...jar.keys()].find((n) => n.startsWith("__crn~o!"))!.slice("__crn~o!".length).split("!")[0];
        jar.set("__crn~a!" + tab, String(Date.now() * 1000 + 999) + "!5");
        expect(doc.cookie).toContain("consent=yes");
        takeSnapshot(win, page, { g: 3, e: [] });
        expect(doc.cookie).toContain("consent=yes");
        takeSnapshot(win, page, { g: 6, e: [] }); // one made after: it is gone indeed
        expect(doc.cookie).not.toContain("consent=yes");
    });
});
