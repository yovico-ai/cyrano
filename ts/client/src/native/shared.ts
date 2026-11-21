// What the copies of the runtime in one page tree hold in common.
//
// Every proxied document loads the bundle, so a page and its frames run
// several copies of this code, and windows of one tree reach each other:
// a script takes `Function.prototype.toString` from one window and calls
// it on a function of another, moves a node between documents, hands a
// window on. What one copy knows about an object — the native a stand-in
// stands for, the text a page wrote into an attribute — must be what
// every copy knows, or the page sees the difference where two copies
// meet. (Cloudflare's Turnstile takes toString from an empty sandboxed
// frame it makes and reads `eval` with it; it got the stand-in's source,
// and answered by stringifying eval a million times on the page's thread:
// techcrunch.com froze for 20 s.)
//
// So such a registry is made once for a tree: looked for in this copy's
// own tables, then in the runtimes of the window's relatives (top, parent,
// opener), then made. The same goes for tables built from constants (the
// public-suffix trie: 8 ms in each of a page's hundred frames otherwise).
//
// A leaf module: the registries of native/surface.ts are among its users,
// and native/internals.ts (which publishes the tables) imports surface.

import { nO } from "./intrinsics";
import { isWindowObject } from "./brand";

/** The member of a window's `$rewriter` that holds its runtime state (native/internals.ts). */
export const KEY = "_";

/** This copy's tables: published with each window it runs (Internals.data). */
export const tables = nO.create(null) as Record<string, unknown>;

function tablesOf(win: unknown): Record<string, unknown> | undefined {
    if (!isWindowObject(win)) return undefined;
    const r = (win as { $rewriter?: Record<string, unknown> }).$rewriter;
    const i = r ? (r[KEY] as { data?: Record<string, unknown> } | undefined) : undefined;
    return i && typeof i === "object" ? i.data : undefined;
}

export function sharedData<T>(key: string, make: () => T): T {
    if (key in tables) return tables[key] as T;
    let found: unknown;
    const g = globalThis as unknown as { top?: unknown; parent?: unknown; opener?: unknown };
    const relatives: Array<() => unknown> = [() => g.top, () => g.parent, () => g.opener];
    for (let i = 0; i < relatives.length && found === undefined; i++) {
        try {
            const other = relatives[i]!();
            if (other && other !== globalThis) found = tablesOf(other)?.[key];
        } catch { /* a really cross-origin relative */ }
    }
    const value = found !== undefined ? (found as T) : make();
    tables[key] = value;
    return value;
}
