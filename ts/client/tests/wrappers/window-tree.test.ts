// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
    getTopLevelWindow,
    wrapGetTopWindow,
    wrapParentWindow,
    wrapTopWindow,
} from "../../src/wrappers/window-tree";

describe("wrapGetTopWindow", () => {
    it("returns the input window untouched (identity for now)", () => {
        const fakeTop = { name: "top" } as unknown as Window;
        expect(wrapGetTopWindow(fakeTop)).toBe(fakeTop);
    });
});

describe("wrapTopWindow", () => {
    it("returns non-Window objects unchanged so .top resolves normally", () => {
        const top = {};
        const obj = { top };
        // obj is returned as-is; .top is the original property
        expect(wrapTopWindow({ obj }).top).toBe(top);
    });

    it("returns non-Window object unchanged even when .top is absent", () => {
        const obj = {};
        expect(wrapTopWindow({ obj: obj as { top: unknown } }).top).toBeUndefined();
    });

    it("returns undefined for null", () => {
        expect(wrapTopWindow({ obj: null }).top).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
        expect(wrapTopWindow({ obj: undefined }).top).toBeUndefined();
    });

    it("preserves method call this-binding on non-Window objects", () => {
        // Simulate a library object with a .top() method (e.g. scroll-to-top).
        // wrapTopWindow must return the object itself so .top() can be called
        // with the correct `this` context.
        const lib = {
            top() {
                return this;
            },
        };
        const result = wrapTopWindow({ obj: lib });
        // Calling .top() should return `lib`, not some wrapper object.
        expect((result as typeof lib).top()).toBe(lib);
    });

    it("intercepts .top on a fake Window (window.window === itself)", () => {
        // Simulate a Window-like object using the duck-type invariant.
        const fakeTop = { name: "fakeTop" };
        const fakeWindow = { window: {} as unknown, top: fakeTop };
        fakeWindow.window = fakeWindow; // window.window === window
        const result = wrapTopWindow({ obj: fakeWindow });
        expect(result.top).toBe(fakeTop);
    });
});

describe("wrapParentWindow", () => {
    it("returns non-Window objects unchanged so .parent resolves normally", () => {
        const parent = {};
        const obj = { parent };
        expect(wrapParentWindow({ obj }).parent).toBe(parent);
    });

    it("returns non-Window object unchanged even when .parent is absent", () => {
        const obj = {};
        expect(wrapParentWindow({ obj: obj as { parent: unknown } }).parent).toBeUndefined();
    });

    it("returns undefined for null", () => {
        expect(wrapParentWindow({ obj: null }).parent).toBeUndefined();
    });

    it("preserves method call this-binding on non-Window objects (jQuery .parent())", () => {
        // The core regression: jQuery's .parent() traversal method was being
        // wrapped into {parent: fn}.parent() with a broken `this`. Verify that
        // a non-Window object with a .parent() method gets its call routed correctly.
        const jqueryLike = {
            pushStack(items: unknown[]) {
                return { items, _isJQuery: true };
            },
            parent() {
                return this.pushStack([]);
            },
        };
        const result = wrapParentWindow({ obj: jqueryLike });
        // Calling .parent() on the returned value must produce the same result
        // as calling it on jqueryLike directly — i.e. `this` is intact.
        const direct = jqueryLike.parent();
        const viawrap = (result as typeof jqueryLike).parent();
        expect(viawrap._isJQuery).toBe(true);
        expect(viawrap._isJQuery).toBe(direct._isJQuery);
    });

    it("intercepts .parent on a fake Window (window.window === itself)", () => {
        const fakeParent = { name: "fakeParent" };
        const fakeWindow = { window: {} as unknown, parent: fakeParent };
        fakeWindow.window = fakeWindow;
        const result = wrapParentWindow({ obj: fakeWindow });
        expect(result.parent).toBe(fakeParent);
    });
});

describe("getTopLevelWindow", () => {
    it("walks up to the topmost frame", () => {
        // Build a 3-level nested chain. Each frame's .parent points up; the
        // top frame's .parent is itself (browsers' convention).
        type FrameNode = { parent: FrameNode };
        const top: FrameNode = { parent: null as unknown as FrameNode };
        top.parent = top;
        const middle: FrameNode = { parent: top };
        const bottom: FrameNode = { parent: middle };

        expect(getTopLevelWindow(bottom as unknown as Window)).toBe(top);
        expect(getTopLevelWindow(middle as unknown as Window)).toBe(top);
        expect(getTopLevelWindow(top as unknown as Window)).toBe(top);
    });
});
