// Wrapper for `*.write` / `*.writeln` calls.
//
// IMPORTANT: the server's WRAP_DOCUMENT_WRITE rule fires on ANY `.write` /
// `.writeln` member-access — not just `document.write`. The transformation is
//   obj.write(...args)  →  $rewriter.wrap_document_write({obj: obj}).write(...args)
// regardless of what `obj` is. The runtime can't know at AST-rewrite time
// whether the target is the document, a Node.js-style Writable stream, a
// WebSocket-ish wrapper, or some library's own object.
//
// So this wrapper has two jobs:
//   1. When `obj` is a Document — rewrite HTML through the mini-rewriter
//      before passing it to the document parser (the case that matters for
//      URL containment).
//   2. Otherwise — forward the args verbatim. The caller didn't mean
//      Document.write semantics; corrupting their data (e.g. a binary write
//      to a stream) would be catastrophic.
//
// We type `arg.obj` as `unknown` and gate behavior on a runtime Document
// check (`nodeType === 9`, the spec value for DOCUMENT_NODE). Cross-realm
// safe — doesn't depend on `instanceof Document` against this realm's class.

import { SafeSet, SafeWeakMap, SafeWeakSet, nO, nOP, nR, napply, ncall, nqueueMicrotask } from "../native/intrinsics";
import { isDocumentObject } from "../native/brand";
import { isTrustedValue, trusted } from "../native/trusted";
import { rewriteHtmlString } from "../patches/html-rewriter";
import { tokenize, withBootstrap } from "../patches/html-tokens";
import { sinkText } from "../patches/dynamic-html";
import { injectFramesIn } from "../patches/dynamic-iframe";
import { wrapMethod } from "../native/surface";

export interface DocumentWriteWrapper {
    write: (...args: unknown[]) => unknown;
    writeln: (...args: unknown[]) => unknown;
}

interface WriteCapable {
    write?: (...args: unknown[]) => unknown;
    writeln?: (...args: unknown[]) => unknown;
    nodeType?: number;
    defaultView?: { $rewriter?: unknown } | null;
}


// Told apart without reading the object (native/brand.ts).
function isDocumentLike(obj: unknown): obj is WriteCapable {
    return isDocumentObject(obj);
}

// Injects the bootstrap when the written content opens a new document or
// contains scripts, and the target window doesn't already have $rewriter.
// Mirrors what the server's inject.go does for static HTML; applied here to
// HTML written via document.write at runtime.
//
// Placed as the server places it (spec/HtmlTok.agda bootstrapAt): after the
// first <head> or <body>, else before the first other element (a fragment
// with scripts, e.g. GPT ads); nowhere when the markup has no element.
function maybeInjectBootstrap(
    target: WriteCapable,
    _originalHtml: string,
    rewrittenHtml: string,
    getBootstrapHtml: () => string,
): string {
    // Skip if the target document's window already has $rewriter installed.
    const win = target.defaultView;
    if (!win || win.$rewriter) return rewrittenHtml;

    // Where the server puts it (spec/HtmlTok.agda bootstrapAt): after the
    // first <head> or <body>, else before the first other element.
    return withBootstrap(rewrittenHtml, getBootstrapHtml());
}

// ── Writes that split a construct ───────────────────────────────────────
//
// Each write is tokenized from the data state, so a tag, comment or
// <script> / raw-text element split across writes (write("<scr");
// write("ipt src=…></script>")) was handed to the browser unrewritten. A
// write that ends inside one keeps that tail back and the next write of
// the document is read after it: the browser's parser could not act on an
// unfinished construct before more input came either. What is kept back is
// written when no write follows — at the next microtask (still the writing
// script's turn), or at document.close().
const carried = new SafeWeakMap<object, string>();

/** Writes `text` (the page's, already joined) to `doc` through its native write, rewritten. */
function writeThrough(doc: WriteCapable, nativeWrite: (...a: unknown[]) => unknown, text: string, asTrusted: boolean,
    rewrite: (html: string) => string, realm: object): unknown {
    const all = (carried.get(doc) ?? "") + text;
    carried.delete(doc);
    const tail = { at: -1 };
    tokenize(all, (doc as unknown as Document).defaultView !== null, undefined, tail);
    let now = all;
    if (tail.at >= 0) {
        now = all.slice(0, tail.at);
        carried.set(doc, all.slice(tail.at));
        nqueueMicrotask(() => flushCarried(doc, nativeWrite, rewrite, realm));
    }
    const rewritten = rewrite(now);
    return ncall(nativeWrite, doc, asTrusted ? trusted(realm, "HTML", rewritten) : rewritten);
}

function flushCarried(doc: WriteCapable, nativeWrite: (...a: unknown[]) => unknown, rewrite: (html: string) => string, realm: object): void {
    const rest = carried.get(doc);
    if (rest === undefined) return;
    carried.delete(doc);
    try { ncall(nativeWrite, doc, trusted(realm, "HTML", rewrite(rest))); } catch { /* as the page's own late write would */ }
}

// The flush of each document at close(), registered by its writer.
const flushers = new SafeWeakMap<object, () => void>();

// One pair of writers per document: `document.write === document.write`.
const writers = new SafeWeakMap<object, DocumentWriteWrapper>();
// Documents whose write / writeln the page replaced (through the setter below).
const replaced = new SafeWeakMap<object, Set<string>>();

/** Whether `target[name]` is still the browser's own method. */
function isNativeMethod(target: WriteCapable, name: "write" | "writeln"): boolean {
    return typeof target[name] === "function" && !replaced.get(target)?.has(name);
}

function allStrings(args: unknown[]): boolean {
    for (const a of args) {
        if (sinkText(a) === null) return false;
    }
    return true;
}

/**
 * What `obj.write` / `obj.writeln` (and `obj["write"]`) go through in
 * rewritten code. Anything that is not a Document is returned as it is:
 * the access then reads, calls or assigns the object's own property,
 * exactly as written. For a Document the result stands in for it: reading
 * `write` gives the rewriting writer while the document still has the
 * native method (otherwise whatever the page put there), and assigning
 * `write` assigns on the document.
 */
export function wrapDocumentWrite(
    arg: { obj: unknown },
    rewriteOne: (url: string) => string,
    getBootstrapHtml: (() => string) | null = null,
    proxyOrigin: string = "",
): DocumentWriteWrapper {
    if (!isDocumentLike(arg.obj)) return arg.obj as DocumentWriteWrapper;
    // The native is wrapped where it lives: the document itself does it.
    if (wrappedAtPrototype(arg.obj)) return arg.obj as DocumentWriteWrapper;
    const target = arg.obj;
    let w = writers.get(target);
    if (!w) {
        const make = (name: "write" | "writeln") => (...args: unknown[]): unknown => {
            const native = target[name] as (...a: unknown[]) => unknown;
            if (!allStrings(args)) return napply(native, target, args);
            const joined = args.map((a) => sinkText(a) ?? "").join("") + (name === "writeln" ? "\n" : "");
            const ctx = { scripting: (target as unknown as Document).defaultView !== null };
            const rewrite = (html: string): string => {
                const r = rewriteHtmlString(html, rewriteOne, proxyOrigin, undefined, ctx);
                return getBootstrapHtml ? maybeInjectBootstrap(target, html, r, getBootstrapHtml) : r;
            };
            return writeThrough(target, nativeWriteOf(target), joined, args.some(isTrustedValue), rewrite, globalThis);
        };
        w = { write: make("write"), writeln: make("writeln") };
        writers.set(target, w);
    }
    const writer = w;
    return {
        get write() { return isNativeMethod(target, "write") ? writer.write : target.write!; },
        set write(v) { markReplaced(target, "write"); target.write = v; },
        get writeln() { return isNativeMethod(target, "writeln") ? writer.writeln : target.writeln!; },
        set writeln(v) { markReplaced(target, "writeln"); target.writeln = v; },
    };
}

/** The browser's write for `doc`: its own, unless the page replaced it, then its prototypes'. */
function nativeWriteOf(doc: WriteCapable): (...a: unknown[]) => unknown {
    if (isNativeMethod(doc, "write")) return doc.write as (...a: unknown[]) => unknown;
    for (let p: object | null = nO.getPrototypeOf(doc) as object | null; p; p = nO.getPrototypeOf(p) as object | null) {
        if (ncall(nOP.hasOwnProperty, p, "write")) return (p as Record<string, unknown>)["write"] as (...a: unknown[]) => unknown;
    }
    return doc.write as (...a: unknown[]) => unknown;
}

function markReplaced(target: object, name: string): void {
    let names = replaced.get(target);
    if (!names) replaced.set(target, (names = new SafeSet()));
    names.add(name);
}

// ── The native, at the prototype ────────────────────────────────────────
//
// Rewritten code is not the only caller: `var w = document.write;
// w.call(document, html)` (Google's SafeFrame does exactly this), code that
// arrives unrewritten, and other realms' references all reach
// Document.prototype.write. So it is wrapped there, on the native surface,
// and the source-level helper above passes such calls straight through.

const nativelyWrapped = new SafeWeakSet<object>();

/** Whether `doc`'s write is the wrapped native (its realm has the runtime). */
function wrappedAtPrototype(doc: object): boolean {
    for (let p: object | null = nO.getPrototypeOf(doc) as object | null; p; p = nO.getPrototypeOf(p) as object | null) {
        if (ncall(nOP.hasOwnProperty, p, "write")) return nativelyWrapped.has(p);
    }
    return false;
}

export function patchDocumentWrite(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    bootstrap: () => string,
    proxyOrigin: string,
): void {
    const D = (targetWindow as unknown as { Document?: { prototype: object } }).Document?.prototype;
    if (!D) return;
    let holder: object | null = D;
    while (holder && !ncall(nOP.hasOwnProperty, holder, "write")) holder = nO.getPrototypeOf(holder) as object | null;
    if (!holder || nativelyWrapped.has(holder)) return;
    const nativeWrite = (holder as Record<string, unknown>)["write"] as (...a: unknown[]) => unknown;
    for (const key of ["write", "writeln"]) {
        wrapMethod<(...a: unknown[]) => unknown>(holder, key, (native, self, args) => {
            if (!isDocumentLike(self) || !allStrings(args)) return nR.apply(native, self, args);
            const joined = args.map((a) => sinkText(a) ?? "").join("") + (key === "writeln" ? "\n" : "");
            // Markup for the document's parser, where it stands.
            const ctx = { scripting: (self as unknown as Document).defaultView !== null };
            const rewrite = (html: string): string =>
                maybeInjectBootstrap(self, html, rewriteHtmlString(html, rewriteOne, proxyOrigin, bootstrap, ctx), bootstrap);
            if (!flushers.has(self)) flushers.set(self, () => flushCarried(self, nativeWrite, rewrite, targetWindow));
            const out = writeThrough(self, nativeWrite, joined, args.some(isTrustedValue), rewrite, targetWindow);
            // Frames the written markup made: the page may write into them next.
            if (/<iframe/i.test(joined)) injectFramesIn(targetWindow, self);
            return out;
        });
    }
    // close() ends the input: what a split write kept back goes first.
    if (ncall(nOP.hasOwnProperty, holder, "close")) {
        wrapMethod<(...a: unknown[]) => unknown>(holder, "close", (native, self, args) => {
            if (typeof self === "object" && self !== null) flushers.get(self)?.();
            return nR.apply(native, self, args);
        });
    }
    nativelyWrapped.add(holder);
}
