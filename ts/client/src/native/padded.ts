// Stand-ins V8 itself prints as natives.
//
// Function.prototype.toString is masked for every stand-in (surface.ts),
// but V8's own messages print a function's source without calling it:
// `class X extends f {}` throws "Class extends value <source of f> is not
// a constructor or null" — Kasada reads that of a native (Costco,
// 2026-11-20). V8 prints "function NAME() { [native code] }" for a
// function whose `function` token (a method's name) lies more than 65535
// characters before its parameters (it does not record the offset), and
// NAME is the function's own: so each name needs a function of its own,
// with the gap in the bundle's text. A method body that starts with the
// marker argument "__crn_pad__" (`return body(this, args, "__crn_pad__")`)
// gets the gap at build time, and loses the marker (vite.config.ts
// padNatives), only for the few names below: each costs ~64 KiB of source.
// Checked: tests/native/surface-vs-chromium.

type Body = (self: unknown, args: unknown[], mark?: string) => unknown;
type AnyFn = (...a: unknown[]) => unknown;

export const PADDED_METHODS: Record<string, (body: Body) => AnyFn> = {
    toString: (body: Body) => ({ toString(...args: unknown[]): unknown { return body(this, args, "__crn_pad__"); } }).toString as AnyFn,
};
