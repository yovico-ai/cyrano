// Patches CSSStyleDeclaration so dynamic CSS property assignments go through
// the CSS rewriter the same way `<style>` content and `style="..."`
// attributes do.
//
// Three surfaces:
//
//   1. `el.style.cssText = "..."` — bulk assignment of the whole inline-style
//      block. Rewrite the value as a CSS source string.
//
//   2. `el.style.setProperty("background-image", "url('x.png')")` — method-
//      form assignment. Rewrite a value that may name a URL (mayHoldUrl),
//      whatever the property.
//
//   3. `el.style.backgroundImage = "url('x.png')"` — named-property setter.
//      We patch the prototype-level setter for each known URL-bearing CSS
//      property. Browsers expose these as accessor properties on
//      CSSStyleDeclaration.prototype (and on element-style hosts); we walk
//      the prototype chain to find the right level.
//
// Surfaces NOT patched here:
//   - `el.style[Symbol.iterator]` and similar reflective access — rare in
//     URL contexts, no obvious leak vector.
//   - CSSStyleSheet.cssRules[i].style.X — same prototype, gets the same
//     patches automatically.
//
// Recursion safety: rewriteCssText is pure (no DOM callbacks), so calling
// it inside the patched setter is recursion-free.

import { cssText } from "./dynamic-html";
import { SafeWeakMap, SafeWeakSet, nO, nOP, nR, ncall } from "../native/intrinsics";
import { rewriteCssText } from "../css/rewriter";
import { wrapAccessor, wrapMethod } from "../native/surface";

// Prototypes already patched, per realm (see css-rules.ts).
const done = new SafeWeakSet<object>();

export function patchCssStyleDeclaration(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    const ctor = (targetWindow as unknown as { CSSStyleDeclaration?: { prototype: object } }).CSSStyleDeclaration;
    let proto: object | null = null;
    for (let p: object | null = ctor?.prototype ?? null; p; p = nO.getPrototypeOf(p) as object | null) {
        const d = nO.getOwnPropertyDescriptor(p, "setProperty");
        if (d && typeof d.value === "function") { proto = p; break; }
    }
    if (!proto && !ctor) proto = findCssStyleDeclarationPrototype();
    if (!proto || done.has(proto)) return;
    done.add(proto);

    // First: every member of the declaration's prototype accepts a view as
    // `this` (the URL patches below wrap these).
    acceptViews(proto);
    patchSetProperty(proto, rewriteOne);
    patchCssTextSetter(proto, rewriteOne);
    patchStyleViews(targetWindow, rewriteOne);
    // The named properties (backgroundImage …) are defined on the
    // declaration's most-derived prototype — in current Chrome a subclass
    // (CSSStyleProperties), not CSSStyleDeclaration — so they are looked up
    // from a real declaration of this realm.
    let named: object = proto;
    try {
        const style = targetWindow.document.createElement("div").style as object;
        named = nO.getPrototypeOf(style) as object;
    } catch { /* keep proto */ }
    patchNamedSetters(named, rewriteOne);

}

/**
 * Find the prototype object that hosts CSSStyleDeclaration's accessor
 * properties. In real browsers it's `globalThis.CSSStyleDeclaration.prototype`;
 * in some test environments (happy-dom) the named accessors live on a hidden
 * internal prototype reachable only by walking from a real instance.
 */
function findCssStyleDeclarationPrototype(): object | null {
    let host: HTMLElement | null = null;
    try {
        host = document.createElement("div");
        document.body.appendChild(host);
        const decl = host.style;
        // Find the prototype that has setProperty (every conformant browser
        // exposes it there).
        for (let p: object | null = nO.getPrototypeOf(decl); p; p = nO.getPrototypeOf(p)) {
            const desc = nO.getOwnPropertyDescriptor(p, "setProperty");
            if (desc && typeof desc.value === "function") return p;
        }
        return null;
    } catch {
        return null;
    } finally {
        host?.remove();
    }
}

function patchSetProperty(
    proto: object,
    rewriteOne: (url: string) => string,
): void {
    wrapMethod<(...a: unknown[]) => void>(proto, "setProperty", (native, self, args) => {
        const name = args[0];
        // (the value as the native reads it: a toString object's text, once)
        const value = args.length > 1 ? cssText(args[1]) : args[1];
        if (typeof name === "string" && typeof value === "string") {
            // A known URL-bearing property, or a value with url()/@import
            // (unknown shorthands, future properties).
            const next = args.slice();
            next[1] = mayHoldUrl(value) ? rewriteCssText(value, rewriteOne) : value;
            return nR.apply(native, self, next) as void;
        }
        return nR.apply(native, self, args) as void;
    });
}

function patchCssTextSetter(
    proto: object,
    rewriteOne: (url: string) => string,
): void {
    wrapAccessor<unknown>(proto, "cssText", {
        set: (set, self, value0) => { const value = cssText(value0); ncall(set, self, typeof value === "string" ? rewriteCssText(value, rewriteOne) : value); },
    });
}

function patchNamedSetters(
    proto: object,
    rewriteOne: (url: string) => string,
): void {
    // Where the named properties are accessors (not Chrome's own
    // properties: the views below), each setter rewrites a value that may
    // name a URL, whatever the property.
    for (const key of nR.ownKeys(proto)) {
        if (typeof key !== "string" || key === "cssText") continue;
        const d = nO.getOwnPropertyDescriptor(proto, key);
        if (!d?.set || !d.configurable) continue;
        wrapAccessor<unknown>(proto, key, {
            set: (set, self, value0) => { const value = cssText(value0); ncall(set, self, typeof value === "string" && mayHoldUrl(value) ? rewriteCssText(value, rewriteOne) : value); },
        });
    }
}

// ── Named properties: a view of each declaration ─────────────────────────
//
// In current Chrome a declaration's named properties (backgroundImage,
// background-image …) are not prototype accessors: they are the object's
// own properties, and assigning one goes to the engine's named-property
// setter, which no accessor can intercept. So page code is given, for each
// declaration, a view: a Proxy whose target is the declaration itself —
// same prototype, same own properties, same descriptors — that rewrites the
// value of a URL-bearing property on assignment. One view per declaration
// (`el.style === el.style`), handed out by every getter that returns one:
// `style` of elements and of rules. Native methods called on a view get the
// declaration itself as `this` (acceptViews).
//
// Known gap: the property reads back proxified (as setProperty's always
// has); the element's style attribute reads back as written.

const views = new SafeWeakMap<object, object>(); // declaration → view
const reals = new SafeWeakMap<object, object>(); // view → declaration

/** The declaration behind a view, or the value itself. */
const unview = (x: unknown): unknown => (typeof x === "object" && x !== null && reals.get(x)) || x;

/**
 * Whether a declaration value may name a URL: every URL a CSS value can
 * name — a url( token, a string in image-set( — needs a literal "(" (an
 * escaped one opens nothing). Decided by the value, never the property:
 * by name, -webkit-mask-image, clip-path, filter, shape-outside, marker-*,
 * fill, @font-face's src … went straight to the origin. A value without
 * "(" is left as it is by the rewriter anyway (spec/Css.agda; checked:
 * css-conformance).
 */
export function mayHoldUrl(value: string): boolean {
    return value.indexOf("(") >= 0;
}

function viewOf(decl: unknown, rewriteOne: (url: string) => string): unknown {
    if (typeof decl !== "object" || decl === null || reals.has(decl)) return decl;
    let v = views.get(decl);
    if (!v) {
        v = new Proxy(decl, {
            set: (target, p, value0, receiver) => {
                let value = typeof p === "string" && p in target ? cssText(value0) : value0;
                if (typeof p === "string" && typeof value === "string" && mayHoldUrl(value)) value = rewriteCssText(value, rewriteOne);
                // Assignments land on the declaration itself (the engine's setter).
                return nR.set(target, p, value, receiver === v ? target : receiver);
            },
            get: (target, p, receiver) => nR.get(target, p, receiver === v ? target : receiver),
            defineProperty: (target, p, d) => {
                if (typeof p === "string" && "value" in d && typeof d.value === "string" && mayHoldUrl(d.value)) {
                    d = { ...d, value: rewriteCssText(d.value, rewriteOne) };
                }
                return nR.defineProperty(target, p, d);
            },
        });
        views.set(decl, v);
        reals.set(v, decl);
    }
    return v;
}

/** Every method and accessor of `proto` called on a view acts on the declaration. */
function acceptViews(proto: object): void {
    for (const key of nR.ownKeys(proto)) {
        if (key === "constructor") continue;
        const d = nO.getOwnPropertyDescriptor(proto, key);
        if (!d || !d.configurable) continue;
        if (typeof d.value === "function") {
            wrapMethod<(...a: unknown[]) => unknown>(proto, key, (native, self, args) => nR.apply(native, unview(self), args));
        } else if (d.get || d.set) {
            wrapAccessor<unknown>(proto, key, {
                ...(d.get ? { get: (get: (this: unknown) => unknown, self: unknown) => ncall(get, unview(self)) } : {}),
                ...(d.set ? { set: (set: (this: unknown, v: unknown) => void, self: unknown, value: unknown) => ncall(set, unview(self), value) } : {}),
            });
        }
    }
}

/** `style` getters hand out views; the `style` setter (cssText) is rewritten. */
function patchStyleViews(targetWindow: Window, rewriteOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    for (const name of ["HTMLElement", "SVGElement", "MathMLElement", "CSSStyleRule", "CSSPageRule", "CSSFontFaceRule", "CSSKeyframeRule", "CSSNestedDeclarations"]) {
        const proto = g[name]?.prototype;
        if (!proto || !ncall(nOP.hasOwnProperty, proto, "style")) continue;
        const d = nO.getOwnPropertyDescriptor(proto, "style");
        if (!d?.get) continue;
        wrapAccessor<unknown>(proto, "style", {
            get: (get, self) => viewOf(ncall(get, self), rewriteOne),
            ...(d.set ? { set: (set: (this: unknown, v: unknown) => void, self: unknown, value: unknown) =>
                { const v = cssText(value); ncall(set, self, typeof v === "string" ? rewriteCssText(v, rewriteOne) : v); } } : {}),
        });
    }
}
