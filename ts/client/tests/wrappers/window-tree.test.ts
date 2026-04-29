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
    it("forwards .top from the wrapped object", () => {
        const top = {};
        const obj = { top };
        expect(wrapTopWindow({ obj }).top).toBe(top);
    });

    it("returns undefined when .top is absent", () => {
        expect(wrapTopWindow({ obj: {} }).top).toBeUndefined();
    });

    it("returns undefined for null/undefined", () => {
        expect(wrapTopWindow({ obj: null }).top).toBeUndefined();
        expect(wrapTopWindow({ obj: undefined }).top).toBeUndefined();
    });
});

describe("wrapParentWindow", () => {
    it("forwards .parent from the wrapped object", () => {
        const parent = {};
        const obj = { parent };
        expect(wrapParentWindow({ obj }).parent).toBe(parent);
    });

    it("returns undefined when .parent is absent", () => {
        expect(wrapParentWindow({ obj: {} }).parent).toBeUndefined();
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
