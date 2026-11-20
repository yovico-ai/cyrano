// The script URLs the runtime reads off a V8 stack (spec/Stack.agda).
// The regex it used missed a URL holding "(" and cut one whose query
// holds ":1:2"; an eval frame names the script it ran in.

import { describe, expect, it } from "vitest";
import { stackUrls } from "../../src/native/error-stack";

describe("stackUrls", () => {
    it("reads URLs with parentheses and colons whole", () => {
        const st = ["Error", "    at f (https://h.example/a(b).js:1:2)", "    at https://h.example/q.js?x=1:2:3:4:5", "    at async https://h.example/m.js:6:7"].join("\n");
        expect(stackUrls(st)).toEqual(["https://h.example/a(b).js", "https://h.example/q.js?x=1:2:3", "https://h.example/m.js"]);
    });

    it("an eval frame, nested or not, is its script's", () => {
        const st = ["Error", "    at eval (eval at <anonymous> (eval at g (https://h.example/e.js:1:2)), <anonymous>:1:1)", "    at Object.a(b (https://h.example/o.js:3:4)", "    at Array.map (<anonymous>)"].join("\n");
        expect(stackUrls(st)).toEqual(["https://h.example/e.js", "https://h.example/o.js"]);
    });
});
