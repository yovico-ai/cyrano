// CSS Typed OM (nfl.com, 2026-11-22; distilled: attributeStyleMap.set /
// append, a rule's styleMap.set, CSSStyleValue.parse with a url() loaded it
// from its origin). Values given as CSS text — a string to
// StylePropertyMap.set / append, the text CSSStyleValue.parse / parseAll
// read — are rewritten as a style's value is (css-style-declaration.ts):
// a value made by parse then holds the proxified URL. Reading back is as
// for `style`: the values read hold the proxified URLs (a known gap,
// CLAUDE.md "Reading markup back").

import { nR, nO } from "../native/intrinsics";
import { wrapMethod, wrapConstructor } from "../native/surface";
import { rewriteCssText } from "../css/rewriter";
import { mayHoldUrl } from "./css-style-declaration";
import { cssText } from "./dynamic-html";

export function patchTypedOm(targetWindow: Window, rewriteOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, ({ prototype?: object } & Record<string, unknown>) | undefined>;
    const css = (v0: unknown): unknown => { const v = cssText(v0); return typeof v === "string" && mayHoldUrl(v) ? rewriteCssText(v, rewriteOne) : v; };
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

// Web Animations (round H probe): keyframes handed to Element#animate, new
// KeyframeEffect and KeyframeEffect#setKeyframes are CSS values the style
// engine loads (a background-image keyframe fetched from its origin); and
// CSS.registerProperty's initialValue (a `<url>` property used as a
// background). A copy is handed over with its strings rewritten as a
// style's — the page's own objects are never changed (each value is read
// once, as the browser reads it). Read back (getKeyframes) they hold the
// proxified URLs, as `style` does.
const KEEP = new Set(["offset", "easing", "composite"]);

export function rewriteKeyframes(frames: unknown, css: (v: unknown) => unknown): unknown {
    if (frames === null || typeof frames !== "object") return frames;
    const one = (f: unknown): unknown => {
        if (f === null || typeof f !== "object") return f;
        const out: Record<string, unknown> = {};
        let changed = false;
        for (const k of nO.keys(f)) {
            const v = (f as Record<string, unknown>)[k];
            let w: unknown = v;
            if (!KEEP.has(k)) {
                if (typeof v === "string" || (typeof v === "object" && v !== null && !Array.isArray(v))) w = css(v);
                else if (Array.isArray(v)) {
                    const arr = v.map(css);
                    if (arr.some((x, i) => x !== v[i])) w = arr;
                }
            }
            if (w !== v) changed = true;
            out[k] = w;
        }
        return changed ? out : f;
    };
    if (Array.isArray(frames)) {
        const arr = frames.map(one);
        return arr.some((x, i) => x !== frames[i]) ? arr : frames;
    }
    // Another iterable is iterated by the browser, as it is here.
    if (typeof (frames as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
        const arr: unknown[] = [];
        for (const f of frames as Iterable<unknown>) arr.push(one(f));
        return arr;
    }
    return one(frames);
}

export function patchWebAnimations(targetWindow: Window, rewriteOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, ({ prototype?: object } & Record<string, unknown>) | undefined>;
    const css = (v0: unknown): unknown => { const v = cssText(v0); return typeof v === "string" && mayHoldUrl(v) ? rewriteCssText(v, rewriteOne) : v; };
    const E = g["Element"]?.prototype;
    if (E && typeof (E as Record<string, unknown>)["animate"] === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(E, "animate", (native, self, args) =>
            nR.apply(native, self, args.length ? [rewriteKeyframes(args[0], css), ...args.slice(1)] : args));
    }
    const K = g["KeyframeEffect"];
    if (K?.prototype && typeof (K.prototype as Record<string, unknown>)["setKeyframes"] === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(K.prototype, "setKeyframes", (native, self, args) =>
            nR.apply(native, self, args.length ? [rewriteKeyframes(args[0], css), ...args.slice(1)] : args));
    }
    if (K) {
        wrapConstructor<typeof KeyframeEffect>(targetWindow, "KeyframeEffect", (Native, args, newTarget) =>
            nR.construct(Native, args.length > 1 ? [args[0], rewriteKeyframes(args[1], css), ...args.slice(2)] : args, newTarget as typeof KeyframeEffect));
    }
    const C = g["CSS"] as unknown as Record<string, unknown> | undefined;
    if (C && typeof C["registerProperty"] === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(C, "registerProperty", (native, self, args) => {
            const d = args[0];
            if (d === null || typeof d !== "object") return nR.apply(native, self, args);
            const iv = (d as { initialValue?: unknown }).initialValue;
            const now = css(iv);
            if (now === iv) return nR.apply(native, self, args);
            // A copy of the descriptor's members the browser reads.
            const copy: Record<string, unknown> = {};
            for (const k of ["name", "syntax", "inherits"]) copy[k] = (d as Record<string, unknown>)[k];
            copy["initialValue"] = now;
            return nR.apply(native, self, [copy, ...args.slice(1)]);
        });
    }
}
