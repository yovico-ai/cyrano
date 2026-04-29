// Patches CSSStyleSheet.prototype.insertRule (and related rule-mutation APIs)
// so dynamically inserted CSS rules go through the CSS rewriter the same way
// inline `<style>` content and `style="..."` attributes do.
//
// Surfaces patched here:
//   - CSSStyleSheet.prototype.insertRule(rule, index?)
//   - CSSGroupingRule.prototype.insertRule(rule, index?)  (covers @media,
//     @supports, etc. — they expose the same insertRule on CSSGroupingRule)
//
// Surfaces deliberately NOT patched (yet):
//   - el.style.backgroundImage = "url(...)" — would require patching every
//     URL-bearing CSSStyleDeclaration property individually. Tracked as a
//     separate gap; not as common in real-world dynamic CSS as insertRule.
//
// Implementation note — finding the prototype that actually owns insertRule:
//   In real browsers it's at globalThis.CSSStyleSheet.prototype as expected.
//   In some test environments (happy-dom, jsdom variants) the global class
//   is just a marker and the real insertRule lives on a private internal
//   prototype that the instances delegate to. We walk the prototype chain
//   of a freshly-created stylesheet to find whichever object actually owns
//   the method, so the patch lands in both kinds of environment.
//
// Recursion safety: insertRule's argument is a CSS source string that we run
// through rewriteCssText. The rewriter is pure (no DOM callbacks) so there
// is no recursion concern.

import { rewriteCssText } from "../css/rewriter";

let patched = false;

export function patchCssRules(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    if (patched) return;

    patchInsertRuleOn(findInsertRulePrototype("style"), rewriteOne);
    patchInsertRuleOn(findGroupingRuleInsertRulePrototype(), rewriteOne);

    patched = true;
}

/**
 * Finds the prototype object that owns `insertRule` for top-level stylesheets.
 * Returns null if a stylesheet can't be created (very headless environments).
 */
function findInsertRulePrototype(_kind: "style"): object | null {
    let host: HTMLStyleElement | null = null;
    try {
        host = document.createElement("style");
        document.head.appendChild(host);
        const sheet = host.sheet;
        if (!sheet) return null;
        return findPrototypeWith(sheet, "insertRule");
    } catch {
        return null;
    } finally {
        host?.remove();
    }
}

/**
 * Finds the prototype object that owns `insertRule` for grouping rules
 * (CSSGroupingRule — @media, @supports, etc.). We need a real grouping rule
 * to walk its proto chain, so we briefly insert one.
 */
function findGroupingRuleInsertRulePrototype(): object | null {
    let host: HTMLStyleElement | null = null;
    try {
        host = document.createElement("style");
        document.head.appendChild(host);
        const sheet = host.sheet;
        if (!sheet) return null;
        // Inserting an @media rule gives us a CSSMediaRule (a CSSGroupingRule).
        const idx = sheet.insertRule("@media (min-width: 0px) {}", 0);
        const rule = sheet.cssRules[idx];
        if (!rule) return null;
        return findPrototypeWith(rule, "insertRule");
    } catch {
        return null;
    } finally {
        host?.remove();
    }
}

function findPrototypeWith(instance: object, methodName: string): object | null {
    for (let p: object | null = Object.getPrototypeOf(instance); p; p = Object.getPrototypeOf(p)) {
        const desc = Object.getOwnPropertyDescriptor(p, methodName);
        if (desc && typeof desc.value === "function") return p;
    }
    return null;
}

function patchInsertRuleOn(
    proto: object | null,
    rewriteOne: (url: string) => string,
): void {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, "insertRule");
    if (!desc || typeof desc.value !== "function") return;

    const original = desc.value as (rule: string, index?: number) => number;
    Object.defineProperty(proto, "insertRule", {
        configurable: desc.configurable ?? true,
        writable: desc.writable ?? true,
        enumerable: desc.enumerable ?? false,
        value: function patchedInsertRule(
            this: CSSStyleSheet | CSSGroupingRule,
            rule: string,
            index?: number,
        ): number {
            const rewritten = typeof rule === "string"
                ? rewriteCssText(rule, rewriteOne)
                : rule;
            return original.call(this, rewritten, index);
        },
    });
}
