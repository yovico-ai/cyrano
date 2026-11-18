// Every place JavaScript can hold an expression must be reached by the
// client's rewriter too (mirrors go/src/internal/jsrewrite/coverage_test.go):
// a `location` read the walk never visits reaches the page unrewritten.

import { describe, expect, it } from "vitest";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";

const cases: Array<[string, number]> = [
    [`var o = { m() { return location.href; } };`, 1],
    [`var o = { 123() { return location.href; } };`, 1],
    [`var o = { get g() { return location.href; }, set s(v) { x = location.href; } };`, 2],
    [`var o = { async m() { return location.href; }, *gen() { yield location.href; } };`, 2],
    [`var o = { [location.href]: 1, k2: () => location.href, [location.host]() { return location.port; } };`, 4],
    [`class C extends f(location.href) { m() { return location.href; } static s() { return location.href; } f = location.href; static { location.href; } #p() { return location.href; } [location.host]() {} get g() { return location.port; } }`, 8],
    [`var K = class { m() { return location.href; } };`, 1],
    [`(self.webpackChunk = self.webpackChunk || []).push([[1], { 5(e, t, o) { globalThis.x = globalThis.location.pathname; } }]);`, 1],
    [`var {a = location.href, [location.host]: b = location.port} = o; var [c = location.href, [d = location.host]] = arr;`, 5],
    [`function d(p = location.href, {q = location.host}, ...[r = location.port]) {} var e = (p = location.href) => p; var g = function (p = location.host) {};`, 5],
    [`try { x } catch ({ m = location.href }) { location.host }`, 2],
    [`do { location.href } while (location.host);`, 2],
    [`var f = function*() { yield location.href; }; var g = async () => { await location.href; };`, 2],
    [`for (const x of location.href) {} for (var k in location.host) {} label: for (;;) { location.href; break label; }`, 3],
    ["var t = `${location.href}`; var tt = tag`${location.href}`;", 2],
    [`a ?? location.href; a?.[location.href]; a?.(location.href); new X(location.href); x = c ? location.href : location.host;`, 6],
    [`switch (location.href) { case location.host: location.href; default: location.port; }`, 4],
    [`for (var i = location.href, j = location.host; i < j; i++) { location.port }`, 3],
    [`for (const [a = location.href] of xs) {} for (let {b = location.host} in o) {}`, 2],
];

describe("client JS rewriter reaches every expression position", () => {
    for (const [src, n] of cases) {
        it(src.slice(0, 70), () => {
            const out = rewriteJsSource(src, defaultJsRewriteOptions());
            const body = out.slice(out.indexOf("\n") + 1); // past the preamble line
            // Every location read is wrapped (computed member access adds wrappers of its own).
            expect((body.match(/\$rewriter\.wrap_/g) ?? []).length, out).toBeGreaterThanOrEqual(n);
            expect(() => new Function(out)).not.toThrow();
        });
    }
    // Module syntax: parsed as a module, so checked by re-parsing only.
    for (const [src, n] of [
        [`export const m = { 5(e) { return location.href; } }; export function f() { return location.host; } export class K { m() { return location.port; } }`, 3],
        [`export default { m() { return location.href; } };`, 1],
        [`export default function () { return location.href; }`, 1],
    ] as Array<[string, number]>) {
        it(src.slice(0, 70), () => {
            const out = rewriteJsSource(src, defaultJsRewriteOptions());
            const body = out.slice(out.indexOf("\n") + 1);
            expect((body.match(/\$rewriter\.wrap_/g) ?? []).length, out).toBeGreaterThanOrEqual(n);
        });
    }
});
