// Client-side JavaScript rewriter — the same rules the server applies
// (go/src/internal/jsrewrite), on source the server never sees: eval, new
// Function bodies, scripts inserted as markup, Blob workers.
//
// The script is not re-printed. Each rule is a small edit at a position
// acorn gives, spliced into the page's own text and marked so it can be
// taken out again (js/marks.ts): outside the edits every byte is the
// page's, and `original()` of the result is the source as written.
//
// The rules (R1…R10 below, in `Splicer`) are the contract shared with the
// Go rewriter; the two are compared edit for edit on a corpus of real
// scripts (tests/js/splice-corpus, go …/splice_conformance_test.go).
//
// Failure policy: a script that does not parse is returned unchanged, as
// is one already rewritten (it carries `$rewriter.wrap_`).

import { SafeMap, SafeWeakSet, nO, sIncludes } from "../native/intrinsics";
import { Parser } from "acorn";
import { isUrlLikeSpecifier } from "../url/containment";
import { canMark, fragment } from "./marks";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { type: string; start: number; end: number } & Record<string, any>;

export interface JsRewriteOptions {
    wrapGetLocation: boolean;
    wrapSetLocation: boolean;
    wrapLocation: boolean;
    wrapGetTopWindow: boolean;
    wrapTopWindow: boolean;
    wrapGetParentWindow: boolean;
    wrapParentWindow: boolean;
    wrapDocumentWrite: boolean;
    wrapPostMessage: boolean;
    wrapEval: boolean;
    wrapEvalArg: boolean;
    wrapEvalMemexp: boolean;
    wrapMemberExpression: boolean;
    wrapImportArg: boolean;
    wrapNewWorker: boolean;
    /** R14: an object pattern's source that may give location / top / parent. */
    wrapPattern: boolean;
    /** R12: `debugger` statements become empty statements. */
    stripDebugger: boolean;
    /**
     * The source is a Function constructor's body: its `var`s stay in its
     * own scope, so the runtime holder (_crn$g) may be declared there. Never
     * in global code, where a `var` becomes a property of the window — and
     * a sandbox's with object claims every name the window has.
     */
    functionBody?: boolean;
    /**
     * The code runs as a script of a global that holds the runtime (a blob:
     * worker the runtime made, whose preamble set it up): no eval preamble,
     * which would shift every column of its first line.
     */
    globalScript?: boolean;
    /** With `proxify`: import/export specifiers and literal import() are proxified in place. */
    wrapStaticImport: boolean;
    /** With `baseUrl`: import.meta.url becomes that URL as a string literal. */
    wrapImportMetaUrl: boolean;
    /** R15: import.meta.resolve is the runtime's (resolves as import() does, gives the original URL). */
    wrapImportMetaResolve: boolean;
    /** The script's own URL (module specifiers resolve against it). */
    baseUrl?: string;
    /** Proxifies a module specifier; returns it unchanged to leave it (a bare specifier). */
    proxify?: (specifier: string, baseUrl: string) => string;
}

/** Mirrors the server's DefaultOptions — every rule we kept after cleanup. */
export function defaultJsRewriteOptions(): JsRewriteOptions {
    return {
        wrapGetLocation: true,
        wrapSetLocation: true,
        wrapLocation: true,
        wrapGetTopWindow: true,
        wrapTopWindow: true,
        wrapGetParentWindow: true,
        wrapParentWindow: true,
        wrapDocumentWrite: true,
        wrapPostMessage: true,
        wrapEval: true,
        wrapEvalArg: true,
        wrapEvalMemexp: true,
        wrapMemberExpression: true,
        wrapImportArg: true,
        wrapNewWorker: true,
        wrapPattern: true,
        stripDebugger: true,
        wrapStaticImport: true,
        wrapImportMetaUrl: true,
        wrapImportMetaResolve: true,
    };
}

/** Cheap check: input that already calls into our runtime should not be re-wrapped. */
function alreadyRewritten(src: string): boolean {
    return sIncludes(src, "$rewriter.wrap_") || sIncludes(src, "$rewriter_init(");
}

/**
 * Preamble injected before eval'd code that references $rewriter.* or uses
 * $__crn_key__. Makes both available even in sandboxed execution contexts
 * (e.g. GTM custom-template sandbox) where the global object may differ from
 * the main window. Inserted after a leading "use strict" directive if present
 * so strict mode is preserved.
 *
 * The $rewriter fallback walks up the frame tree — ad iframes written via
 * document.write don't have the bootstrap injected into their window, so
 * window.$rewriter is undefined. All proxied frames share the same proxy
 * origin, so parent frame access is always same-origin safe.
 */
// globalThis, not window: the same source also runs in workers (Blob
// workers' rewritten source), where there is no window — and a page's own
// `var self` cannot shadow it. A worker has no parent: the walk stops.
// The global object is found without trusting the name `globalThis`: a
// sandbox that compiles page code can shadow it (Salesforce's Lightning
// Locker passes it as undefined — "Cannot read properties of undefined
// (reading '$rewriter')", and help.twitch.tv rendered Aura's error box).
// Then (or when the one it names holds no runtime: a sandbox's window) a
// sloppy function's `this` (strict code: the realm's Function).
const EVAL_GLOBAL =
    '(function(){var _g;try{_g=typeof globalThis!=="undefined"?globalThis:void 0;if(_g&&_g.$rewriter)return _g}catch(_e){}' +
    'try{var _r=(function(){return this})()||(function(){}).constructor("return this")();if(_r)return _r}catch(_e){}return _g||{}})()';
// An enclosing compiled scope's holder (_crn$g, below) is taken first: a
// sandbox that direct-evals page code inside its own `with` (Salesforce's
// Locker) leaves no other way to the runtime — its with object claims every
// name the window has, and its lockdown makes Function("return this") give
// nothing — but a name the window lacks passes through to the enclosing
// scope. Code that declares the holder itself does not see the outer one
// (hoisting) and searches the global, which outside a `with` it reaches.
const EVAL_PREAMBLE =
    'var $rewriter=(typeof _crn$g!=="undefined"&&_crn$g&&_crn$g.$rewriter)||(function(_g){if(_g.$rewriter)return _g.$rewriter;' +
    'try{for(var _w=_g;_w.parent&&_w!==_w.parent;_w=_w.parent)' +
    'if(_w.parent.$rewriter)return _w.parent.$rewriter;}' +
    'catch(_e){}return null})(' + EVAL_GLOBAL + '),' +
    '$__crn_key__=' + EVAL_GLOBAL + '.$__crn_key__||0;';

/** Where the preamble goes: after a leading "use strict" directive, which must stay first. */
function preambleOffset(code: string): number {
    const m = /^\s*(['"])use strict\1[ \t]*;?/.exec(code);
    return m ? m[0].length : 0;
}

/** The preamble as a marked insertion: it adds no line, and `original` removes it. */
// A Function body with R13 sites (a `with` body) holds the runtime and the
// R5 key under _crn$g, a name no window has (it is never declared in global
// code) and, `_`-prefixed, none Vue's with object claims: its R13 sites —
// and code direct-eval'd in its scope — reach the runtime through it where
// the global object is out of reach (Salesforce's Locker evaluator:
// `with (sandbox) { … eval(src) }`, compiled with the realm's Function).
const WITH_HOLDER = 'var _crn$g={$rewriter:$rewriter,$__crn_key__:$__crn_key__};';

function withEvalPreamble(code: string, functionBody: boolean): string {
    const at = preambleOffset(code);
    const pre = EVAL_PREAMBLE + (functionBody && sIncludes(code, "_crn$g") ? WITH_HOLDER : "");
    return code.slice(0, at) + fragment(pre, "") + code.slice(at);
}

/**
 * Parses src as JS, applies enabled rules, and returns the rewritten source.
 * Returns src unchanged on parse failure, matching the server's
 * "fail open — never break a page we can't safely transform" policy.
 *
 * When the output references $rewriter.* (either from fresh rewriting or
 * because the input was already server-rewritten), an eval-preamble is
 * prepended that makes $rewriter and $__crn_key__ accessible in sandboxed
 * eval contexts.
 */
export function rewriteJsSource(src: string, opts: JsRewriteOptions): string {
    if (typeof src !== "string" || src.length === 0) return src;
    // Nothing a rule could touch: not parsed at all (mayEdit).
    if (!mayEdit(src)) return src;
    // A source compiled again is not parsed again: natively a repeated
    // eval / new Function of the same text is all but free (V8 keeps the
    // compiled code), and a page may lean on that — Cloudflare's Turnstile
    // compiles its own 1.3 MB source fifteen times in a row.
    const memo = memoFor(opts);
    if (memo && src.length >= MEMO_MIN) {
        const hit = memo.get(src);
        if (hit !== undefined) return hit;
        const out = rewriteJsSourceUncached(src, opts);
        remember(memo, src, out);
        return out;
    }
    return rewriteJsSourceUncached(src, opts);
}

/**
 * Whether any rule could edit `src`: every rule needs one of these in the
 * text — a `[` (R5, R14, a constant key), one of the names the rules know
 * (R1–R4, R6: location, top, parent, eval, write/writeln, postMessage;
 * R7–R9, R15: import, export; R10: Worker; R12: debugger), or a backslash
 * (an escape can spell any of them). A source with none is the same
 * rewritten, and is given back unparsed, as the browser all but does:
 * Cloudflare's Turnstile times an eval of 1.3 MB of spaces around
 * a regular expression and the time, twice a second — natively under a millisecond,
 * through the parser 80 ms each (techcrunch.com froze, and the timing
 * tells). The Go recognizer has the same exit (jsrewrite.mayEdit); a new
 * rule adds its needle to both (tests/js/may-edit.test.ts holds every
 * shared case to it).
 */
export function mayEdit(src: string): boolean {
    for (let i = 0; i < NEEDLES.length; i++) if (sIncludes(src, NEEDLES[i]!)) return true;
    return false;
}
const NEEDLES = ["[", "\\", "location", "top", "parent", "eval", "write", "postMessage", "import", "export", "Worker", "debugger"];

// Sources below this are cheaper to parse than to keep.
const MEMO_MIN = 4096;
// What the memo may hold, in source characters, over all option sets.
const MEMO_MAX_CHARS = 8 * 1024 * 1024;
const memos = new SafeMap<string, Map<string, string>>();
let memoChars = 0;

/** The memo for these options, or null when the result depends on more than the text (a module's specifiers). */
function memoFor(opts: JsRewriteOptions): Map<string, string> | null {
    if (opts.proxify !== undefined || opts.baseUrl !== undefined) return null;
    let key = "";
    const names = nO.keys(opts); // every caller builds them the same way: one order
    for (let i = 0; i < names.length; i++) key += names[i] + ((opts as unknown as Record<string, unknown>)[names[i]!] === true ? "+" : "-");
    let m = memos.get(key);
    if (!m) { m = new SafeMap<string, string>(); memos.set(key, m); }
    return m;
}

function remember(memo: Map<string, string>, src: string, out: string): void {
    if (src.length > MEMO_MAX_CHARS / 2) return;
    memoChars += src.length;
    memo.set(src, out);
    // Over the limit: the oldest go first (a Map keeps insertion order).
    for (const m of memos.values()) {
        if (memoChars <= MEMO_MAX_CHARS) break;
        for (const k of m.keys()) {
            if (memoChars <= MEMO_MAX_CHARS || k === src) break;
            m.delete(k);
            memoChars -= k.length;
        }
    }
}

function rewriteJsSourceUncached(src: string, opts: JsRewriteOptions): string {
    let result: string;
    if (alreadyRewritten(src)) {
        result = src; // don't double-rewrite
    } else {
        const edits = jsEdits(src, opts);
        if (edits === null) return src; // does not parse
        result = applyEdits(src, edits);
    }

    // The preamble goes wherever the code references our runtime — freshly
    // rewritten or already rewritten by the server.
    if (opts.globalScript !== true && (sIncludes(result, "$rewriter.") || sIncludes(result, "$__crn_key__"))) {
        return withEvalPreamble(result, opts.functionBody === true);
    }
    return result;
}

/**
 * An event handler attribute's value (spec/Attrs.agda handler): a function
 * body the browser compiles where the global object is in scope, rewritten
 * by the rules as the server rewrites it — without the eval preamble (Go's
 * htmlrewrite gives handlers its inline-script rewrite, which has none).
 */
export function rewriteHandlerSource(src: string): string {
    if (typeof src !== "string" || src.length === 0 || !mayEdit(src) || alreadyRewritten(src)) return src;
    const edits = jsEdits(src, defaultJsRewriteOptions());
    return edits === null ? src : applyEdits(src, edits);
}

// ── Edits ────────────────────────────────────────────────────────────────

/** Where an edit sits among others at the same offset: closers, then openers, then replacements. */
const enum Kind { Close = 0, Open = 1, Replace = 2 }

export interface Edit {
    /** Offset in the source (UTF-16 code units here; bytes in Go — compared after conversion). */
    pos: number;
    /** Length of source text replaced (0: an insertion). */
    del: number;
    ins: string;
    kind: Kind;
    seq: number;
}

/** The edits for `src`, in application order, or null when it does not parse. */
export function jsEdits(src: string, opts: JsRewriteOptions): Edit[] | null {
    let ast: N;
    try {
        ast = Parser.parse(src, {
            ecmaVersion: "latest",
            sourceType: "script",
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true,
            allowImportExportEverywhere: true,
            allowSuperOutsideMethod: true,
            allowHashBang: true,
            // Parentheses are part of an operand's extent: `(a, b).top` wraps `(a, b)`.
            preserveParens: true,
        }) as unknown as N;
    } catch {
        return null;
    }
    const s = new Splicer(src, opts);
    s.visit(ast, "expr", false);
    // At one offset: inner closers first (in the order made), then openers
    // outermost first (the reverse of the order made), then replacements.
    return s.edits.sort((a, b) =>
        a.pos - b.pos || a.kind - b.kind || (a.kind === Kind.Open ? b.seq - a.seq : a.seq - b.seq));
}

const IDENT_PART = /^[A-Za-z0-9_$\u0080-\uffff]$/;

/** `src` with `edits` (sorted) spliced in, each as a marked fragment. */
export function applyEdits(src: string, edits: Edit[]): string {
    if (edits.length === 0) return src;
    const marked = canMark(src);
    let out = "";
    let at = 0;
    for (let i = 0; i < edits.length; ) {
        const e = edits[i]!;
        // Insertions at one offset go into one fragment.
        let ins = e.ins;
        let j = i + 1;
        if (e.del === 0) {
            while (j < edits.length && edits[j]!.pos === e.pos && edits[j]!.del === 0) ins += edits[j++]!.ins;
        }
        out += src.slice(at, e.pos);
        if (marked) {
            out += fragment(ins, src.slice(e.pos, e.pos + e.del), e.pos > at && src.charCodeAt(e.pos - 1) === 0x2f);
        } else {
            // No marker comment to separate tokens: `return[a][k]` must not
            // become `return$rewriter…`.
            if (IDENT_PART.test(out.slice(-1)) && IDENT_PART.test(ins.charAt(0))) out += " ";
            out += ins;
        }
        at = e.pos + e.del;
        i = j;
    }
    return out + src.slice(at);
}

type Ctx =
    | "expr"      // read
    | "target"    // assigned with `=`, or a for-in/of target
    | "modify"    // compound assignment, ++/--, typeof, delete: left as written
    | "binding";  // a declaration

const SET_LOCATION = "$rewriter.wrap_set_location(location, function(v){location=v;}).value";

/**
 * R13: the global object, whatever names a with object claims. A sloppy
 * function's `this`; in a strict function nested in the with (where `this`
 * is undefined) `globalThis` when it holds the runtime — a function compiled
 * from "return this", reached from a literal's constructor, only past that:
 * it is an eval, refused under a CSP without 'unsafe-eval' (the Facebook
 * SDK's strict modules inside a with, in Disqus frames: armorgames.com).
 */
const WITH_GLOBAL = '((typeof _crn$g!=="undefined"&&_crn$g)||(function(){return this})()||(typeof globalThis!=="undefined"&&globalThis&&globalThis.$rewriter&&globalThis)||(function(){}).constructor("return this")()).';
/** R13: the holder an outermost with's block declares (its sites take it first). */
const WITH_BLOCK = "{let _crn$g={$rewriter:$rewriter,$__crn_key__:$__crn_key__};";
function inWith(ins: string): string {
    return ins.replace(/\$rewriter\./g, WITH_GLOBAL + "$rewriter.").replace(/\$__crn_key__/g, WITH_GLOBAL + "$__crn_key__");
}

function unparen(n: N): N {
    while (n.type === "ParenthesizedExpression") n = n["expression"] as N;
    return n;
}
function last(xs: N[]): N { return xs[xs.length - 1]!; }
function isEvalName(n: N): boolean { return n.type === "Identifier" && n["name"] === "eval"; }
/** eval, or X.eval / X["eval"] with X a name or this (read again by the wrapper: no side effects). */
function evalReference(n: N): boolean {
    if (isEvalName(n)) return true;
    if (n.type !== "MemberExpression" || n["optional"]) return false;
    const o = n["object"] as N, p = n["property"] as N;
    const named = !n["computed"] ? p.type === "Identifier" && p["name"] === "eval"
        : (p.type === "Literal" && p["value"] === "eval") ||
          (p.type === "TemplateLiteral" && (p["expressions"] as N[]).length === 0 && ((p["quasis"] as N[])[0]!["value"] as { cooked?: string }).cooked === "eval");
    return named && (o.type === "Identifier" || o.type === "ThisExpression");
}

/** R1: a bare identifier read → the helper its value goes through. */
function identHelper(name: string, o: JsRewriteOptions): string | null {
    switch (name) {
        case "location": return o.wrapGetLocation ? "wrap_get_location" : null;
        case "top": return o.wrapGetTopWindow ? "wrap_get_top_window" : null;
        case "parent": return o.wrapGetParentWindow ? "wrap_get_top_window" : null;
    }
    return null;
}

/** R3: `X.name` → the helper X goes through. write/writeln/postMessage only where called. */
function memberHelper(name: string, called: boolean, o: JsRewriteOptions): string | null {
    switch (name) {
        case "location": return o.wrapLocation ? "wrap_location" : null;
        case "top": return o.wrapTopWindow ? "wrap_top_window" : null;
        case "parent": return o.wrapParentWindow ? "wrap_parent_window" : null;
        case "write":
        case "writeln": return called && o.wrapDocumentWrite ? "wrap_document_write" : null;
        // The calling window's runtime learns that it is the sender
        // (messaging/target-origin.ts markSender).
        case "postMessage": return called && o.wrapPostMessage ? "wrap_postMessage" : null;
    }
    return null;
}

/**
 * Walks the tree once and records the edits. The rules:
 *
 *  R1  a bare `location` / `top` / `parent` / `eval` that is read
 *        →  $rewriter.<h>(<id>)            (shorthand {id} → {id:$rewriter.<h>(id)})
 *      not: the callee of a direct eval call, an operand of typeof/delete,
 *      a compound-assignment or ++/-- target, a declaration, a label, a key.
 *  R2  `location` assigned with `=` (or as a for-in/of target)
 *        →  $rewriter.wrap_set_location(location, function(v){location=v;}).value
 *  R3  X.location / X.top / X.parent, and X.write / X.writeln / X.postMessage where called
 *        →  $rewriter.<h>({obj:X}).name
 *      not: X.top / X.parent followed by a plain `=` (a write: as written)
 *      in an optional chain →  $rewriter.<h>({obj:X,opt:1})?.name
 *      (also X["location"] and the like: a constant key is a name)
 *  R4  X.eval called  →  $rewriter.wrap_eval_memexp(X).eval   (not in an optional chain)
 *  R5  X[k], k not a constant, not in an optional chain, not followed by a plain `=`,
 *      k not certainly a number (parentheses aside: a unary - + ~, a ++ / --,
 *      a binary arithmetic or bitwise operation other than +) — such a key
 *      names no member the rules know, and an interpreter's hot loop is
 *      made of them (Cloudflare's Turnstile ran three times slower)
 *        →  $rewriter.wrap_member_expression(X,$__crn_key__=(k))[$__crn_key__]
 *      (a write stays as written: `obj[k] = function(){}` is named by V8
 *      from its target, and `window[k] = url` is caught by the runtime's
 *      navigation net)
 *  R18 X[n], n a number literal or certainly a number, X plainly a window
 *      (frames, window, self, top, parent, globalThis, opener, or Y.<one of
 *      those but globalThis>), not in an optional chain, not written: R5's
 *      form — the browser gives the real child frame, the runtime its view
 *  R6  eval(a, …) called directly (also (eval)(a))  →  eval($rewriter.wrap_eval_arg(eval,a), …)
 *  R16 F.call(t, a, …) / F.apply(t, arr), F the name eval or X.eval (X a name
 *      or this)  →  F.call(t, $rewriter.wrap_eval_arg(F,a), …) / F.apply(t, $rewriter.wrap_eval_args(F,arr))
 *  R17 (…, eval)(a, …)  →  (…, eval)($rewriter.wrap_eval_arg(eval,a), …)
 *      A read of eval (R1) or of X.eval not called (R4) is left as written:
 *      it gives eval itself, so a later `eval(s)` stays direct. The runtime's
 *      wrap_eval_arg rewrites only when F is an evaluator (spec/Eval.agda:
 *      passthrough). A call of eval under another name is not rewritten.
 *  R7  import(s)  →  $rewriter.wrap_import_result(import($rewriter.wrap_import_arg(s,"<script URL>")))
 *      (a literal s, when it can be proxified now, is replaced instead)
 *  R8  import … from "s" / export … from "s"  →  the specifier proxified
 *  R9  import.meta.url  →  "<script URL>"
 *  R15 import.meta.resolve  →  $rewriter.wrap_meta_resolve(import.meta)
 *      (not as the target of =, op= or a postfix ++/--)
 *  R10 new Worker(u) / new SharedWorker(u)  →  new Worker($rewriter.wrap_worker_url(u))
 *  R11 new C…, where C now starts with a call  →  new (C)…
 *  R12 debugger;  →  ;     (a no-op unless DevTools is open, where scripts
 *      use it to detect and stall an inspector)
 *  R14 an object pattern assigned or declared from S, whose own keys name
 *      location / top / parent (or are computed)  →  … = $rewriter.wrap_pattern(S)
 *      (not: a parameter's pattern, a pattern nested in another, a for-in/of target)
 *  R13 inside a `with` body, the edits reach the runtime through the global
 *      object, not by name: `$rewriter` → `((function(){return this})()||…).$rewriter`,
 *      and so `$__crn_key__` — a with object may claim every name (Vue's
 *      compiled templates run in `with(_ctx)`, whose Proxy does)
 *
 * `super` is never wrapped. Nothing else in the script changes.
 */
class Splicer {
    readonly edits: Edit[] = [];
    private seq = 0;
    /** Targets of `=`, `op=` and postfix `++` / `--` (R15 leaves them). */
    private readonly assigned = new SafeWeakSet<object>();
    /** Nodes an edit now wraps in a call (for R11). */
    private readonly wrapped = new SafeWeakSet<object>();

    constructor(private readonly src: string, private readonly o: JsRewriteOptions) {}

    /** Inside a `with` body: the runtime's names would resolve through its object (R13). */
    private withDepth = 0;

    private open(pos: number, ins: string): void { this.edits.push({ pos, del: 0, ins: this.rt(ins), kind: Kind.Open, seq: this.seq++ }); }
    private close(pos: number, ins: string): void { this.edits.push({ pos, del: 0, ins: this.rt(ins), kind: Kind.Close, seq: this.seq++ }); }
    private replace(pos: number, del: number, ins: string): void { this.edits.push({ pos, del, ins: this.rt(ins), kind: Kind.Replace, seq: this.seq++ }); }
    private rt(ins: string): string { return this.withDepth > 0 ? inWith(ins) : ins; }

    private all(nodes: Array<N | null> | undefined, ctx: Ctx): void {
        if (nodes) for (const n of nodes) if (n) this.visit(n, ctx, false);
    }

    visit(n: N | null | undefined, ctx: Ctx, called: boolean): void {
        if (!n || typeof n.type !== "string") return;
        switch (n.type) {
            case "Identifier":
                if (ctx === "expr") {
                    const h = identHelper(n["name"], this.o);
                    if (h) this.wrapCall(n, h);
                } else if (ctx === "target" && n["name"] === "location" && this.o.wrapSetLocation) {
                    this.replace(n.start, n.end - n.start, SET_LOCATION);
                }
                return;

            case "MemberExpression":
                this.member(n, called);
                return;

            case "ChainExpression":
            case "ParenthesizedExpression":
                this.visit(n["expression"], ctx, called && n.type === "ChainExpression");
                return;

            case "CallExpression": {
                const callee = n["callee"] as N;
                const args = n["arguments"] as N[];
                const a0 = args[0];
                const bare = unparen(callee);
                if (this.o.wrapEvalArg && !n["optional"] && a0 && a0.type !== "SpreadElement" &&
                    (isEvalName(bare) || (bare.type === "SequenceExpression" && isEvalName(unparen(last(bare["expressions"] as N[])))))) {
                    // R6 eval(a) — (eval)(a) too: direct; R17 (…, eval)(a): indirect.
                    if (bare !== callee || bare.type === "SequenceExpression") this.visit(callee, "expr", true);
                    this.visit(a0, "expr", false);
                    this.open(a0.start, "$rewriter.wrap_eval_arg(eval,");
                    this.close(a0.end, ")");
                    this.all(args.slice(1), "expr");
                    return;
                }
                // R16 F.call(t, a, …) / F.apply(t, arr), F eval or X.eval (X a name or this).
                if (this.o.wrapEvalArg && !n["optional"] && callee.type === "MemberExpression" && !callee["optional"] && !callee["computed"]) {
                    const method = (callee["property"] as N)["name"];
                    const f = callee["object"] as N; // as written: no parentheses looked through
                    const arg = args[1];
                    if ((method === "call" || method === "apply") && arg && arg.type !== "SpreadElement" && evalReference(f)) {
                        this.visit(callee, "expr", true);
                        this.visit(args[0], "expr", false);
                        this.visit(arg, "expr", false);
                        this.open(arg.start, "$rewriter." + (method === "call" ? "wrap_eval_arg(" : "wrap_eval_args(") + this.src.slice(f.start, f.end) + ",");
                        this.close(arg.end, ")");
                        this.all(args.slice(2), "expr");
                        return;
                    }
                }
                if (callee.type !== "Super") this.visit(callee, "expr", true);
                this.all(args, "expr");
                return;
            }

            case "NewExpression": {
                const callee = n["callee"] as N;
                const args = n["arguments"] as N[];
                this.visit(callee, "expr", false);
                if (this.startsWithCall(callee)) { // R11
                    this.open(callee.start, "(");
                    this.close(callee.end, ")");
                }
                const a0 = args[0];
                if (this.o.wrapNewWorker && callee.type === "Identifier" && a0 && a0.type !== "SpreadElement" &&
                    (callee["name"] === "Worker" || callee["name"] === "SharedWorker")) {
                    this.visit(a0, "expr", false); // R10
                    this.open(a0.start, "$rewriter.wrap_worker_url(");
                    this.close(a0.end, ")");
                    this.all(args.slice(1), "expr");
                    return;
                }
                this.all(args, "expr");
                return;
            }

            case "ImportExpression": { // R7
                const s = n["source"] as N;
                // A literal bare specifier ("react") is the import map's: left as written.
                const bare = s.type === "Literal" && typeof s["value"] === "string" && !isUrlLikeSpecifier(s["value"]);
                if (!bare && !(this.o.wrapStaticImport && this.specifier(s)) && this.o.wrapImportArg) {
                    this.visit(s, "expr", false);
                    this.open(s.start, "$rewriter.wrap_import_arg(");
                    this.close(s.end, this.o.baseUrl ? "," + JSON.stringify(this.o.baseUrl) + ")" : ")");
                }
                this.visit(n["options"], "expr", false);
                // Its rejection names the page's URL, as natively (the browser
                // was asked for the proxified one).
                if (this.o.wrapImportArg) {
                    this.open(n.start, "$rewriter.wrap_import_result(");
                    this.close(n.end, ")");
                }
                return;
            }

            case "ImportDeclaration":
            case "ExportAllDeclaration":
            case "ExportNamedDeclaration": // R8
                if (n["source"] && this.o.wrapStaticImport) this.specifier(n["source"]);
                this.visit(n["declaration"], "expr", false);
                return; // specifiers name bindings and exports: not reads

            case "AssignmentExpression":
                this.assigned.add(n["left"] as N);
                this.visit(n["left"], n["operator"] === "=" ? "target" : "modify", false);
                this.visit(n["right"], "expr", false);
                if (n["operator"] === "=") this.wrapPatternSource(n["left"] as N, n["right"] as N);
                return;

            case "UpdateExpression":
                if (!n["prefix"]) this.assigned.add(n["argument"] as N);
                this.visit(n["argument"], "modify", false);
                return;

            case "UnaryExpression":
                this.visit(n["argument"], n["operator"] === "typeof" || n["operator"] === "delete" ? "modify" : "expr", false);
                return;

            case "VariableDeclarator":
                this.visit(n["id"], "binding", false);
                this.visit(n["init"], "expr", false);
                if (n["init"]) this.wrapPatternSource(n["id"] as N, n["init"] as N);
                return;

            case "FunctionDeclaration":
            case "FunctionExpression":
            case "ArrowFunctionExpression":
                this.all(n["params"], "binding"); // the name (id) is not a read
                this.visit(n["body"], "expr", false);
                return;

            case "ClassDeclaration":
            case "ClassExpression":
                this.visit(n["superClass"], "expr", false);
                this.all((n["body"] as N)["body"], "expr");
                return;

            case "MethodDefinition":
            case "PropertyDefinition":
            case "AccessorProperty":
                if (n["computed"]) this.visit(n["key"], "expr", false);
                this.visit(n["value"], "expr", false);
                return;

            case "Property": {
                const value = n["value"] as N;
                if (n["shorthand"]) {
                    // {id}: the key stays, the value goes through the helper.
                    const id = value.type === "AssignmentPattern" ? (value["left"] as N) : value;
                    const name = id["name"] as string;
                    if (ctx === "expr") {
                        const h = identHelper(name, this.o);
                        if (h) {
                            this.open(id.start, name + ":$rewriter." + h + "(");
                            this.close(id.end, ")");
                        }
                    } else if (ctx === "target" && name === "location" && this.o.wrapSetLocation) {
                        this.replace(id.start, id.end - id.start, "location:" + SET_LOCATION);
                    }
                    if (value.type === "AssignmentPattern") this.visit(value["right"], "expr", false);
                    return;
                }
                if (n["computed"]) this.visit(n["key"], "expr", false);
                this.visit(value, ctx, false);
                return;
            }

            case "ObjectPattern":
                this.all(n["properties"], ctx);
                return;
            case "ArrayPattern":
                this.all(n["elements"], ctx);
                return;
            case "RestElement":
                this.visit(n["argument"], ctx, false);
                return;
            case "AssignmentPattern":
                this.visit(n["left"], ctx, false);
                this.visit(n["right"], "expr", false);
                return;

            case "ForInStatement":
            case "ForOfStatement": {
                const left = n["left"] as N;
                this.visit(left, left.type === "VariableDeclaration" ? "expr" : "target", false);
                this.visit(n["right"], "expr", false);
                this.visit(n["body"], "expr", false);
                return;
            }

            case "CatchClause":
                this.visit(n["param"], "binding", false);
                this.visit(n["body"], "expr", false);
                return;

            case "LabeledStatement":
                this.visit(n["body"], "expr", false);
                return;

            case "TaggedTemplateExpression":
                this.visit(n["tag"], "expr", false);
                this.visit(n["quasi"], "expr", false);
                return;

            // Leaves, and names that are not reads.
            case "BreakStatement":
            case "ContinueStatement":
            case "MetaProperty":
            case "Super":
            case "ThisExpression":
            case "Literal":
            case "TemplateElement":
            case "PrivateIdentifier":
            case "EmptyStatement":
                return;

            case "WithStatement": { // R13
                this.visit(n["object"] as N, "expr", false);
                const e0 = this.edits.length;
                this.withDepth++;
                this.visit(n["body"] as N, "expr", false);
                this.withDepth--;
                // The outermost with whose body reaches the runtime gets the
                // holder, in a block of its own, made outside the with (where
                // $rewriter is reachable): its R13 sites find it first, so
                // none compiles "return this" (refused without 'unsafe-eval';
                // a compile per evaluation otherwise — the Facebook SDK's
                // strict modules in its with: kosho.or.jp).
                let reaches = false;
                for (let i = e0; i < this.edits.length && !reaches; i++) reaches = sIncludes(this.edits[i]!.ins, "_crn$g");
                if (this.withDepth === 0 && reaches) {
                    this.open(n.start, WITH_BLOCK);
                    this.close(n.end, "}");
                }
                return;
            }

            case "DebuggerStatement": // R12
                if (this.o.stripDebugger) this.replace(n.start, n.end - n.start, ";");
                return;
        }
        // Everything else holds only statements and expressions that are read.
        for (const key in n) {
            if (key === "type" || key === "start" || key === "end") continue;
            const v = n[key] as unknown;
            if (Array.isArray(v)) this.all(v as N[], "expr");
            else if (v && typeof v === "object" && typeof (v as N).type === "string") this.visit(v as N, "expr", false);
        }
    }

    /** R14: the source of an object pattern that may read location / top / parent. */
    private wrapPatternSource(pattern: N, source: N): void {
        if (!this.o.wrapPattern || pattern.type !== "ObjectPattern") return;
        const reads = ((pattern["properties"] as N[]) ?? []).some((p) => {
            if (p.type !== "Property") return false;
            if (p["computed"]) return true;
            const k = p["key"] as N;
            const name = k.type === "Identifier" ? k["name"] : k.type === "Literal" ? String(k["value"]) : "";
            return name === "location" || name === "top" || name === "parent";
        });
        if (!reads) return;
        this.open(source.start, "$rewriter.wrap_pattern(");
        this.close(source.end, ")");
    }

    /** R1: `$rewriter.<h>(` id `)`. */
    private wrapCall(id: N, helper: string): void {
        this.open(id.start, "$rewriter." + helper + "(");
        this.close(id.end, ")");
        this.wrapped.add(id);
    }

    /** R8 / literal R7: a string-literal specifier proxified in place. False when left alone. */
    private specifier(s: N): boolean {
        const { baseUrl, proxify } = this.o;
        if (!baseUrl || !proxify || s.type !== "Literal" || typeof s["value"] !== "string" || !isUrlLikeSpecifier(s["value"])) return false;
        const to = proxify(s["value"], baseUrl);
        if (to === s["value"]) return false;
        this.replace(s.start, s.end - s.start, JSON.stringify(to));
        return true;
    }

    private member(m: N, called: boolean): void {
        const obj = m["object"] as N;
        const prop = m["property"] as N;
        const computed = m["computed"] as boolean;
        if (obj.type === "Super") {
            if (computed) this.visit(prop, "expr", false);
            return;
        }
        // R9
        if (!computed && obj.type === "MetaProperty" && prop["name"] === "url" && this.o.wrapImportMetaUrl && this.o.baseUrl &&
            (obj["meta"] as N)["name"] === "import") {
            this.replace(m.start, m.end - m.start, JSON.stringify(this.o.baseUrl));
            return;
        }
        // R15
        if (!computed && obj.type === "MetaProperty" && prop["name"] === "resolve" && this.o.wrapImportMetaResolve &&
            (obj["meta"] as N)["name"] === "import" && !this.assigned.has(m)) {
            this.replace(m.start, m.end - m.start, "$rewriter.wrap_meta_resolve(import.meta)");
            this.wrapped.add(m);
            return;
        }
        this.visit(obj, "expr", false);
        if (computed) this.visit(prop, "expr", false);

        // A constant key is a name; `undefined` here means the key is computed at run time.
        let name: string | undefined;
        if (!computed) name = prop.type === "Identifier" ? (prop["name"] as string) : "#";
        else if (prop.type === "Literal") name = typeof prop["value"] === "string" ? (prop["value"] as string) : "#";
        else if (prop.type === "TemplateLiteral" && (prop["expressions"] as N[]).length === 0) {
            name = ((prop["quasis"] as N[])[0]!["value"] as { cooked?: string }).cooked ?? "#";
        }
        const inChain = Boolean(m["optional"]) || optionalBelow(obj);

        // The target of a plain `=` (the next token; a parenthesized target
        // is not told) is written, not read: X.top / X.parent and X[k] stay
        // as they are — a function assigned there keeps the name V8 infers
        // from its target, and `window[k] = url` navigates through the
        // runtime's navigation net (spec/Route.agda netDestination).
        const written = this.plainAssignFollows(m.end);
        const helper = name === undefined || (written && (name === "top" || name === "parent")) ? null : memberHelper(name, called, this.o);
        if (helper) { // R3
            this.open(obj.start, "$rewriter." + helper + "({obj:");
            this.close(obj.end, inChain ? ",opt:1})" : "})");
            if (inChain && !m["optional"]) {
                // `?.` must be one token: the `.` is replaced, not prefixed.
                const at = skipTrivia(this.src, obj.end);
                if (computed) this.replace(at, 0, "?.");
                else this.replace(at, 1, "?.");
            }
            this.wrapped.add(m);
            return;
        }
        if (name === "eval" && called && this.o.wrapEvalMemexp && !inChain) { // R4 (a call; a read gives eval itself: spec/Eval.agda)
            this.open(obj.start, "$rewriter.wrap_eval_memexp(");
            this.close(obj.end, ")");
            this.wrapped.add(m);
            return;
        }
        // R18: a window's child frame by number (frames[0], top.frames[1]):
        // the browser hands out the real child; the runtime its view.
        if (computed && !inChain && !written && this.o.wrapMemberExpression && plainWindow(obj) && (isNumberLiteral(prop) || certainlyNumber(prop))) {
            const lb = skipTrivia(this.src, obj.end);
            const rb = m.end - 1;
            if (this.src[lb] !== "[" || this.src[rb] !== "]") return;
            this.open(obj.start, "$rewriter.wrap_member_expression(");
            this.replace(lb, 1, ",$__crn_key__=(");
            this.replace(rb, 1, "))[$__crn_key__]");
            this.wrapped.add(m);
            return;
        }
        if (name === undefined && !inChain && !written && !certainlyNumber(m["property"] as N) && this.o.wrapMemberExpression) { // R5
            const lb = skipTrivia(this.src, obj.end);
            const rb = m.end - 1;
            if (this.src[lb] !== "[" || this.src[rb] !== "]") return;
            this.open(obj.start, "$rewriter.wrap_member_expression(");
            this.replace(lb, 1, ",$__crn_key__=(");
            this.replace(rb, 1, "))[$__crn_key__]");
            this.wrapped.add(m);
        }
    }

    /** Whether the token after `at` is a plain `=` (not ==, ===, =>). */
    private plainAssignFollows(at: number): boolean {
        const i = skipTrivia(this.src, at);
        if (this.src[i] !== "=") return false;
        const next = this.src[i + 1];
        return next !== "=" && next !== ">";
    }

    /** Whether `callee`, as now written, starts with a call (so `new` would bind to that call). */
    private startsWithCall(callee: N): boolean {
        for (let n: N | undefined = callee; n; ) {
            if (this.wrapped.has(n)) return true;
            if (n.type === "MemberExpression") n = n["object"] as N;
            else if (n.type === "TaggedTemplateExpression") n = n["tag"] as N;
            else return false;
        }
        return false;
    }
}

/** Whether `e` is part of an optional chain that can short-circuit (`a?.b.c`: for `.c`, yes). */
function optionalBelow(e: N | null | undefined): boolean {
    for (let n = e; n; ) {
        if (n.type === "MemberExpression") {
            if (n["optional"]) return true;
            n = n["object"] as N;
        } else if (n.type === "CallExpression") {
            if (n["optional"]) return true;
            n = n["callee"] as N;
        } else {
            return false;
        }
    }
    return false;
}

/** The offset of the first token at or after `i`: past whitespace and comments. */
function skipTrivia(src: string, i: number): number {
    for (;;) {
        const c = src.charCodeAt(i);
        if (c === 0x2f && src.charCodeAt(i + 1) === 0x2f) { // //
            while (i < src.length && src.charCodeAt(i) !== 0x0a && src.charCodeAt(i) !== 0x0d &&
                   src.charCodeAt(i) !== 0x2028 && src.charCodeAt(i) !== 0x2029) i++;
        } else if (c === 0x2f && src.charCodeAt(i + 1) === 0x2a) { // /*
            const e = src.indexOf("*/", i + 2);
            i = e < 0 ? src.length : e + 2;
        } else if (c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 ||
                   c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) {
            i++;
        } else {
            return i;
        }
    }
}

const WIN_NAMES = new Set(["frames", "window", "self", "top", "parent", "opener"]);

/** R18: the expression plainly is a window — one of those names (or globalThis), or a member of one but globalThis. */
function plainWindow(e: N): boolean {
    if (e.type === "Identifier") return WIN_NAMES.has(e["name"] as string) || e["name"] === "globalThis";
    if (e.type === "MemberExpression" && !e["computed"] && !e["optional"]) {
        const p = e["property"] as N;
        return p.type === "Identifier" && WIN_NAMES.has(p["name"] as string);
    }
    return false;
}

const isNumberLiteral = (e: N): boolean => e.type === "Literal" && (typeof e["value"] === "number" || typeof e["value"] === "bigint");

/**
 * Whether an expression's value is certainly a number (or a BigInt): it
 * is, parentheses aside, a unary - + ~, a ++ / --, or a binary arithmetic
 * or bitwise operation other than + (which also concatenates). Such a
 * computed key names no member the rules know (R5).
 */
function certainlyNumber(key: N): boolean {
    while (key.type === "ParenthesizedExpression") key = key["expression"] as N;
    switch (key.type) {
        case "UpdateExpression":
            return true;
        case "UnaryExpression": {
            const op = key["operator"] as string;
            return op === "-" || op === "+" || op === "~";
        }
        case "BinaryExpression":
            switch (key["operator"] as string) {
                case "|": case "^": case "&": case "<<": case ">>": case ">>>":
                case "-": case "*": case "/": case "%": case "**":
                    return true;
            }
            return false;
    }
    return false;
}
