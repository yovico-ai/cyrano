// @vitest-environment node

import { describe, expect, it } from "vitest";
import { wrapMemberExpression } from "../../src/wrappers/member-expression";

describe("wrapMemberExpression (passthrough)", () => {
    it("returns the object unchanged regardless of the property key", () => {
        const obj = { location: 1 };
        expect(wrapMemberExpression(obj, "location")).toBe(obj);
        expect(wrapMemberExpression(obj, Symbol("x"))).toBe(obj);
        expect(wrapMemberExpression(obj, 42)).toBe(obj);
    });

    it("handles null/undefined without throwing", () => {
        expect(wrapMemberExpression(null, "x")).toBeNull();
        expect(wrapMemberExpression(undefined, "x")).toBeUndefined();
    });
});
