// The shape of `window.$rewriter` — the object the server-rewritten code
// calls into at runtime. Every method here corresponds to a server-side AST
// rewrite rule (JS_WRAP_*) or an HTML attribute hook injected by the HTML
// rewriter. Keeping the type explicit makes it obvious what the runtime
// surface is and what "the server is allowed to call" means.

import type { ClientConfig } from "../config";
import type { WrappedLocation } from "../wrappers/wrapped-location";
import type { DocumentWriteWrapper } from "../wrappers/document-write";
import type { PostMessageWrapper } from "../wrappers/post-message";

/** Shape of $rewriter.wrap_set_location(...).value (assignment-only setter). */
export interface AssignableLocationHref {
    set value(v: string);
    get value(): string;
}

export interface RewriterApi {
    /** The configuration the server handed us at injection time. */
    config: ClientConfig;

    // ── Base-URL state ─────────────────────────────────────────────────────
    get_base_url(): URL;
    set_base_url(href: string): void;
    set_location(href: string): void;
    set_cookies(payload: string): void;

    // ── JS_WRAP_* runtime helpers (one per server-side AST rule) ───────────
    wrap_get_location(loc: Location): WrappedLocation;
    wrap_set_location(loc: Location, setter: (v: string) => void): AssignableLocationHref;
    wrap_location(arg: { obj: unknown }): { location: unknown };
    wrap_get_top_window(top: Window): Window;
    wrap_top_window(arg: { obj: unknown }): { top: unknown };
    wrap_parent_window(arg: { obj: unknown }): { parent: unknown };
    // arg.obj is whatever had `.write` / `.writeln` at the server-rewritten
    // call site — Document is the common case but not the only one. Streams,
    // libs, anything with those method names. The wrapper does runtime
    // dispatch (rewrite as HTML for Documents, passthrough for everything
    // else); see document-write.ts.
    wrap_document_write(arg: { obj: unknown }): DocumentWriteWrapper;
    // Same shape concern: wrap_postMessage fires on any obj.postMessage —
    // Window, MessagePort, BroadcastChannel, ServiceWorker, etc.
    wrap_postMessage(arg: { obj: unknown }): PostMessageWrapper;
    wrap_member_expression(obj: unknown, prop: PropertyKey): unknown;
    wrap_eval(evalFn: typeof eval): typeof eval;
    wrap_eval_arg(evalFn: typeof eval, source: unknown): unknown;
    wrap_eval_memexp(obj: unknown): unknown;

    // ── HTML attribute hooks (injected by the server-side HTML rewriter) ───
    process_server_cookies(): void;
    fetch_cookies(elem: HTMLElement, cb?: () => void): void;
    append_rewrite_script_into_iframe(iframe: HTMLIFrameElement): void;
    get_top_level_window(w: Window): Window;
}
