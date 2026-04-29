// WrappedLocation — what server-rewritten code sees in place of `window.location`.
//
// Reads return values derived from the page's effective base URL (the URL the
// page-side code thinks it's on), so feature checks like
//   if (location.host === "example.com") { ... }
// keep working unchanged when the page is actually loaded from
// `proxy.invalid:9081/?goto=...`.
//
// Writes assign through the URL containment logic (`rewriteUrl()`) so they
// land at the proxified URL on the real Location, triggering a real
// navigation through the proxy.
//
// Properties not listed here aren't on the standard Location interface; if a
// site reads something exotic we'll need to extend.

import type { ClientConfig } from "../config";
import type { BaseUrlState } from "../runtime/base-url-state";
import { rewriteUrl } from "../url/containment";

export class WrappedLocation {
    constructor(
        private readonly baseUrl: BaseUrlState,
        private readonly realLocation: Location,
        private readonly config: ClientConfig,
    ) {}

    private get base(): URL {
        return this.baseUrl.get();
    }

    // ── href ───────────────────────────────────────────────────────────────
    get href(): string { return this.base.href; }
    set href(value: string) { this.assign(value); }

    // ── origin / protocol / host / hostname / port ─────────────────────────
    get origin(): string { return this.base.origin; }

    get protocol(): string { return this.base.protocol; }
    set protocol(value: string) {
        const next = new URL(this.base.href);
        next.protocol = value;
        this.assign(next.href);
    }

    get host(): string { return this.base.host; }
    set host(value: string) {
        const next = new URL(this.base.href);
        next.host = value;
        this.assign(next.href);
    }

    get hostname(): string { return this.base.hostname; }
    set hostname(value: string) {
        const next = new URL(this.base.href);
        next.hostname = value;
        this.assign(next.href);
    }

    get port(): string { return this.base.port; }
    set port(value: string) {
        const next = new URL(this.base.href);
        next.port = value;
        this.assign(next.href);
    }

    // ── pathname / search ──────────────────────────────────────────────────
    get pathname(): string { return this.base.pathname; }
    set pathname(value: string) {
        const next = new URL(this.base.href);
        next.pathname = value;
        this.assign(next.href);
    }

    get search(): string { return this.base.search; }
    set search(value: string) {
        const next = new URL(this.base.href);
        next.search = value;
        this.assign(next.href);
    }

    // ── hash ───────────────────────────────────────────────────────────────
    get hash(): string { return this.base.hash; }
    set hash(value: string) {
        // Hash changes don't navigate cross-origin and don't issue a request,
        // so we apply them directly to the real Location and reflect them in
        // our base URL state. No proxification needed.
        this.realLocation.hash = value;
        const next = new URL(this.base.href);
        next.hash = value;
        this.baseUrl.setFromUrl(next);
    }

    // ── methods ────────────────────────────────────────────────────────────
    assign(url: string): void {
        const proxifiedTarget = rewriteUrl(url, this.base, this.config);
        this.realLocation.assign(proxifiedTarget);
    }

    replace(url: string): void {
        const proxifiedTarget = rewriteUrl(url, this.base, this.config);
        this.realLocation.replace(proxifiedTarget);
    }

    reload(): void {
        this.realLocation.reload();
    }

    toString(): string {
        return this.base.href;
    }
}
