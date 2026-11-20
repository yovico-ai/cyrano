// Runs under happy-dom. The origin the runtime takes a frame to be from
// before its navigation commits (spec/Frames.agda frameOrigin).

import { describe, expect, it } from "vitest";
import { pendingOrigin } from "../../src/patches/cross-origin-windows";

describe("pendingOrigin", () => {
    it("an iframe's srcdoc makes it its creator's", () => {
        const f = document.createElement("iframe");
        f.src = "https://other.example/x";
        expect(pendingOrigin(f)).toBe("https://other.example");
        f.setAttribute("srcdoc", "<p>");
        expect(pendingOrigin(f)).toBeNull();
    });

    // An <object> has no srcdoc: the attribute made a cross-origin object
    // read as its creator's.
    it("an object's srcdoc attribute is nothing", () => {
        const o = document.createElement("object");
        o.data = "https://other.example/x";
        o.setAttribute("srcdoc", "<p>");
        expect(pendingOrigin(o)).toBe("https://other.example");
    });

    it("data:, javascript:, about:blank are left to the browser / the creator", () => {
        for (const u of ["data:text/html,x", "javascript:void 0", "about:blank"]) {
            const f = document.createElement("iframe");
            f.src = u;
            expect(pendingOrigin(f)).toBeNull();
        }
    });
});
