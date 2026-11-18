// Reading markup back, as the page wrote it (native/originals.ts holds the
// originals): getAttribute, hasAttribute, Attr.value, a script's or style's
// text, innerHTML / outerHTML / getHTML / XMLSerializer, and clones that
// keep their originals. removeAttribute forgets the attribute's original.
//
// Also here: the consumer of the originals attribute on parser-inserted
// nodes, and the MutationObserver filter that keeps its removal out of the
// page's own observers.
//
// Known gaps: `attributes` / getAttributeNames still list what the element
// holds (an attribute cyrano dropped — integrity — is missing from the
// list, though getAttribute returns it); a rewritten inline script in
// server HTML or in an HTML string reads back rewritten (only script text
// set through textContent / text / innerHTML is kept); CSS attribute
// selectors match the rewritten values.

import {
    ORIGINALS_ATTR, asWritten, consume, copyOriginals, forgetAttr, hasOriginals, originalAttr, originalText,
} from "../native/originals";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";

type Protos = Record<string, { prototype: object } | undefined>;

const isRawText = (x: unknown): x is Element =>
    typeof x === "object" && x !== null && (x as Node).nodeType === 1 &&
    ((x as Element).tagName === "SCRIPT" || (x as Element).tagName === "STYLE");

export function patchReadBack(targetWindow: Window, onElement: (el: Element) => void = () => undefined): void {
    const g = targetWindow as unknown as Protos;
    const E = g["Element"]?.prototype;
    const N = g["Node"]?.prototype;
    if (!E || !N) return;

    // ── attributes ──────────────────────────────────────────────────────
    wrapMethod<(...a: unknown[]) => string | null>(E, "getAttribute", (native, self, args) => {
        const o = args.length ? originalAttr(self, String(args[0])) : undefined;
        return o ? o.value : (Reflect.apply(native, self, args) as string | null);
    });
    wrapMethod<(...a: unknown[]) => boolean>(E, "hasAttribute", (native, self, args) => {
        const o = args.length ? originalAttr(self, String(args[0])) : undefined;
        return o ? o.value !== null : (Reflect.apply(native, self, args) as boolean);
    });
    wrapMethod<(...a: unknown[]) => void>(E, "removeAttribute", (native, self, args) => {
        if (args.length && typeof self === "object" && self !== null) forgetAttr(self as Element, String(args[0]));
        return Reflect.apply(native, self, args) as void;
    });
    const A = g["Attr"]?.prototype;
    if (A) {
        const owner = Object.getOwnPropertyDescriptor(A, "ownerElement")?.get;
        const name = Object.getOwnPropertyDescriptor(A, "name")?.get;
        if (owner && name) {
            wrapAccessor<string>(A, "value", {
                get: (get, self) => {
                    const o = originalAttr(owner.call(self), name.call(self) as string);
                    return o && o.value !== null ? o.value : get.call(self);
                },
            });
        }
    }

    // ── script / style text ─────────────────────────────────────────────
    const textGetter = (protoName: string, key: string): void => {
        const proto = g[protoName]?.prototype;
        if (!proto || !Object.prototype.hasOwnProperty.call(proto, key)) return;
        wrapAccessor<unknown>(proto, key, {
            get: (get, self) => (isRawText(self) ? originalText(self) : undefined) ?? get.call(self),
        });
    };
    for (const p of ["Node", "Element", "HTMLElement", "HTMLScriptElement", "HTMLStyleElement"]) {
        textGetter(p, "textContent");
        textGetter(p, "innerText");
    }
    textGetter("HTMLScriptElement", "text");

    // ── serialization ───────────────────────────────────────────────────
    const innerGet = Object.getOwnPropertyDescriptor(E, "innerHTML")?.get as ((this: unknown) => string) | undefined;
    wrapAccessor<unknown>(E, "innerHTML", {
        get: (get, self) => {
            if (!hasOriginals()) return get.call(self);
            if (isRawText(self)) return originalText(self) ?? get.call(self);
            return get.call(asWritten(self as Node));
        },
    });
    wrapAccessor<unknown>(E, "outerHTML", {
        get: (get, self) => (hasOriginals() ? get.call(asWritten(self as Node)) : get.call(self)),
    });
    if ("getHTML" in E) {
        wrapMethod<(...a: unknown[]) => string>(E, "getHTML", (native, self, args) =>
            Reflect.apply(native, hasOriginals() ? asWritten(self as Node) : self, args) as string);
    }
    const SR = g["ShadowRoot"]?.prototype;
    if (SR && Object.prototype.hasOwnProperty.call(SR, "innerHTML")) {
        // A ShadowRoot cannot be cloned: its children are, into a detached
        // element, whose innerHTML is the same serialization.
        wrapAccessor<unknown>(SR, "innerHTML", {
            get: (get, self) => {
                if (!hasOriginals() || !innerGet) return get.call(self);
                try {
                    const root = self as ShadowRoot;
                    const box = root.ownerDocument.createElement("div");
                    for (let c = root.firstChild; c; c = c.nextSibling) {
                        const w = asWritten(c);
                        box.appendChild(w === c ? c.cloneNode(true) : w); // never move the real child
                    }
                    return innerGet.call(box);
                } catch {
                    return get.call(self);
                }
            },
        });
    }
    const XS = g["XMLSerializer"]?.prototype;
    if (XS) {
        wrapMethod<(...a: unknown[]) => string>(XS, "serializeToString", (native, self, args) =>
            Reflect.apply(native, self, args.length && hasOriginals() && typeof args[0] === "object" && args[0] !== null
                ? [asWritten(args[0] as Node), ...args.slice(1)] : args) as string);
    }

    // ── clones keep their originals ─────────────────────────────────────
    wrapMethod<(...a: unknown[]) => Node>(N, "cloneNode", (native, self, args) => {
        const copy = Reflect.apply(native, self, args) as Node;
        copyOriginals(self as Node, copy, args[0] === true);
        return copy;
    });
    const D = g["Document"]?.prototype;
    if (D) {
        wrapMethod<(...a: unknown[]) => Node>(D, "importNode", (native, self, args) => {
            const copy = Reflect.apply(native, self, args) as Node;
            if (typeof args[0] === "object" && args[0] !== null) copyOriginals(args[0] as Node, copy, args[1] === true);
            return copy;
        });
    }

    // ── the page's observers never see the originals attribute go ──────
    type Rec = { type: string; attributeName: string | null };
    const mine = (r: Rec): boolean => r.type === "attributes" && r.attributeName === ORIGINALS_ATTR;
    const NativeMO = wrapConstructor<typeof MutationObserver>(targetWindow, "MutationObserver", (Native, args, newTarget) => {
        const cb = args[0];
        if (typeof cb !== "function") return Reflect.construct(Native, args, newTarget as typeof MutationObserver);
        const filtered = function (this: unknown, records: Rec[], observer: unknown): unknown {
            const kept = records.filter((r) => !mine(r));
            return kept.length ? (cb as (...a: unknown[]) => unknown).call(this, kept, observer) : undefined;
        };
        return Reflect.construct(Native, [filtered, ...args.slice(1)], newTarget as typeof MutationObserver);
    });
    if (NativeMO) {
        wrapMethod<(...a: unknown[]) => Rec[]>(NativeMO.prototype, "takeRecords", (native, self, args) =>
            (Reflect.apply(native, self, args) as Rec[]).filter((r) => !mine(r)));
    }

    // ── consume the originals of parser-inserted nodes ─────────────────
    // (Runs at the microtask checkpoint before each parser-inserted script.)
    const doc = targetWindow.document;
    const each = (node: Node): void => {
        if (node.nodeType !== 1) return;
        consume(node);
        onElement(node as Element);
        const frames = (node as Element).getElementsByTagName?.("iframe");
        if (frames) for (let i = 0; i < frames.length; i++) onElement(frames[i]!);
    };
    if (doc && NativeMO) {
        consume(doc);
        try {
            new NativeMO((records) => {
                for (const r of records) for (let i = 0; i < r.addedNodes.length; i++) each(r.addedNodes[i]!);
            }).observe(doc, { childList: true, subtree: true });
        } catch { /* non-fatal */ }
    }
}
