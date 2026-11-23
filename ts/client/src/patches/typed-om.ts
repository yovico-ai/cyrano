// CSS Typed OM (nfl.com, 2026-11-22; distilled: attributeStyleMap.set /
// append, a rule's styleMap.set, CSSStyleValue.parse with a url() loaded it
// from its origin). Values given as CSS text — a string to
// StylePropertyMap.set / append, the text CSSStyleValue.parse / parseAll
// read — are rewritten as a style's value is (css-style-declaration.ts):
// a value made by parse then holds the proxified URL. Reading back is as
// for `style`: the values read hold the proxified URLs (a known gap,
// CLAUDE.md "Reading markup back").

import { nR } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";
import { rewriteCssText } from "../css/rewriter";
import { mayHoldUrl } from "./css-style-declaration";

export function patchTypedOm(targetWindow: Window, rewriteOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, ({ prototype?: object } & Record<string, unknown>) | undefined>;
    const css = (v: unknown): unknown => (typeof v === "string" && mayHoldUrl(v) ? rewriteCssText(v, rewriteOne) : v);
    const M = g["StylePropertyMap"]?.prototype;
    if (M) {
        for (const name of ["set", "append"]) {
            wrapMethod<(...a: unknown[]) => unknown>(M, name, (native, self, args) =>
                nR.apply(native, self, args.length > 1 ? [args[0], ...args.slice(1).map(css)] : args));
        }
    }
    const V = g["CSSStyleValue"];
    if (V) {
        for (const name of ["parse", "parseAll"]) {
            if (typeof V[name] !== "function") continue;
            wrapMethod<(...a: unknown[]) => unknown>(V, name, (native, self, args) =>
                nR.apply(native, self, args.length > 1 ? [args[0], css(args[1]), ...args.slice(2)] : args));
        }
    }
}
