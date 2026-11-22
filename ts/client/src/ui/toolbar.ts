// The portal toolbar (spec/Toolbar.agda): back to the portal's main page,
// a grip to slide it along the top edge, and "<<" / ">>" to send it to
// either end.
//
// The page cannot tell it is there:
//   - it is no node of the page's DOM — it lives in a closed shadow root on
//     <body>, whose own children show through a slot (traversals, queries,
//     serialization, counts, MutationObserver records: all as without it;
//     body.shadowRoot and assignedSlot read null);
//   - it is out of flow (position: fixed) and styled by a constructed sheet
//     of the shadow root (no <style>, no style attribute: nothing for the
//     page's CSP or Trusted Types to refuse, nothing in document.styleSheets);
//   - it takes no pointer events: hit tests, hover and event targets are the
//     page's own elements. The user's pointer events are taken at the window
//     instead, by a capturing listener added before any of the page's, by
//     coordinates (spec `region`): those inside its box, and all of a drag,
//     stop there;
//   - the cursor over it is the shadow host's, set by that same sheet while
//     the pointer is inside the box and inherited by what lies beneath
//     (spec `cursorOver`). The one trace: an element's computed `cursor`
//     reads that value for as long as the pointer is over the toolbar.
//
// Top-level documents only. Its position is remembered in localStorage
// under a bare name, which no page's storage view lists (patches/storage.ts
// shows a page only names under its own prefix).
//
// Known limit: a page that makes <body> a shadow host itself (rare). If it
// does so first, that document has no toolbar; if later, its attachShadow
// throws where directly it would not. Body children carrying a `slot`
// attribute stay visible (a slot of that name is added) but are drawn after
// the others.

import { SafeWeakMap, SafeWeakSet, nO, ncall } from "../native/intrinsics";

// The box: the grip, "<<", the home button, ">>" (spec region).
export const TOOLBAR = { width: 96, height: 22, grip: 20, jump: 24 } as const;
export type Region = "outside" | "grip" | "toLeft" | "home" | "toRight";
export type Cursor = "page" | "grab" | "grabbing" | "pointer";
const STORE_KEY = "crn-toolbar-left";
const SVG = "http://www.w3.org/2000/svg";
const DRAG_SLOP = 3;

/** spec dragLeft: the left edge during a drag, kept inside the viewport. */
export function dragLeft(vw: number, width: number, start: number, grab: number, now: number): number {
    const want = start + now - grab;
    const max = vw - width;
    const at = want < 0 ? 0 : want;
    return max < 0 ? 0 : at < max ? at : max;
}

/** spec initialLeft: where it starts with no position remembered — the middle of the top edge. */
export function initialLeft(vw: number, width: number): number {
    const room = vw - width;
    return room <= 0 ? 0 : (room - (room % 2)) / 2;
}

/** spec placeLeft: a remembered position in a viewport of another width. */
export function placeLeft(vw: number, width: number, left: number): number {
    const max = vw - width;
    return max < 0 ? 0 : left < max ? left : max;
}

/** spec rightEnd: where ">>" puts it (the left end is 0). */
export function rightEnd(vw: number, width: number): number {
    return vw < width ? 0 : vw - width;
}

/** spec region: what a viewport point hits. */
export function region(left: number, width: number, height: number, grip: number, jump: number, x: number, y: number): Region {
    if (!(left <= x && x < left + width && y < height)) return "outside";
    if (x < left + grip) return "grip";
    if (x < left + grip + jump) return "toLeft";
    const last = left + width - jump;
    return (last < 0 ? 0 : last) <= x ? "toRight" : "home";
}

/** spec cursorOver: the cursor while the pointer is over a region (during a drag: wherever it is). */
export function cursorOver(dragging: boolean, r: Region): Cursor {
    return dragging ? "grabbing" : r === "outside" ? "page" : r === "grip" ? "grab" : "pointer";
}

// Dark with a light ring and a shadow: it shows on dark pages and light.
// The cursor, while the pointer is over it, is the host's — inherited by
// what lies beneath (it takes no pointer events itself).
// The slot passes the body's values on: through it the body's children
// inherit from the slot, and a property they take by `inherit` that is not
// inherited by default (*{box-sizing:inherit}: GeneratePress, USWDS) must
// be the body's — all of them inherited, the slot itself boxless.
const css = (left: number, cursor: Cursor): string => `
:host { ${cursor === "page" ? "" : `cursor: ${cursor} !important;`} }
slot { all: inherit; display: contents !important; }
${cursor === "page" ? "" : `::slotted(*) { cursor: ${cursor} !important; }`}
#crn-tb { position: fixed; top: 0; left: ${left}px; width: ${TOOLBAR.width}px; height: ${TOOLBAR.height}px; z-index: 2147483647;
  box-sizing: border-box; margin: 0; padding: 0; border: 0; border-radius: 0 0 7px 7px; background: rgba(28, 33, 42, 0.92);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.85), 0 1px 5px 1px rgba(0, 0, 0, 0.55);
  pointer-events: none; user-select: none; contain: strict; display: block; color-scheme: only light; forced-color-adjust: none; }
#crn-tb svg { position: absolute; top: 3px; width: 16px; height: 16px; fill: #fff; }
#crn-tb .g { left: 2px; opacity: 0.65; }
#crn-tb .l { left: ${TOOLBAR.grip + 4}px; }
#crn-tb .h { left: ${TOOLBAR.grip + TOOLBAR.jump + 6}px; }
#crn-tb .r { left: ${TOOLBAR.width - TOOLBAR.jump + 4}px; }
@media print { #crn-tb { display: none; } }
`;

type Fn = (...a: never[]) => unknown;

/**
 * Installs the toolbar for a top-level document. Call it before anything
 * else touches the window: it keeps the natives it uses as they are then.
 * `home`: the portal page the home button goes to.
 */
export function installToolbar(targetWindow: Window, home: string): void {
    let topLevel = false;
    try { topLevel = targetWindow.top === targetWindow; } catch { /* a frame */ }
    const doc = targetWindow.document;
    if (!topLevel || !doc) return;
    const g = targetWindow as unknown as Record<string, { prototype: Record<string, unknown> } | undefined>;
    const E = g["Element"]?.prototype, N = g["Node"]?.prototype, D = g["Document"]?.prototype, SR = g["ShadowRoot"]?.prototype;
    const Sheet = g["CSSStyleSheet"] as unknown as (new () => CSSStyleSheet) | undefined;
    const MO = g["MutationObserver"] as unknown as typeof MutationObserver | undefined;
    const ET = g["EventTarget"]?.prototype;
    if (!E || !N || !D || !SR || !Sheet || !MO || !ET) return;

    // The natives, as they are before any patch or page script.
    const attachShadow = E["attachShadow"] as Fn | undefined;
    const setAttribute = E["setAttribute"] as Fn;
    const getAttribute = E["getAttribute"] as Fn;
    const appendChild = N["appendChild"] as Fn;
    const createElement = D["createElement"] as Fn;
    const createElementNS = D["createElementNS"] as Fn;
    const addListener = ET["addEventListener"] as Fn;
    const observe = (MO.prototype as unknown as Record<string, unknown>)["observe"] as Fn;
    const watchNode = (cb: MutationCallback, node: Node, init: MutationObserverInit): void => {
        try { ncall(observe as never, new MO(cb), node, init); } catch { /* non-fatal */ }
    };
    const replaceSync = (Sheet.prototype as unknown as Record<string, unknown>)["replaceSync"] as Fn | undefined;
    const adopt = nO.getOwnPropertyDescriptor(SR, "adoptedStyleSheets")?.set ?? nO.getOwnPropertyDescriptor(g["DocumentOrShadowRoot"]?.prototype ?? {}, "adoptedStyleSheets")?.set;
    const bodyOf = nO.getOwnPropertyDescriptor(D, "body")?.get;
    const rootOf = nO.getOwnPropertyDescriptor(D, "documentElement")?.get;
    const innerWidth = nO.getOwnPropertyDescriptor(targetWindow, "innerWidth")?.get;
    const firstChildOf = nO.getOwnPropertyDescriptor(N, "firstChild")?.get;
    const nextSiblingOf = nO.getOwnPropertyDescriptor(N, "nextSibling")?.get;
    const nodeTypeOf = nO.getOwnPropertyDescriptor(N, "nodeType")?.get;
    const stopNow = (g["Event"]?.prototype as Record<string, unknown> | undefined)?.["stopImmediatePropagation"] as Fn | undefined;
    const preventDefault = (g["Event"]?.prototype as Record<string, unknown> | undefined)?.["preventDefault"] as Fn | undefined;
    // The home button leaves without a Referer, as a user typing the
    // portal's address does (a bare path asked for with a proxied page's
    // Referer is that page's own: spec/Route.agda).
    const open = (targetWindow as unknown as { open?: Fn }).open;
    if (!attachShadow || !replaceSync || !adopt || !bodyOf || !rootOf || !innerWidth || !stopNow || !preventDefault || !firstChildOf || !nextSiblingOf || !nodeTypeOf || typeof open !== "function") return;
    let store: Storage | undefined;
    let getItem: Fn | undefined, setItem: Fn | undefined;
    try {
        store = targetWindow.localStorage;
        const P = (g["Storage"]?.prototype ?? {}) as Record<string, unknown>;
        getItem = P["getItem"] as Fn; setItem = P["setItem"] as Fn;
    } catch { /* no storage here (an opaque origin): the position is not kept */ }

    const vw = (): number => ncall(innerWidth, targetWindow) as number;
    let left = initialLeft(vw(), TOOLBAR.width);
    try {
        const kept = store && getItem ? (ncall(getItem as never, store, STORE_KEY) as string | null) : null;
        const n = kept === null ? -1 : Number(kept);
        if (n >= 0 && n === n) left = n;
    } catch { /* stays in the middle */ }
    left = placeLeft(vw(), TOOLBAR.width, left);

    const sheet = new Sheet();
    let cursor: Cursor = "page";
    const paint = (): void => { try { ncall(replaceSync as never, sheet, css(left, cursor)); } catch { /* keeps its last look */ } };
    paint();

    // ── the element, inside a closed shadow root on <body> ─────────────
    const hosts = new SafeWeakSet<object>();
    const slots = new SafeWeakMap<object, { root: ShadowRoot; names: Record<string, true> }>();
    const svg = (cls: string, d: string): Element => {
        const s = ncall(createElementNS as never, doc, SVG, "svg") as Element;
        ncall(setAttribute as never, s, "viewBox", "0 0 16 16");
        ncall(setAttribute as never, s, "class", cls);
        const p = ncall(createElementNS as never, doc, SVG, "path") as Element;
        ncall(setAttribute as never, p, "d", d);
        ncall(appendChild as never, s, p);
        return s;
    };
    const namedSlot = (body: object, name: string): void => {
        const st = slots.get(body);
        if (!st || name === "" || st.names[name]) return;
        st.names[name] = true;
        const s = ncall(createElement as never, doc, "slot") as Element;
        ncall(setAttribute as never, s, "name", name);
        ncall(appendChild as never, st.root, s);
    };
    const slotNames = (body: Node): void => {
        for (let c = ncall(firstChildOf, body) as Node | null; c; c = ncall(nextSiblingOf, c) as Node | null) {
            if (ncall(nodeTypeOf, c) !== 1) continue;
            const name = ncall(getAttribute as never, c, "slot") as string | null;
            if (name) namedSlot(body, name);
        }
    };
    const attach = (): void => {
        const body = ncall(bodyOf, doc) as HTMLElement | null;
        if (!body || hosts.has(body)) return;
        hosts.add(body);
        let root: ShadowRoot;
        try {
            root = ncall(attachShadow as never, body, { mode: "closed" }) as ShadowRoot;
        } catch {
            return; // the page's own shadow host (or a <frameset>): no toolbar here
        }
        ncall(adopt as never, root, [sheet]);
        ncall(appendChild as never, root, ncall(createElement as never, doc, "slot"));
        const tb = ncall(createElement as never, doc, "div") as Element;
        ncall(setAttribute as never, tb, "id", "crn-tb");
        ncall(setAttribute as never, tb, "aria-hidden", "true");
        // The grip (six dots) and the home button (a house).
        ncall(appendChild as never, tb, svg("g", "M5 3h2v2H5zM9 3h2v2H9zM5 7h2v2H5zM9 7h2v2H9zM5 11h2v2H5zM9 11h2v2H9z"));
        ncall(appendChild as never, tb, svg("l", "M8 3 3 8l5 5 1.4-1.4L5.8 8l3.6-3.6zM13 3 8 8l5 5 1.4-1.4L10.8 8l3.6-3.6z"));
        ncall(appendChild as never, tb, svg("h", "M8 1.5 1 8h2v6h4v-4h2v4h4V8h2z"));
        ncall(appendChild as never, tb, svg("r", "M3 3l5 5-5 5-1.4-1.4L5.2 8 1.6 4.4zM8 3l5 5-5 5-1.4-1.4L10.2 8 6.6 4.4z"));
        ncall(appendChild as never, root, tb);
        slots.set(body, { root, names: {} });
        slotNames(body);
        watchNode((records) => {
                for (const r of records) {
                    if (r.type === "attributes") { const n = ncall(getAttribute as never, r.target, "slot") as string | null; if (n) namedSlot(body, n); continue; }
                    for (let i = 0; i < r.addedNodes.length; i++) {
                        const c = r.addedNodes[i]!;
                        if (ncall(nodeTypeOf, c) !== 1) continue;
                        const n = ncall(getAttribute as never, c, "slot") as string | null;
                        if (n) namedSlot(body, n);
                    }
                }
        }, body, { childList: true, attributes: true, attributeFilter: ["slot"], subtree: false });
    };
    // <body> arrives after the runtime (which runs in <head>), and a page
    // may replace it.
    const watched = new SafeWeakSet<object>();
    const watch = (): void => {
        const root = ncall(rootOf, doc) as Element | null;
        attach();
        if (!root || watched.has(root)) return;
        watched.add(root);
        watchNode(() => { attach(); }, root, { childList: true });
    };
    watchNode(() => { watch(); }, doc, { childList: true });
    watch();

    // ── the user's pointer, taken at the window before the page ────────
    let drag: { start: number; grab: number; moved: boolean; from: Region } | null = null;
    let swallowClick = false;
    const mine = (e: Event): void => { ncall(stopNow as never, e); ncall(preventDefault as never, e); };
    const at = (e: Event): Region => {
        const m = e as MouseEvent;
        return typeof m.clientX === "number" && m.clientX >= 0 && m.clientY >= 0
            ? region(left, TOOLBAR.width, TOOLBAR.height, TOOLBAR.grip, TOOLBAR.jump, m.clientX, m.clientY) : "outside";
    };
    // The cursor follows the pointer over it (spec cursorOver).
    const point = (e: Event): void => {
        const now = cursorOver(drag !== null && drag.moved, at(e));
        if (now !== cursor) { cursor = now; paint(); }
    };
    const keep = (): void => {
        try { if (store && setItem) ncall(setItem as never, store, STORE_KEY, String(left)); } catch { /* not kept */ }
    };
    const on = (type: string, f: (e: Event) => void): void => {
        try { ncall(addListener as never, targetWindow, type, (e: Event) => { if (e.isTrusted) f(e); }, { capture: true, passive: false }); } catch { /* non-fatal */ }
    };
    on("pointerdown", (e) => {
        const r = at(e);
        if (r === "outside" || (e as PointerEvent).button !== 0) { swallowClick = false; return; }
        drag = { start: left, grab: (e as PointerEvent).clientX, moved: false, from: r };
        swallowClick = true;
        mine(e);
    });
    on("pointermove", (e) => {
        if (!drag) { point(e); return; }
        const x = (e as PointerEvent).clientX;
        if (!drag.moved && x - drag.grab < DRAG_SLOP && drag.grab - x < DRAG_SLOP) { mine(e); return; }
        drag.moved = true;
        cursor = "grabbing";
        left = dragLeft(vw(), TOOLBAR.width, drag.start, drag.grab, x < 0 ? 0 : x);
        paint();
        mine(e);
    });
    const finish = (e: Event, go: boolean): void => {
        if (!drag) return;
        const d = drag;
        drag = null;
        mine(e);
        if (d.moved) { keep(); point(e); return; }
        const r = at(e);
        if (!go || r !== d.from) return;
        if (r === "home") {
            try { ncall(open as never, targetWindow, home, "_self", "noreferrer"); } catch { /* stays */ }
        } else if (r === "toLeft" || r === "toRight") {
            // "<<" and ">>": to the ends of the top edge.
            left = r === "toLeft" ? 0 : rightEnd(vw(), TOOLBAR.width);
            keep();
            paint();
            point(e);
        }
    };
    on("pointerup", (e) => finish(e, true));
    on("pointercancel", (e) => finish(e, false));
    // The compatibility mouse events, clicks and touches of the same gesture.
    for (const type of ["mousedown", "touchstart"]) on(type, (e) => { if (drag || at(e) !== "outside") mine(e); });
    for (const type of ["mousemove", "touchmove"]) on(type, (e) => { if (drag) mine(e); });
    for (const type of ["mouseup", "touchend"]) on(type, (e) => { if (drag || swallowClick) mine(e); });
    for (const type of ["click", "auxclick", "dblclick", "contextmenu"]) {
        on(type, (e) => {
            if (swallowClick || at(e) !== "outside") mine(e);
            if (type === "click") swallowClick = false;
        });
    }
    // The pointer left the window: the page's own cursor again.
    try {
        ncall(addListener as never, doc, "pointerleave", () => { if (!drag && cursor !== "page") { cursor = "page"; paint(); } }, { capture: true, passive: true });
    } catch { /* non-fatal */ }
    // The viewport narrowed: back inside it.
    try {
        ncall(addListener as never, targetWindow, "resize", () => {
            const now = placeLeft(vw(), TOOLBAR.width, left);
            if (now !== left) { left = now; paint(); }
        }, { capture: true, passive: true });
    } catch { /* non-fatal */ }
}
