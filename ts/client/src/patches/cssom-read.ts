// Stylesheets read through CSSOM, as directly (round H/I/K). Through the
// proxy every sheet is the proxy's and fetched same-origin, so:
//   * `StyleSheet#href`, `CSSImportRule#href` named the proxified URL —
//     read back as the page's;
//   * a rule's `cssText` held proxified URLs — read back (a URL the page
//     wrote relative reads back absolute: a gap);
//   * a sheet of another origin fetched without CORS gave its rules, where
//     directly `cssRules` / `rules` / `insertRule` / `deleteRule` / `addRule`
//     / `removeRule` throw SecurityError (spec/ErrorEvents.agda muted: the
//     same judgement as an error's). An imported sheet of another origin is
//     so even in a CORS sheet (an @import is fetched without CORS, measured).
// Declarations (style, getComputedStyle) read back in
// css-style-declaration.ts.

import { nO, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { heldAttr, originalAttr } from "../native/originals";
import { scriptMuted } from "./error-events";

const MESSAGES: Record<string, string> = {
    cssRules: "Failed to read the 'cssRules' property from 'CSSStyleSheet': Cannot access rules",
    rules: "Failed to read the 'rules' property from 'CSSStyleSheet': Cannot access rules",
    insertRule: "Failed to execute 'insertRule' on 'CSSStyleSheet': Cannot access StyleSheet to insertRule",
    deleteRule: "Failed to execute 'deleteRule' on 'CSSStyleSheet': Cannot access StyleSheet to deleteRule",
    addRule: "Failed to execute 'addRule' on 'CSSStyleSheet': Cannot access StyleSheet to insertRule",
    removeRule: "Failed to execute 'removeRule' on 'CSSStyleSheet': Cannot access StyleSheet to deleteRule",
};

export function patchCssomRead(targetWindow: Window, unwrapOne: (u: string) => string, readBack: (t: string) => string, pageOrigin: () => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const SS = g["StyleSheet"]?.prototype, CSS = g["CSSStyleSheet"]?.prototype, IR = g["CSSImportRule"]?.prototype, R = g["CSSRule"]?.prototype;
    const DE = (targetWindow as unknown as { DOMException?: new (m: string, n: string) => Error }).DOMException;
    if (!SS || !CSS) return;
    const nHref = nO.getOwnPropertyDescriptor(SS, "href")?.get;
    const nOwnerNode = nO.getOwnPropertyDescriptor(SS, "ownerNode")?.get;
    const nOwnerRule = nO.getOwnPropertyDescriptor(CSS, "ownerRule")?.get;
    if (!nHref) return;
    const back = (v: unknown): unknown => (typeof v === "string" ? unwrapOne(v) : v);
    wrapAccessor<unknown>(SS, "href", { get: (gt, self) => back(ncall(gt, self)) });
    if (IR && nO.getOwnPropertyDescriptor(IR, "href")?.get) wrapAccessor<unknown>(IR, "href", { get: (gt, self) => back(ncall(gt, self)) });
    if (R && nO.getOwnPropertyDescriptor(R, "cssText")?.get) wrapAccessor<unknown>(R, "cssText", { get: (gt, self) => { const v = ncall(gt, self); return typeof v === "string" ? readBack(v) : v; } });

    const muted = (sheet: unknown): boolean => {
        try {
            const href = ncall(nHref, sheet) as string | null;
            if (typeof href !== "string") return false; // inline or constructed: the page's own
            const original = unwrapOne(href);
            if (original === href) return false; // not one the proxy served
            let same = false;
            try { same = new URL(original).origin === pageOrigin(); } catch { same = false; }
            if (same) return false;
            if (nOwnerRule && ncall(nOwnerRule, sheet)) return true; // imported: fetched without CORS
            const node = nOwnerNode ? ncall(nOwnerNode, sheet) as Element | null : null;
            if (!node || node.nodeType !== 1) return false;
            const o = originalAttr(node, "crossorigin");
            const written = o !== undefined ? o.value : heldAttr(node, "crossorigin");
            return scriptMuted(false, written !== null, false);
        } catch {
            return false;
        }
    };
    const refuse = (key: string): never => { throw new (DE ?? Error)(MESSAGES[key]!, "SecurityError"); };
    for (const key of ["cssRules", "rules"]) {
        if (nO.getOwnPropertyDescriptor(CSS, key)?.get) wrapAccessor<unknown>(CSS, key, { get: (gt, self) => (muted(self) ? refuse(key) : ncall(gt, self)) });
    }
    for (const key of ["insertRule", "deleteRule", "addRule", "removeRule"]) {
        if (typeof nO.getOwnPropertyDescriptor(CSS, key)?.value !== "function") continue;
        wrapMethod<(...a: unknown[]) => unknown>(CSS, key, (native, self, args) => {
            // The native's own arity TypeError first.
            if (args.length >= (key === "insertRule" || key === "deleteRule" ? 1 : 0) && muted(self)) refuse(key);
            return ncall(native as (...a: unknown[]) => unknown, self, ...args);
        });
    }
}
