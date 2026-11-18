// The page's own markup, kept (REQUIREMENTS.md: attribute and markup text
// read back exactly as the page wrote it).
//
// Cyrano changes what elements hold: URL attributes are proxified,
// `integrity` is dropped, inline scripts and styles are rewritten. This
// store remembers, per element, the text of each changed attribute as the
// page wrote it (or that the page had none), and a rewritten script's or
// style's own text. Reads — getAttribute, Attr.value, srcset, textContent,
// innerHTML/outerHTML, XMLSerializer (patches/read-back.ts) — answer from
// it.
//
// An entry holds both what the element holds now and what the page wrote;
// it answers only while the element still holds that value, so a change
// made behind the store's back (another realm, a path not yet covered)
// reads natively instead of resurrecting a stale original.
//
// Server-rewritten HTML carries each element's originals in one attribute
// (ORIGINALS_ATTR; Go htmlrewrite.OriginalsAttr), as does markup the client
// rewrites (html-rewriter.ts). `consume` moves them into the store and
// removes the attribute: synchronously after every client-side HTML sink,
// and from a MutationObserver for parser-inserted nodes — its callback runs
// at the microtask checkpoint the parser performs before running each
// script, so no page script sees the attribute.

export const ORIGINALS_ATTR = "crn-o";

interface Entry { now: string | null; was: string | null }

const attrStore = new WeakMap<object, Map<string, Entry>>();
const textStore = new WeakMap<object, { now: string; was: string }>();

/** False until anything is recorded: reads then take the native path at no cost. */
let any = false;
export const hasOriginals = (): boolean => any;

interface Natives {
    getAttribute(this: Element, n: string): string | null;
    setAttribute(this: Element, n: string, v: string): void;
    removeAttribute(this: Element, n: string): void;
    cloneNode(this: Node, deep?: boolean): Node;
    textGet(this: Node): string | null;
    textSet(this: Node, v: string): void;
}
let nat: Natives | null = null;

function accessor(proto: object | undefined, key: string): PropertyDescriptor | undefined {
    for (let p = proto ?? null; p; p = Object.getPrototypeOf(p) as object | null) {
        const d = Object.getOwnPropertyDescriptor(p, key);
        if (d) return d;
    }
    return undefined;
}

/** Captures the natives this module calls. Must run before they are wrapped. */
export function initOriginals(targetWindow: Window): void {
    const g = targetWindow as unknown as Record<string, { prototype: Record<string, unknown> } | undefined>;
    const E = g["Element"]?.prototype;
    const N = g["Node"]?.prototype;
    // The element prototype's own textContent where a test DOM defines one.
    const text = accessor(E as object | undefined, "textContent") ?? accessor(N as object | undefined, "textContent");
    if (!E || !N || !text?.get || !text.set) return;
    nat = {
        getAttribute: E["getAttribute"] as Natives["getAttribute"],
        setAttribute: E["setAttribute"] as Natives["setAttribute"],
        removeAttribute: E["removeAttribute"] as Natives["removeAttribute"],
        cloneNode: N["cloneNode"] as Natives["cloneNode"],
        textGet: text.get as Natives["textGet"],
        textSet: text.set as Natives["textSet"],
    };
}

const lower = (name: string): string => name.toLowerCase();

/** Records that `el` now holds `now` for `name`, where the page wrote `was`. */
export function recordAttr(el: Element, name: string, now: string | null, was: string | null): void {
    const key = lower(name);
    if (now === was) return forgetAttr(el, key);
    let m = attrStore.get(el);
    if (!m) attrStore.set(el, (m = new Map()));
    m.set(key, { now, was });
    any = true;
}

export function forgetAttr(el: Element, name: string): void {
    attrStore.get(el)?.delete(lower(name));
}

/**
 * The attribute as the page wrote it — `{ value }`, null for "the page had
 * none" — or undefined when cyrano did not change it (read it natively).
 */
export function originalAttr(el: unknown, name: string): { value: string | null } | undefined {
    if (!any || !nat || typeof el !== "object" || el === null) return undefined;
    const e = attrStore.get(el)?.get(lower(name));
    if (!e) return undefined;
    let current: string | null;
    try { current = nat.getAttribute.call(el as Element, name); } catch { return undefined; }
    return current === e.now ? { value: e.was } : undefined;
}

/** Records a script's or style's text: now `now`, written by the page as `was`. */
export function recordText(el: Element, now: string, was: string): void {
    if (now === was) { textStore.delete(el); return; }
    textStore.set(el, { now, was });
    any = true;
}

/** A script's or style's text as the page wrote it, or undefined to read natively. */
export function originalText(el: unknown): string | undefined {
    if (!any || !nat || typeof el !== "object" || el === null) return undefined;
    const t = textStore.get(el);
    if (!t) return undefined;
    let current: string | null;
    try { current = nat.textGet.call(el as Node); } catch { return undefined; }
    return current === t.now ? t.was : undefined;
}

/**
 * Moves the originals attribute of `root` and its descendants into the
 * store, removing it from the elements.
 */
export function consume(root: unknown): void {
    if (!nat || typeof root !== "object" || root === null) return;
    const r = root as Partial<Element> & { querySelectorAll?: (s: string) => ArrayLike<Element> };
    const one = (el: Element): void => {
        let raw: string | null;
        try { raw = nat!.getAttribute.call(el, ORIGINALS_ATTR); } catch { return; }
        if (raw === null) return;
        nat!.removeAttribute.call(el, ORIGINALS_ATTR);
        let o: unknown;
        try { o = JSON.parse(raw); } catch { return; }
        if (typeof o !== "object" || o === null) return;
        for (const [name, was] of Object.entries(o)) {
            if (was !== null && typeof was !== "string") continue;
            recordAttr(el, name, nat!.getAttribute.call(el, name), was);
        }
    };
    if (r.nodeType === 1) one(r as Element);
    if (typeof r.querySelectorAll !== "function") return;
    const found = r.querySelectorAll(`[${ORIGINALS_ATTR}]`);
    for (let i = 0; i < found.length; i++) one(found[i]!);
}

function elementsOf(node: Node): Element[] {
    const out: Element[] = [];
    if (node.nodeType === 1) out.push(node as Element);
    const q = (node as Partial<Element>).querySelectorAll;
    if (typeof q === "function") {
        const all = q.call(node, "*") as ArrayLike<Element>;
        for (let i = 0; i < all.length; i++) out.push(all[i]!);
    }
    return out;
}

/** Gives `copy` (a clone of `source`, same shape) the originals `source` has. */
export function copyOriginals(source: Node, copy: Node, deep: boolean): void {
    if (!any) return;
    const from = deep ? elementsOf(source) : source.nodeType === 1 ? [source as Element] : [];
    const to = deep ? elementsOf(copy) : copy.nodeType === 1 ? [copy as Element] : [];
    if (from.length !== to.length) return;
    for (let i = 0; i < from.length; i++) {
        const m = attrStore.get(from[i]!);
        if (m) attrStore.set(to[i]!, new Map(m));
        const t = textStore.get(from[i]!);
        if (t) textStore.set(to[i]!, { ...t });
    }
}

/**
 * A deep clone of `node` holding what the page wrote: each changed
 * attribute and each rewritten script/style text restored. For serializing.
 * Returns `node` itself when nothing was ever recorded.
 */
export function asWritten<T extends Node>(node: T): T {
    if (!any || !nat) return node;
    let clone: T;
    try {
        clone = nat.cloneNode.call(node, true) as T;
    } catch {
        return node; // not clonable (a ShadowRoot)
    }
    const from = elementsOf(node);
    const to = elementsOf(clone);
    if (from.length !== to.length) return node;
    for (let i = 0; i < from.length; i++) {
        const src = from[i]!;
        const dst = to[i]!;
        const m = attrStore.get(src);
        if (m) {
            for (const [name, e] of m) {
                if (nat.getAttribute.call(src, name) !== e.now) continue; // changed behind the store's back
                if (e.was === null) nat.removeAttribute.call(dst, name);
                else nat.setAttribute.call(dst, name, e.was);
            }
        }
        const t = originalText(src);
        if (t !== undefined) nat.textSet.call(dst, t);
    }
    return clone;
}
