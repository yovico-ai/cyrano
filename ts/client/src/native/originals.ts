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

import { SafeMap, SafeWeakMap, nO, ncall, sIncludes, sStarts } from "./intrinsics";
import { trusted } from "./trusted";
import { MARK, original } from "../js/marks";
import { sharedData } from "./shared";

export const ORIGINALS_ATTR = "crn-o";

interface Entry { now: string | null; was: string | null }

// One for a page tree (native/shared.ts): a node moved to another document
// is read there by that document's copy of the runtime.
const attrStore = sharedData("originals.attrs", () => new SafeWeakMap<object, Map<string, Entry>>());
const textStore = sharedData("originals.text", () => new SafeWeakMap<object, { now: string; was: string }>());

/** False until anything is recorded: reads then take the native path at no cost. */
const recorded = sharedData("originals.any", () => ({ any: false }));
export const hasOriginals = (): boolean => recorded.any;

interface Natives {
    getAttribute(this: Element, n: string): string | null;
    setAttribute(this: Element, n: string, v: string): void;
    removeAttribute(this: Element, n: string): void;
    cloneNode(this: Node, deep?: boolean): Node;
    importNode: ((this: Document, n: Node, deep?: boolean) => Node) | undefined;
    /** A document with no browsing context: what is cloned into it loads nothing. */
    inert: () => Document | null;
    textGet(this: Node): string | null;
    textSet(this: Node, v: string): void;
}
let nat: Natives | null = null;

function accessor(proto: object | undefined, key: string): PropertyDescriptor | undefined {
    for (let p = proto ?? null; p; p = nO.getPrototypeOf(p) as object | null) {
        const d = nO.getOwnPropertyDescriptor(p, key);
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
    const D = g["Document"]?.prototype;
    const doc = (targetWindow as unknown as { document?: Document }).document;
    let inertDoc: Document | null | undefined;
    nat = {
        importNode: D?.["importNode"] as Natives["importNode"],
        inert: () => {
            if (inertDoc === undefined) {
                try { inertDoc = doc ? doc.implementation.createHTMLDocument("") : null; } catch { inertDoc = null; }
            }
            return inertDoc;
        },
        getAttribute: E["getAttribute"] as Natives["getAttribute"],
        setAttribute: E["setAttribute"] as Natives["setAttribute"],
        removeAttribute: E["removeAttribute"] as Natives["removeAttribute"],
        cloneNode: N["cloneNode"] as Natives["cloneNode"],
        textGet: text.get as Natives["textGet"],
        textSet: text.set as Natives["textSet"],
    };
}

const lower = (name: string): string => name.toLowerCase();

/** The attribute as the element holds it (the native getAttribute, not the read-back). */
export function heldAttr(el: Element, name: string): string | null {
    if (!nat) return el.getAttribute(name);
    return ncall(nat.getAttribute, el, name) as string | null;
}

/** Sets the attribute on the element itself (the native setAttribute). */
export function holdAttr(el: Element, name: string, value: string): void {
    if (!nat) { el.setAttribute(name, value); return; }
    ncall(nat.setAttribute, el, name, value);
}

/** Records that `el` now holds `now` for `name`, where the page wrote `was`. */
export function recordAttr(el: Element, name: string, now: string | null, was: string | null): void {
    const key = lower(name);
    if (now === was) return forgetAttr(el, key);
    let m = attrStore.get(el);
    if (!m) attrStore.set(el, (m = new SafeMap()));
    m.set(key, { now, was });
    recorded.any = true;
}

export function forgetAttr(el: Element, name: string): void {
    attrStore.get(el)?.delete(lower(name));
}

/**
 * The attribute as the page wrote it — `{ value }`, null for "the page had
 * none" — or undefined when cyrano did not change it (read it natively).
 */
export function originalAttr(el: unknown, name: string): { value: string | null } | undefined {
    if (!recorded.any || !nat || typeof el !== "object" || el === null) return undefined;
    const e = attrStore.get(el)?.get(lower(name));
    if (!e) return undefined;
    let current: string | null;
    try { current = ncall(nat.getAttribute, el as Element, name); } catch { return undefined; }
    return current === e.now ? { value: e.was } : undefined;
}

/** Records a script's or style's text: now `now`, written by the page as `was`. */
export function recordText(el: Element, now: string, was: string): void {
    if (now === was) { textStore.delete(el); return; }
    textStore.set(el, { now, was });
    recorded.any = true;
}

/**
 * A text node the runtime rewrote on its way into a <script> or <style>
 * (appended, in a fragment, a string the page appended): what it holds
 * now and what the page wrote. The element's text is then read back from
 * its children, whatever the place each was put.
 */
export function recordTextNode(node: object, now: string, was: string): void {
    if (now === was) { textStore.delete(node); return; }
    textStore.set(node, { now, was });
    recorded.any = true;
}

/** A text node's data as the page wrote it, or undefined when the runtime did not change it (or the page has since). */
function textNodeAsWritten(node: Node): string | undefined {
    const t = textStore.get(node);
    if (!t) return undefined;
    let data: string | null;
    try { data = ncall(nat!.textGet, node); } catch { return undefined; } // the native: data reads back as written
    return data === t.now ? t.was : undefined;
}

/** An element's text gathered from its children as written, when any of them was rewritten. */
function childrenAsWritten(el: Node): string | undefined {
    let any = false, out = "";
    for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 3 && c.nodeType !== 4) continue;
        const w = textNodeAsWritten(c);
        if (w !== undefined) any = true;
        out += w ?? (ncall(nat!.textGet, c) ?? "");
    }
    return any ? out : undefined;
}

/** A script's or style's text as the page wrote it, or undefined to read natively. */
export function originalText(el: unknown): string | undefined {
    if (!nat || typeof el !== "object" || el === null) return undefined;
    const t = textStore.get(el);
    let current0: string | null = null;
    if (t) { try { current0 = ncall(nat.textGet, el as Node); } catch { /* below */ } }
    if (!t || current0 !== t.now) {
        const fromChildren = childrenAsWritten(el as Node);
        if (fromChildren !== undefined) return fromChildren;
    }
    if (!t) {
        // A script as the server (or an HTML sink) rewrote it carries its
        // own original: the edits are marked in its text (js/marks.ts).
        if ((el as Element).tagName !== "SCRIPT") return undefined;
        let now: string | null;
        try { now = ncall(nat.textGet, el as Node); } catch { return undefined; }
        return now !== null && sIncludes(now, MARK) ? original(now) : undefined;
    }
    let current: string | null;
    try { current = ncall(nat.textGet, el as Node); } catch { return undefined; }
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
        try { raw = ncall(nat!.getAttribute, el, ORIGINALS_ATTR); } catch { return; }
        if (raw === null) return;
        ncall(nat!.removeAttribute, el, ORIGINALS_ATTR);
        let o: unknown;
        try { o = JSON.parse(raw); } catch { return; }
        if (typeof o !== "object" || o === null) return;
        for (const [name, was] of nO.entries(o)) {
            if (was !== null && typeof was !== "string") continue;
            recordAttr(el, name, ncall(nat!.getAttribute, el, name), was);
        }
    };
    if (r.nodeType === 1) one(r as Element);
    if (typeof r.querySelectorAll !== "function") return;
    const found = r.querySelectorAll(`[${ORIGINALS_ATTR}]`);
    for (let i = 0; i < found.length; i++) one(found[i]!);
    // A template's content is a fragment of its own, which selectors do
    // not reach: markup set into a template kept the attribute there, and
    // so did every copy of it (Next.js builds its head elements so: they
    // never isEqualNode the page's, washingtonpost.com).
    const content = (t: unknown): void => {
        const c = (t as { content?: unknown }).content;
        if (typeof c === "object" && c !== null && c !== root) consume(c);
    };
    if (r.nodeType === 1 && (r as Element).localName === "template") content(r);
    const templates = r.querySelectorAll("template");
    for (let i = 0; i < templates.length; i++) content(templates[i]);
}

function elementsOf(node: Node): Element[] {
    const out: Element[] = [];
    if (node.nodeType === 1) out.push(node as Element);
    const q = (node as Partial<Element>).querySelectorAll;
    if (typeof q === "function") {
        const all = ncall(q, node, "*") as ArrayLike<Element>;
        for (let i = 0; i < all.length; i++) out.push(all[i]!);
    }
    return out;
}

/** Gives `copy` (a clone of `source`, same shape) the originals `source` has. */
export function copyOriginals(source: Node, copy: Node, deep: boolean): void {
    if (!recorded.any) return;
    const from = deep ? elementsOf(source) : source.nodeType === 1 ? [source as Element] : [];
    const to = deep ? elementsOf(copy) : copy.nodeType === 1 ? [copy as Element] : [];
    if (from.length !== to.length) return;
    for (let i = 0; i < from.length; i++) {
        const m = attrStore.get(from[i]!);
        if (m) attrStore.set(to[i]!, new SafeMap(m));
        const t = textStore.get(from[i]!);
        if (t) textStore.set(to[i]!, { ...t });
    }
}

/**
 * A deep clone of `node` holding what the page wrote: each changed
 * attribute and each rewritten script/style text restored. For serializing.
 * (Callers skip it when there is nothing to restore: mayDiffer.)
 */
export function asWritten<T extends Node>(node: T): T {
    if (!nat) return node;
    let clone: T;
    try {
        // Into a document with no browsing context: in the page's own, a
        // cloned <img> or <link> would start loading the original URLs it
        // is given below (and a custom element's constructor would run).
        // (A Document cannot be imported; its clone is a document of its
        // own, with no browsing context either.)
        const inert = node.nodeType === 9 ? null : nat.inert();
        clone = (inert && nat.importNode
            ? ncall(nat.importNode, inert, node, true)
            : ncall(nat.cloneNode, node, true)) as T;
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
                if (ncall(nat.getAttribute, src, name) !== e.now) continue; // changed behind the store's back
                if (e.was === null) ncall(nat.removeAttribute, dst, name);
                // (Trusted values: the clone's attributes and script text
                // are sinks too under Trusted Types — native/trusted.ts.)
                else ncall(nat.setAttribute, dst, name, trustedForAttr(dst, name, e.was));
            }
        }
        const t = originalText(src);
        if (t !== undefined) ncall(nat.textSet, dst, (dst.tagName === "SCRIPT" ? trusted(globalThis, "Script", t) : t) as string);
    }
    return clone;
}

/**
 * `node` serialized as the page wrote it: `serialize` applied to its
 * as-written clone.
 *
 * The clone lives in a document without scripting, and the HTML serializer
 * escapes the text of a <noscript> there ("&lt;div&gt;…") where the page's
 * own document, with scripting, gives it raw. Each such text is replaced by
 * a token for the serialization and put back, raw, in the result.
 */
export function serializedAsWritten(node: Node, serialize: (n: Node) => string): string {
    const clone = asWritten(node);
    if (clone === node) return serialize(node);
    const held: string[] = [];
    try {
        const root = clone as unknown as Element;
        const list: Element[] = [];
        if (root.nodeType === 1 && root.tagName === "NOSCRIPT") list.push(root);
        if (typeof root.querySelectorAll === "function") root.querySelectorAll("noscript").forEach((e) => list.push(e));
        for (const ns of list) {
            for (let c = ns.firstChild; c; c = c.nextSibling) {
                if (c.nodeType !== 3) continue;
                const text = c as Text;
                if (!/[&<>\u00a0]/.test(text.data)) continue;
                held.push(text.data);
                text.data = `${MARK}ns${held.length - 1}${MARK}`;
            }
        }
    } catch { /* serialized as it is */ }
    const out = serialize(clone);
    return held.length ? out.replace(new RegExp(`${MARK}ns(\\d+)${MARK}`, "g"), (m, i: string) => held[Number(i)] ?? m) : out;
}

/**
 * The text of `node` — a text node, or what textContent gathers from an
 * element's or fragment's descendants — as the page wrote it, given the
 * text `raw` it holds now. A rewritten script's text is the only text that
 * differs: by its marked edits (js/marks.ts), or by the store.
 */
export function textAsWritten(node: unknown, raw: string): string {
    if (!nat || typeof node !== "object" || node === null) return raw;
    const n = node as Node;
    try {
        if (n.nodeType === 3 || n.nodeType === 4) {
            const parent = n.parentNode as Element | null;
            if (!parent || parent.nodeType !== 1 || (parent.tagName !== "SCRIPT" && parent.tagName !== "STYLE")) return raw;
            const own = textNodeAsWritten(n);
            if (own !== undefined) return own;
            if (!n.previousSibling && !n.nextSibling) return originalText(parent) ?? raw;
            return sIncludes(raw, MARK) ? original(raw) : raw;
        }
        if (sIncludes(raw, MARK) && !recorded.any) return original(raw);
        if (!recorded.any && !sIncludes(raw, MARK)) return raw;
        // Texts kept in the store: read them off the as-written clone.
        const el = n as Element;
        if (typeof el.querySelector !== "function" || !el.querySelector("script,style")) return raw;
        const clone = asWritten(n);
        const text = clone === n ? raw : ncall(nat.textGet, clone);
        return text === null ? raw : (sIncludes(text, MARK) ? original(text) : text);
    } catch {
        return raw;
    }
}

/** The inert document asWritten clones into (null when there is none). */
export function inertDocument(): Document | null {
    return nat ? nat.inert() : null;
}

/** Whether `serialized` (native markup or text) may differ from what the page wrote. */
export function mayDiffer(serialized: unknown): boolean {
    return recorded.any || (typeof serialized === "string" && sIncludes(serialized, MARK));
}

/** `value` for attribute `name` of `el`, trusted where the attribute is a Trusted Types sink. */
function trustedForAttr(el: Element, name: string, value: string): string {
    const n = name.toLowerCase();
    const kind = n === "srcdoc" ? "HTML" : sStarts(n, "on") ? "Script"
        : (n === "src" && (el.tagName === "SCRIPT" || el.tagName === "EMBED")) || ((n === "data" || n === "codebase") && el.tagName === "OBJECT") ? "ScriptURL" : null;
    return (kind ? trusted(globalThis, kind, value) : value) as string;
}
