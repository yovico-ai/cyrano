// WorkerWrappedLocation — what rewritten worker code sees in place of
// `location` inside a Worker's own global scope.
//
// Unlike WrappedLocation (wrapped-location.ts), a worker's location never
// changes over its lifetime (workers can't navigate) and there is no real
// Location object worth delegating to — a Worker created from a `blob:` URL
// has a WorkerLocation whose `href` is the opaque blob URL itself, which is
// exactly the kind of proxy-identifying value this wrapper exists to hide.
// So every property here is a fixed snapshot of the upstream URL the worker
// was created for, computed once by the intercepting `new Worker(...)` /
// Blob patch on the main thread and passed in as a plain string.
//
// assign/replace/reload are no-ops: a real WorkerLocation doesn't have them
// either (workers can't navigate), so any code path calling them was already
// going to fail against the native object — a no-op is no worse and avoids
// throwing on a wrapper that's supposed to be transparent.

export class WorkerWrappedLocation {
    private readonly url: URL;

    constructor(hrefAtCreation: string) {
        this.url = new URL(hrefAtCreation);
    }

    get href(): string { return this.url.href; }
    get origin(): string { return this.url.origin; }
    get protocol(): string { return this.url.protocol; }
    get host(): string { return this.url.host; }
    get hostname(): string { return this.url.hostname; }
    get port(): string { return this.url.port; }
    get pathname(): string { return this.url.pathname; }
    get search(): string { return this.url.search; }
    get hash(): string { return this.url.hash; }

    assign(_url: string): void { /* workers can't navigate */ }
    replace(_url: string): void { /* workers can't navigate */ }
    reload(): void { /* workers can't navigate */ }

    toString(): string { return this.url.href; }
}
