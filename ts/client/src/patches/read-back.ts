// Reading markup back, as the page wrote it (native/originals.ts holds the
// originals): getAttribute, hasAttribute, Attr.value, a script's or style's
// text, innerHTML / outerHTML / getHTML / XMLSerializer, isEqualNode, and
// clones that keep their originals. removeAttribute forgets the attribute's original.
//
// Also here: the consumer of the originals attribute on parser-inserted
// nodes, and the MutationObserver filter that keeps its removal out of the
// page's own observers.
//
// Known gaps: `attributes` / getAttributeNames still list what the element
// holds (an attribute cyrano dropped — integrity — is missing from the
// list, though getAttribute returns it); CSS attribute selectors match the
// rewritten values; a script's text read in pieces (substringData, a Range
// over it) is the text it holds.

import { nO, nOP, nR, ncall } from "../native/intrinsics";
import {
    ORIGINALS_ATTR, appendNatively, asWritten, consume, consumeOriginalsOnRead, inertDocument, copyOriginals, forgetAttr, mayDiffer, originalAttr, originalText,
    serializedAsWritten, textAsWritten,
    isScriptOrStyle,
} from "../native/originals";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";
import { eachDocument, type Internals } from "../native/internals";

type Protos = Record<string, { prototype: object } | undefined>;

const isRawText = (x: unknown): x is Element =>
    typeof x === "object" && x !== null && (x as Node).nodeType === 1 && isScriptOrStyle(x as Element);

export function patchReadBack(targetWindow: Window, onElement: (el: Element) => void = () => undefined, internals?: Internals): void {
    const g = targetWindow as unknown as Protos;
    const E = g["Element"]?.prototype;
    const N = g["Node"]?.prototype;
    if (!E || !N) return;

    // ── isEqualNode ─────────────────────────────────────────────────────
    // Compared as written: Next.js's head manager keeps a server-rendered
    // <script> only if it isEqualNode the one React made — a rewritten one
    // never was, and was put in again: run twice (washingtonpost.com,
    // 2026-11-20). Where the native finds them different, their
    // as-written clones are compared.
    wrapMethod<(...a: unknown[]) => boolean>(N, "isEqualNode", (native, self, args) => {
        const r = nR.apply(native, self, args) as boolean;
        const other = args[0];
        if (r || typeof self !== "object" || self === null || typeof other !== "object" || other === null) return r;
        const a = asWritten(self as Node);
        const b = asWritten(other as Node);
        return a === self && b === other ? r : (nR.apply(native, a, [b]) as boolean);
    });

    // ── attributes ──────────────────────────────────────────────────────
    wrapMethod<(...a: unknown[]) => string | null>(E, "getAttribute", (native, self, args) => {
        const o = args.length ? originalAttr(self, String(args[0])) : undefined;
        return o ? o.value : (nR.apply(native, self, args) as string | null);
    });
    // getAttributeNS: the attribute's qualified name is the record's key.
    const nodeNS = E["getAttributeNodeNS" as keyof typeof E] as unknown as ((this: Element, ns: string | null, local: string) => Attr | null) | undefined;
    const attrName = g["Attr"]?.prototype ? nO.getOwnPropertyDescriptor(g["Attr"].prototype, "name")?.get : undefined;
    if (typeof nodeNS === "function" && attrName) {
        wrapMethod<(...a: unknown[]) => string | null>(E, "getAttributeNS", (native, self, args) => {
            let node: Attr | null = null;
            try { node = ncall(nodeNS, self, args[0], args[1]) as Attr | null; } catch { /* the native throws below */ }
            const o = node ? originalAttr(self, ncall(attrName, node) as string) : undefined;
            return o ? o.value : (nR.apply(native, self, args) as string | null);
        });
    }
    wrapMethod<(...a: unknown[]) => boolean>(E, "hasAttribute", (native, self, args) => {
        const o = args.length ? originalAttr(self, String(args[0])) : undefined;
        return o ? o.value !== null : (nR.apply(native, self, args) as boolean);
    });
    wrapMethod<(...a: unknown[]) => void>(E, "removeAttribute", (native, self, args) => {
        if (args.length && typeof self === "object" && self !== null) forgetAttr(self as Element, String(args[0]));
        return nR.apply(native, self, args) as void;
    });
    const A = g["Attr"]?.prototype;
    if (A) {
        const owner = nO.getOwnPropertyDescriptor(A, "ownerElement")?.get;
        const name = nO.getOwnPropertyDescriptor(A, "name")?.get;
        if (owner && name) {
            wrapAccessor<string>(A, "value", {
                get: (get, self) => {
                    const o = originalAttr(ncall(owner, self), ncall(name, self) as string);
                    return o && o.value !== null ? o.value : ncall(get, self);
                },
            });
            // An Attr's nodeValue and textContent are its value.
            const N = g["Node"]?.prototype;
            const type = N ? nO.getOwnPropertyDescriptor(N, "nodeType")?.get : undefined;
            if (N && type) {
                for (const key of ["nodeValue", "textContent"]) {
                    if (!ncall(nOP.hasOwnProperty, N, key)) continue;
                    wrapAccessor<unknown>(N, key, {
                        get: (get, self) => {
                            if (typeof self === "object" && self !== null && ncall(type, self) === 2) {
                                const o = originalAttr(ncall(owner, self), ncall(name, self) as string);
                                if (o && o.value !== null) return o.value;
                            }
                            return ncall(get, self);
                        },
                    });
                }
            }
        }
    }

    // ── script / style text ─────────────────────────────────────────────
    const textGetter = (protoName: string, key: string): void => {
        const proto = g[protoName]?.prototype;
        if (!proto || !ncall(nOP.hasOwnProperty, proto, key)) return;
        wrapAccessor<unknown>(proto, key, {
            get: (get, self) => {
                if (isRawText(self)) return originalText(self) ?? ncall(get, self);
                // An ancestor's text gathers its scripts' text; a text node
                // inside a script is that script's text.
                const raw = ncall(get, self);
                return typeof raw === "string" && key === "textContent" && mayDiffer(raw) ? textAsWritten(self, raw) : raw;
            },
        });
    };
    // A script's text read off its text node.
    const C = g["CharacterData"]?.prototype;
    for (const [proto, key] of [[C, "data"], [N, "nodeValue"], [g["Text"]?.prototype, "wholeText"]] as const) {
        if (!proto || !ncall(nOP.hasOwnProperty, proto, key)) continue;
        wrapAccessor<unknown>(proto, key, {
            get: (get, self) => {
                const raw = ncall(get, self);
                return typeof raw === "string" && mayDiffer(raw) && typeof self === "object" && self !== null &&
                    ((self as Node).nodeType === 3 || (self as Node).nodeType === 4) ? textAsWritten(self, raw) : raw;
            },
        });
    }
    if (C && ncall(nOP.hasOwnProperty, C, "length")) {
        const dataGet = nO.getOwnPropertyDescriptor(C, "data")?.get as ((this: unknown) => string) | undefined; // wrapped above
        wrapAccessor<number>(C, "length", {
            get: (get, self) => {
                const n = ncall(get, self);
                if (!dataGet || n === 0) return n;
                try { const d = ncall(dataGet, self); return typeof d === "string" ? d.length : n; } catch { return n; }
            },
        });
    }
    for (const p of ["Node", "Element", "HTMLElement", "HTMLScriptElement", "HTMLStyleElement"]) {
        textGetter(p, "textContent");
        textGetter(p, "innerText");
    }
    textGetter("HTMLScriptElement", "text");

    // ── serialization ───────────────────────────────────────────────────
    const innerGet = nO.getOwnPropertyDescriptor(E, "innerHTML")?.get as ((this: unknown) => string) | undefined;
    wrapAccessor<unknown>(E, "innerHTML", {
        get: (get, self) => {
            const raw = ncall(get, self);
            if (!mayDiffer(raw)) return raw;
            if (isRawText(self)) return originalText(self) ?? raw;
            return serializedAsWritten(self as Node, (n) => ncall(get, n) as string);
        },
    });
    wrapAccessor<unknown>(E, "outerHTML", {
        get: (get, self) => {
            const raw = ncall(get, self);
            return mayDiffer(raw) ? serializedAsWritten(self as Node, (n) => ncall(get, n) as string) : raw;
        },
    });
    // Whether a getHTML call serializes shadow roots.
    const wantsShadows = (o: unknown): boolean => typeof o === "object" && o !== null &&
        ((o as { serializableShadowRoots?: unknown }).serializableShadowRoots === true || Array.isArray((o as { shadowRoots?: unknown }).shadowRoots));
    if ("getHTML" in E) {
        wrapMethod<(...a: unknown[]) => string>(E, "getHTML", (native, self, args) =>
        {
            const raw = nR.apply(native, self, args) as string;
            return mayDiffer(raw) ? serializedAsWritten(self as Node, (n) => nR.apply(native, n, args) as string, wantsShadows(args[0])) : raw;
        });
    }
    // A shadow root the parser filled (<template shadowrootmode>) is a tree
    // the load-time consumer never sees: its originals are taken when the
    // page gets hold of it — an open root by shadowRoot, a closed one by
    // ElementInternals' — and before it is serialized.
    const ORIG_SEL = "[crn-o]";
    const takeRoot = (r: unknown): void => {
        try { if (r && typeof (r as ShadowRoot).querySelector === "function" && (r as ShadowRoot).querySelector(ORIG_SEL)) consume(r); } catch { /* as it is */ }
    };
    for (const [name, key] of [["Element", "shadowRoot"], ["ElementInternals", "shadowRoot"]] as const) {
        const proto = (g as unknown as Record<string, { prototype: object } | undefined>)[name]?.prototype;
        if (!proto || !nO.getOwnPropertyDescriptor(proto, key)?.get) continue;
        wrapAccessor<unknown>(proto, key, { get: (get, self) => { const r = ncall(get, self); takeRoot(r); return r; } });
    }
    const SR = g["ShadowRoot"]?.prototype;
    if (SR && ncall(nOP.hasOwnProperty, SR, "innerHTML")) {
        // A ShadowRoot cannot be cloned: its children are, into a detached
        // element, whose innerHTML is the same serialization.
        wrapAccessor<unknown>(SR, "innerHTML", {
            get: (get, self) => {
                takeRoot(self);
                const raw = ncall(get, self);
                if (!mayDiffer(raw) || !innerGet) return raw;
                try {
                    const root = self as ShadowRoot;
                    // Built where nothing loads (originals.ts asWritten).
                    const box = (inertDocument() ?? root.ownerDocument).createElement("div");
                    for (let c = root.firstChild; c; c = c.nextSibling) {
                        const w = asWritten(c);
                        // never move the real child; natively, or the insertion fix-ups proxify the clone again
                        appendNatively(box, w === c ? box.ownerDocument.importNode(c, true) : w);
                    }
                    return ncall(innerGet, box);
                } catch {
                    return ncall(get, self);
                }
            },
        });
    }
    const elGetHTML = (E as Record<string, unknown>)["getHTML"] as ((this: unknown, o?: unknown) => string) | undefined;
    if (SR && elGetHTML && ncall(nOP.hasOwnProperty, SR, "getHTML")) {
        // As its innerHTML: its children as written, in a detached box (an
        // Element's getHTML of the box is the same serialization).
        wrapMethod<(...a: unknown[]) => string>(SR, "getHTML", (native, self, args) => {
            takeRoot(self);
            const raw = nR.apply(native, self, args) as string;
            if (!mayDiffer(raw)) return raw;
            try {
                const root = self as ShadowRoot;
                const box = (inertDocument() ?? root.ownerDocument).createElement("div");
                for (let c = root.firstChild; c; c = c.nextSibling) {
                    const w = asWritten(c);
                    appendNatively(box, w === c ? box.ownerDocument.importNode(c, true) : w);
                }
                return ncall(elGetHTML, box, ...args);
            } catch {
                return raw;
            }
        });
    }
    const XS = g["XMLSerializer"]?.prototype;
    if (XS) {
        wrapMethod<(...a: unknown[]) => string>(XS, "serializeToString", (native, self, args) => {
            const raw = nR.apply(native, self, args) as string;
            return args.length && mayDiffer(raw) && typeof args[0] === "object" && args[0] !== null
                ? (nR.apply(native, self, [asWritten(args[0] as Node), ...args.slice(1)]) as string) : raw;
        });
    }

    // ── clones keep their originals ─────────────────────────────────────
    wrapMethod<(...a: unknown[]) => Node>(N, "cloneNode", (native, self, args) => {
        const copy = nR.apply(native, self, args) as Node;
        copyOriginals(self as Node, copy, args[0] === true);
        return copy;
    });
    const D = g["Document"]?.prototype;
    if (D) {
        wrapMethod<(...a: unknown[]) => Node>(D, "importNode", (native, self, args) => {
            const copy = nR.apply(native, self, args) as Node;
            if (typeof args[0] === "object" && args[0] !== null) copyOriginals(args[0] as Node, copy, args[1] === true);
            return copy;
        });
    }

    // ── a range's contents keep their originals ─────────────────────────
    // cloneContents clones, in tree order, every element the range
    // intersects below its common ancestor (contained ones deep, partially
    // contained ones shallow); extractContents moves the contained ones
    // (they keep their own) and clones the partially contained. So the
    // fragment's elements pair, in tree order, with the source elements the
    // range intersects — taken before the native runs (round I: a copy
    // handler's getSelection().getRangeAt(0).cloneContents() read the
    // proxified URLs).
    const RP = g["Range"]?.prototype as Record<string, unknown> | undefined;
    const cacGet = RP ? nO.getOwnPropertyDescriptor(RP, "commonAncestorContainer")?.get as ((this: unknown) => Node) | undefined : undefined;
    const intersects = RP?.["intersectsNode"] as ((this: unknown, n: Node) => boolean) | undefined;
    const qsa = nO.getOwnPropertyDescriptor((g["Element"]?.prototype ?? {}) as object, "querySelectorAll")?.value as ((this: unknown, s: string) => ArrayLike<Element>) | undefined;
    const fragQsa = nO.getOwnPropertyDescriptor((g["DocumentFragment"]?.prototype ?? {}) as object, "querySelectorAll")?.value as ((this: unknown, s: string) => ArrayLike<Element>) | undefined;
    if (RP && cacGet && intersects && qsa && fragQsa) {
        const touched = (range: unknown): Element[] => {
            const out: Element[] = [];
            let root: Node;
            try { root = ncall(cacGet, range); } catch { return out; }
            if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return out;
            const all = ncall(root.nodeType === 1 ? qsa : (root as unknown as { querySelectorAll: typeof qsa }).querySelectorAll!, root, "*") as ArrayLike<Element>;
            for (let i = 0; i < all.length; i++) { try { if (ncall(intersects, range, all[i]!)) out.push(all[i]!); } catch { /* skipped */ } }
            return out;
        };
        for (const key of ["cloneContents", "extractContents"] as const) {
            if (typeof RP[key] !== "function") continue;
            wrapMethod<(...a: unknown[]) => unknown>(RP, key, (native, self, args) => {
                const src = mayDiffer("") ? touched(self) : [];
                const frag = nR.apply(native, self, args) as DocumentFragment;
                if (!src.length || !frag) return frag;
                try {
                    const got = ncall(fragQsa, frag, "*") as ArrayLike<Element>;
                    if (got.length !== src.length) return frag;
                    for (let i = 0; i < got.length; i++) if (got[i] !== src[i]) copyOriginals(src[i]!, got[i]!, false);
                } catch { /* as the native made it */ }
                return frag;
            });
        }
    }

    // Range.toString(): the range's text nodes joined — a script's text in it
    // as rewritten (round K: a whole-body range read the rules' calls). It is
    // the textContent of its contents, which read back as written.
    if (RP && typeof RP["toString"] === "function" && typeof RP["cloneContents"] === "function") {
        const tcGet = nO.getOwnPropertyDescriptor((g["Node"]?.prototype ?? {}) as object, "textContent")?.get as ((this: unknown) => string) | undefined;
        wrapMethod<(...a: unknown[]) => string>(RP, "toString", (native, self, args) => {
            const raw = nR.apply(native, self, args) as string;
            if (!mayDiffer(raw) || !tcGet) return raw;
            try {
                const frag = ncall(RP["cloneContents"] as (this: unknown) => DocumentFragment, self);
                return ncall(tcGet, frag);
            } catch { return raw; }
        });
    }

    // ── the page's observers never see the originals attribute go ──────
    type Rec = { type: string; attributeName: string | null };
    const mine = (r: Rec): boolean => r.type === "attributes" && r.attributeName === ORIGINALS_ATTR;
    const NativeMO = wrapConstructor<typeof MutationObserver>(targetWindow, "MutationObserver", (Native, args, newTarget) => {
        const cb = args[0];
        if (typeof cb !== "function") return nR.construct(Native, args, newTarget as typeof MutationObserver);
        const filtered = function (this: unknown, records: Rec[], observer: unknown): unknown {
            const kept = records.filter((r) => !mine(r));
            return kept.length ? ncall((cb as (...a: unknown[]) => unknown), this, kept, observer) : undefined;
        };
        return nR.construct(Native, [filtered, ...args.slice(1)], newTarget as typeof MutationObserver);
    });
    if (NativeMO) {
        wrapMethod<(...a: unknown[]) => Rec[]>(NativeMO.prototype, "takeRecords", (native, self, args) =>
            (nR.apply(native, self, args) as Rec[]).filter((r) => !mine(r)));
    }

    // ── consume the originals of parser-inserted nodes ─────────────────
    // (Runs at the microtask checkpoint before each parser-inserted script —
    // in an HTML document; one the XML parser builds has none: there an
    // element's originals are taken when it is first read.)
    // Per document: a window that keeps its realm for its next document (a
    // frame's initial about:blank giving way to its proxied one) observes
    // that one too (native/internals.ts eachDocument).
    const each = (node: Node): void => {
        if (node.nodeType !== 1) return;
        consume(node);
        onElement(node as Element);
        const frames = (node as Element).getElementsByTagName?.("iframe");
        if (frames) for (let i = 0; i < frames.length; i++) onElement(frames[i]!);
    };
    eachDocument(internals, () => {
        const doc = targetWindow.document;
        try { if (doc && doc.contentType !== "text/html") consumeOriginalsOnRead(); } catch { /* HTML */ }
        if (doc && NativeMO) {
            consume(doc);
            try {
                new NativeMO((records) => {
                    for (const r of records) for (let i = 0; i < r.addedNodes.length; i++) each(r.addedNodes[i]!);
                }).observe(doc, { childList: true, subtree: true });
            } catch { /* non-fatal */ }
        }
    });
}
