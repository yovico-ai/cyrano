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
//      form assignment. Rewrite the value when the property name is one we
//      recognise as URL-bearing, OR if the value contains a url(...) /
//      @import construct (defensive: covers shorthand props like `background`
//      that mix URL with other declarations).
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

import { rewriteCssText } from "../css/rewriter";
import { wrapAccessor, wrapMethod } from "../native/surface";

// Camel-case named CSS properties that carry a URL value (the form the JS
// API exposes). The CSS-attribute form (with hyphens) is what setProperty
// receives. Both are listed explicitly; conversion would be straightforward
// (camelCase → kebab-case via regex) but kept explicit so the list is
// scannable and easy to extend.
const URL_BEARING_CAMEL = [
    "backgroundImage",
    "borderImage",
    "borderImageSource",
    "listStyleImage",
    "maskImage",
    "cursor",
    "content",
    // Shorthand / multi-value properties that may contain url(...). Listed
    // so the named-setter patch covers them; setProperty also does a content
    // sniff for url()/@import which catches everything else.
    "background",
    "border",
    "borderTop",
    "borderRight",
    "borderBottom",
    "borderLeft",
    "mask",
] as const;

const URL_BEARING_KEBAB_SET = new Set<string>(
    URL_BEARING_CAMEL.map(camelToKebab),
);

function camelToKebab(s: string): string {
    return s.replace(/([A-Z])/g, "-$1").toLowerCase();
}

let patched = false;

export function patchCssStyleDeclaration(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    if (patched) return;

    const proto = findCssStyleDeclarationPrototype();
    if (!proto) return;

    patchSetProperty(proto, rewriteOne);
    patchCssTextSetter(proto, rewriteOne);
    patchNamedSetters(proto, rewriteOne);

    patched = true;
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
        for (let p: object | null = Object.getPrototypeOf(decl); p; p = Object.getPrototypeOf(p)) {
            const desc = Object.getOwnPropertyDescriptor(p, "setProperty");
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
        const [name, value] = args;
        if (typeof name === "string" && typeof value === "string") {
            // A known URL-bearing property, or a value with url()/@import
            // (unknown shorthands, future properties).
            if (URL_BEARING_KEBAB_SET.has(name.toLowerCase()) || /url\s*\(|@import/i.test(value)) {
                const next = args.slice();
                next[1] = rewriteCssText(value, rewriteOne);
                return Reflect.apply(native, self, next) as void;
            }
        }
        return Reflect.apply(native, self, args) as void;
    });
}

function patchCssTextSetter(
    proto: object,
    rewriteOne: (url: string) => string,
): void {
    wrapAccessor<unknown>(proto, "cssText", {
        set: (set, self, value) => set.call(self, typeof value === "string" ? rewriteCssText(value, rewriteOne) : value),
    });
}

function patchNamedSetters(
    proto: object,
    rewriteOne: (url: string) => string,
): void {
    for (const propName of URL_BEARING_CAMEL) {
        wrapAccessor<unknown>(proto, propName, {
            set: (set, self, value) => set.call(self, typeof value === "string" ? rewriteCssText(value, rewriteOne) : value),
        });
    }
}
