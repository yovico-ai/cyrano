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
//   We use `new CSSStyleSheet()` (constructable stylesheets, Chrome 73+) to
//   get a real instance without DOM injection, then walk its prototype chain.
//   This avoids both the CSP `style-src` violations from injecting a <style>
//   element on strict pages, and the happy-dom/jsdom pitfall where
//   CSSStyleSheet.prototype.insertRule exists as a class-level stub but the
//   instances actually delegate to a private internal prototype.
//   Falls back to <style> injection in environments that predate constructable
//   stylesheets.
//
// Recursion safety: insertRule's argument is a CSS source string that we run
// through rewriteCssText. The rewriter is pure (no DOM callbacks) so there
// is no recursion concern.

import { SafeWeakSet, nO, nOP, nR, ncall } from "../native/intrinsics";
import { rewriteCssText } from "../css/rewriter";
import { wrapMethod } from "../native/surface";

// Prototypes already patched. Per realm: the runtime module is shared by a
// page and the empty frames it initializes, each with its own prototypes.
const done = new SafeWeakSet<object>();

/** Where `key` is defined on `proto`'s chain. */
function holderOf(proto: object | undefined, key: string): object | null {
    for (let p: object | null = proto ?? null; p; p = nO.getPrototypeOf(p) as object | null) {
        if (ncall(nOP.hasOwnProperty, p, key)) return p;
    }
    return null;
}

export function patchCssRules(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    // The window's own constructors; probing instances only where it has
    // none of them (test DOMs), in the runtime's own realm.
    const own = g["CSSStyleSheet"] !== undefined;
    const sheet = own ? holderOf(g["CSSStyleSheet"]?.prototype, "insertRule") : findInsertRulePrototype("style");
    const grouping = own ? holderOf(g["CSSGroupingRule"]?.prototype, "insertRule") : findGroupingRuleInsertRulePrototype();
    for (const proto of [sheet, grouping]) {
        if (proto && !done.has(proto)) {
            done.add(proto);
            patchInsertRuleOn(proto, rewriteOne);
        }
    }
}

/**
 * Finds the prototype object that owns `insertRule` for top-level stylesheets.
 *
 * Uses a constructable stylesheet (new CSSStyleSheet()) to obtain a real
 * instance without injecting a <style> element into the DOM — avoiding both
 * the CSP `style-src` violations triggered by DOM injection on strict pages
 * and the happy-dom/jsdom pitfall where CSSStyleSheet.prototype.insertRule
 * exists at the class level but instances actually delegate to a private
 * internal prototype. Walking the instance's own chain finds whichever
 * prototype really owns the method.
 *
 * Falls back to <style> injection only in environments that predate
 * constructable stylesheets (old browsers, minimal test stubs).
 */
function findInsertRulePrototype(_kind: "style"): object | null {
    // First choice: constructable stylesheet — no DOM mutation, correct chain.
    try {
        if (typeof CSSStyleSheet !== "undefined") {
            const sheet = new CSSStyleSheet();
            const proto = findPrototypeWith(sheet, "insertRule");
            if (proto) return proto;
        }
    } catch {
        // Constructable stylesheets not supported in this environment.
    }
    // Fallback: inject a temporary <style> element to get a real instance.
    try {
        const host = document.createElement("style");
        document.head.appendChild(host);
        try {
            const sheet = host.sheet;
            if (!sheet) return null;
            return findPrototypeWith(sheet, "insertRule");
        } finally {
            host.remove();
        }
    } catch {
        return null;
    }
}

/**
 * Finds the prototype object that owns `insertRule` for grouping rules
 * (CSSGroupingRule — @media, @supports, etc.).
 *
 * Same constructable-first strategy: avoids DOM injection when possible.
 * Grouping rules aren't constructable directly, so we obtain one by inserting
 * an @media rule into a constructable stylesheet (or, if that's unavailable,
 * into a temporarily injected <style> element).
 */
function findGroupingRuleInsertRulePrototype(): object | null {
    // Helper: given a CSSStyleSheet instance, extract an @media rule's proto.
    function probeGroupingProto(sheet: CSSStyleSheet): object | null {
        try {
            const idx = sheet.insertRule("@media (min-width: 0px) {}", 0);
            const rule = sheet.cssRules[idx];
            if (!rule) return null;
            return findPrototypeWith(rule, "insertRule");
        } catch {
            return null;
        }
    }

    // First choice: constructable stylesheet.
    try {
        if (typeof CSSStyleSheet !== "undefined") {
            const sheet = new CSSStyleSheet();
            const proto = probeGroupingProto(sheet);
            if (proto) return proto;
        }
    } catch {
        // Constructable stylesheets not supported.
    }
    // Fallback: temporary <style> element.
    try {
        const host = document.createElement("style");
        document.head.appendChild(host);
        try {
            const sheet = host.sheet;
            if (!sheet) return null;
            return probeGroupingProto(sheet);
        } finally {
            host.remove();
        }
    } catch {
        return null;
    }
}

function findPrototypeWith(instance: object, methodName: string): object | null {
    for (let p: object | null = nO.getPrototypeOf(instance); p; p = nO.getPrototypeOf(p)) {
        const desc = nO.getOwnPropertyDescriptor(p, methodName);
        if (desc && typeof desc.value === "function") return p;
    }
    return null;
}

function patchInsertRuleOn(
    proto: object | null,
    rewriteOne: (url: string) => string,
): void {
    if (!proto || !ncall(nOP.hasOwnProperty, proto, "insertRule")) return;
    wrapMethod<(...a: unknown[]) => number>(proto, "insertRule", (native, self, args) => {
        if (typeof args[0] !== "string") return nR.apply(native, self, args) as number;
        const next = args.slice();
        next[0] = rewriteCssText(args[0], rewriteOne);
        return nR.apply(native, self, next) as number;
    });
}
