// @vitest-environment node
//
// A `new Function` body is tagged with its eval origin (native/error-stack.ts
// tagFunctionBody): the same body made at the same place must be the same
// source — V8's compilation cache serves it then, as natively — and the
// tag table must not grow per call. A tag per call made every source new
// and the table grow for the life of the page (qidian.com's bot check
// makes thousands of functions; under a debugger, where each stack is
// costly, its page took a minute).

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { patchErrorStacks, tagFunctionBody } from "../../src/native/error-stack";

describe("tagFunctionBody", () => {
    // This test file's own realm (a worker of its own); the runtime's frames
    // are the module's.
    const realm = globalThis as unknown as Window;
    // (vitest's source-map formatter would count as the page's own.)
    delete (Error as { prepareStackTrace?: unknown }).prepareStackTrace;
    const runtime = fileURLToPath(new URL("../../src/native/error-stack.ts", import.meta.url));
    patchErrorStacks(realm, runtime, (u) => u);

    it("gives the same source for the same body made at the same place", () => {
        const made: string[] = [];
        for (let i = 0; i < 50; i++) made.push(tagFunctionBody(realm, "return 1"));
        expect(new Set(made).size).toBe(1);
        expect(made[0]).toMatch(/\/\/# sourceURL=/);
    });

    it("and another tag for another place", () => {
        const a = tagFunctionBody(realm, "return 2");
        const b = tagFunctionBody(realm, "return 2");
        expect(a).not.toBe(b);
    });
});
