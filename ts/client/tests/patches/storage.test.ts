// Storage is per original origin: a page sees only its own keys.

import { describe, expect, it } from "vitest";
import { patchWebStorage } from "../../src/patches/storage";

describe("localStorage per original origin", () => {
    let origin = "https://a.example";
    const prefix = (): string => "crn\u001f" + origin + "\u001f";
    // What other sites left on the proxy's origin before.
    const real = window.localStorage;
    real.setItem("foreign", "x");
    real.setItem("crn\u001fhttps://b.example\u001ftheirs", "b");
    patchWebStorage(window, prefix, (u) => u);
    const ls = window.localStorage;

    it("starts empty and keeps what the page writes", () => {
        expect(ls.length).toBe(0);
        expect(ls.getItem("foreign")).toBeNull();
        ls.setItem("k", "1");
        (ls as unknown as Record<string, string>)["named"] = "2";
        expect([ls.length, ls.getItem("k"), ls.getItem("named"), (ls as unknown as Record<string, string>)["k"]]).toEqual([2, "1", "2", "1"]);
        expect(Object.keys(ls).sort()).toEqual(["k", "named"]);
        expect([ls.key(0), ls.key(1), ls.key(2)].sort()).toEqual(["k", "named", null].sort());
        expect("k" in ls).toBe(true);
        expect("foreign" in ls).toBe(false);
        expect(JSON.stringify(ls)).toBe(JSON.stringify({ k: "1", named: "2" }));
    });

    it("is the same object each time, and a Storage", () => {
        expect(window.localStorage).toBe(ls);
        expect(ls instanceof Storage).toBe(true);
        expect(typeof ls.getItem).toBe("function");
    });

    it("removeItem, delete and clear touch only this origin's keys", () => {
        ls.removeItem("k");
        delete (ls as unknown as Record<string, string>)["named"];
        expect(ls.length).toBe(0);
        ls.setItem("again", "3");
        ls.clear();
        expect(ls.length).toBe(0);
        // Another origin's page, on the same real storage:
        origin = "https://b.example";
        expect([ls.length, ls.getItem("theirs")]).toEqual([1, "b"]);
        origin = "https://a.example";
    });
});
