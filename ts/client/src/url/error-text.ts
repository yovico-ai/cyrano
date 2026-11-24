// A native error's message names the URL the browser was asked for: the
// proxified one ("Failed to fetch dynamically imported module:
// https://proxy/cyrano/https!js/site/a.js", importScripts' "The script at
// '…' failed to load."). Directly it names the page's URL. Error reporters
// send the message, and chunk-retry code reads the URL out of it.

import { nO, nOP, nR, ncall, sEnds } from "../native/intrinsics";

// Saved at load: a page may replace it (Zone.js does).
const nThen = Promise.prototype.then;

const ENDS = " \t\n\r'\"<>`";

/** `text` with each proxified URL (on `proxy` + "/cyrano/") it names unwrapped. */
export function unwrapUrlsInText(text: string, proxy: string, unwrap: (u: string) => string): string {
    const lead = proxy + "/cyrano/";
    let out = "", at = 0;
    for (;;) {
        const i = text.indexOf(lead, at);
        if (i < 0) return out + text.slice(at);
        let j = i + lead.length;
        while (j < text.length && ENDS.indexOf(text[j]!) < 0) j++;
        let u = text.slice(i, j);
        // A sentence's full stop or a list's comma is not the URL's.
        let tail = "";
        while (u.length && (sEnds(u, ".") || sEnds(u, ","))) { tail = u.slice(-1) + tail; u = u.slice(0, -1); }
        let plain = u;
        try { plain = unwrap(u); } catch { plain = u; }
        out += text.slice(at, i) + plain + tail;
        at = j;
    }
}

/**
 * The error to throw in place of `e`, its message naming the page's URLs:
 * `e` itself, its message put right (an own message: before its stack is
 * first read, V8 prints the new one), or — a DOMException, whose message
 * cannot be set — a new one of `DE`'s realm, of its name (the page never
 * saw the native's).
 */
export function unwrapErrorMessage(e: unknown, proxy: string, unwrap: (u: string) => string, DE?: new (m: string, n: string) => unknown): unknown {
    if (typeof e !== "object" || e === null) return e;
    try {
        const d = nO.getOwnPropertyDescriptor(e, "message");
        if (d) {
            if (typeof d.value === "string" && d.writable && d.value.indexOf(proxy + "/cyrano/") >= 0) nR.set(e, "message", unwrapUrlsInText(d.value, proxy, unwrap));
            return e;
        }
        if (!DE || ncall(nOP.toString, e) !== "[object DOMException]") return e;
        const m = (e as { message?: unknown }).message;
        if (typeof m !== "string" || m.indexOf(proxy + "/cyrano/") < 0) return e;
        return new DE(unwrapUrlsInText(m, proxy, unwrap), String((e as { name?: unknown }).name));
    } catch {
        return e;
    }
}

/**
 * import()'s promise as the page gets it: one that settles as `p` does, its
 * rejection's message naming the page's URLs. It is the page's alone — its
 * handlers attach to it, so an import the page catches raises no
 * unhandledrejection and one it leaves uncaught does, naming this promise
 * (a handler of the runtime's on `p` itself would make `p` handled, or
 * raise one for its own promise). One microtask later than `p`, after a
 * network fetch.
 */
export function unwrapRejection<T>(p: T, proxy: string, unwrap: (u: string) => string, DE?: new (m: string, n: string) => unknown): T {
    if (typeof p !== "object" || p === null) return p;
    try {
        return ncall(nThen as (this: unknown, a: unknown, b: unknown) => unknown, p, undefined, (e: unknown) => { throw unwrapErrorMessage(e, proxy, unwrap, DE); }) as T;
    } catch {
        return p; // not a promise: as it was
    }
}
