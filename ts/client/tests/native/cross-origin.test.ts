// @vitest-environment node

// crossOriginView: the object page code of one window gets for another.
// A browser has one WindowProxy for a frame through all its navigations, so
// a frame page code already holds as itself stays itself once it becomes
// cross-origin (PayPal keys callbacks by it and looks them up by a
// message's source).

import { describe, expect, it } from "vitest";
import { crossOriginView, initCrossOrigin, isView, realWindow } from "../../src/native/cross-origin";

// A window as the runtime recognises one under Node (native/brand.ts
// emulation: its own `window` is itself), with a runtime whose original
// origin the test sets.
function fakeWindow(origin: string): { win: Window; navigate: (to: string) => void } {
    let current = origin;
    const w: Record<string, unknown> = {};
    w["window"] = w;
    w["DOMException"] = DOMException;
    w["$rewriter"] = { _: { api: { get_base_url: () => new URL(current + "/") } } };
    return { win: w as unknown as Window, navigate: (to) => { current = to; } };
}

function viewer(origin: string): Window {
    const { win } = fakeWindow(origin);
    initCrossOrigin(win, () => origin, (u) => u);
    return win;
}

describe("crossOriginView", () => {
    it("a same-origin frame is itself; a cross-origin one is a view", () => {
        const page = viewer("https://page.example");
        const same = fakeWindow("https://page.example").win;
        const other = fakeWindow("https://other.example").win;
        expect(crossOriginView(same, null, page)).toBe(same);
        const view = crossOriginView(other, null, page);
        // (Compared by identity: a view throws SecurityError at the
        // matcher's own introspection, as a cross-origin window does.)
        expect(view === other).toBe(false);
        expect(isView(view)).toBe(true);
        expect(realWindow(view)).toBe(other);
        // One view per window: identity holds.
        expect(crossOriginView(other, null, page) === view).toBe(true);
    });

    it("a frame handed out as itself stays itself after it becomes cross-origin", () => {
        const page = viewer("https://page.example");
        const frame = fakeWindow("https://page.example");
        // A blank frame the page writes into: same-origin, handed out as itself.
        expect(crossOriginView(frame.win, null, page)).toBe(frame.win);
        // Then it navigates to another origin.
        frame.navigate("https://checkout.other.example");
        expect(crossOriginView(frame.win, null, page)).toBe(frame.win);
        expect(crossOriginView(frame.win, "https://checkout.other.example", page)).toBe(frame.win);
    });

    it("handed out is per viewing window", () => {
        const pageA = viewer("https://page.example");
        const pageB = viewer("https://other-page.example");
        const frame = fakeWindow("https://page.example");
        expect(crossOriginView(frame.win, null, pageA)).toBe(frame.win);
        // pageB never held it as itself: it gets a view.
        expect(isView(crossOriginView(frame.win, null, pageB))).toBe(true);
    });

    it("a frame first seen cross-origin is a view, even after it becomes same-origin and back", () => {
        const page = viewer("https://page.example");
        const frame = fakeWindow("https://other.example");
        const view = crossOriginView(frame.win, null, page);
        expect(isView(view)).toBe(true);
        frame.navigate("https://other2.example");
        expect(crossOriginView(frame.win, null, page) === view).toBe(true);
    });

    it("a pending navigation to another origin gives a view up front", () => {
        const page = viewer("https://page.example");
        const frame = fakeWindow("https://page.example");
        expect(isView(crossOriginView(frame.win, "https://other.example", page))).toBe(true);
    });
});
