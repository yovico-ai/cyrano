// `<a download>` / `<area download>` to another origin (round I): Chromium
// ignores the attribute for a URL that is not same-origin (nor blob: /
// data:) and the link navigates as any other; through the proxy every URL
// is the proxy's, so it always applied — a file save instead of the page.
//
// The first click listener at the window (before any page script) takes
// such a link's `download` away for the event — the browser's activation
// behaviour, after the dispatch, then navigates it as a plain link, with
// its target and whatever the page's listeners prevented — and puts it back
// in the next task. Meanwhile the page reads it as it wrote it
// (getAttribute / hasAttribute: originals).

import { nO, ncall } from "../native/intrinsics";
import { forgetAttr, heldAttr, holdAttr, originalAttr, recordAttr } from "../native/originals";

export function patchDownloadLinks(targetWindow: Window, unwrapOne: (url: string) => string, pageOrigin: () => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const E = g["Element"]?.prototype as Record<string, unknown> | undefined;
    const ET = g["EventTarget"]?.prototype as Record<string, unknown> | undefined;
    if (!E || !ET) return;
    const closest = E["closest"] as ((this: unknown, s: string) => Element | null) | undefined;
    const getAttr = E["getAttribute"] as ((this: unknown, n: string) => string | null) | undefined;
    const removeAttr = E["removeAttribute"] as ((this: unknown, n: string) => void) | undefined;
    const listen = ET["addEventListener"] as ((this: unknown, ...a: unknown[]) => void) | undefined;
    const hrefOf = (el: Element): string | undefined => {
        for (let o: object | null = el; o; o = nO.getPrototypeOf(o) as object | null) {
            const d = nO.getOwnPropertyDescriptor(o, "href");
            if (d?.get) return ncall(d.get as (this: unknown) => string, el);
        }
        return undefined;
    };
    const setT = (targetWindow as unknown as { setTimeout: (f: () => void, ms: number) => number }).setTimeout;
    if (!closest || !getAttr || !removeAttr || !listen || typeof setT !== "function") return;
    ncall(listen as never, targetWindow, "click", (e: Event) => {
        try {
            const t = e.target as Element | null;
            if (!t || typeof (t as { nodeType?: number }).nodeType !== "number") return;
            const a = ncall(closest, t, "a[download], area[download]");
            if (!a) return;
            const was = ncall(getAttr, a, "download");
            if (was === null) return;
            const href = hrefOf(a);
            if (!href) return;
            const original = unwrapOne(href);
            let u: URL;
            try { u = new URL(original); } catch { return; }
            if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin === pageOrigin()) return;
            recordAttr(a, "download", null, was);
            ncall(removeAttr, a, "download");
            ncall(setT as never, targetWindow, () => {
                // (unless the page has set or removed it meanwhile: then it is the page's)
                const rec = originalAttr(a, "download");
                if (heldAttr(a, "download") === null && rec && rec.value === was) { holdAttr(a, "download", was); forgetAttr(a, "download"); }
            }, 0);
        } catch { /* the click as it is */ }
    }, true);
}
