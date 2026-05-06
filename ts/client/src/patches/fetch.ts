// Patch `window.fetch` so dynamic fetch() calls go through the proxy.
//
// `fetch` accepts a string, a URL, or a Request object as its input. Each
// shape needs a different rewrite path:
//   - string  → rewrite directly
//   - URL     → rewrite the href
//   - Request → clone with the rewritten URL, preserving init overrides
//
// We also patch `Request.prototype.url` and `Response.prototype.url` so page
// code that reads the URL back from a Request or Response sees the upstream
// URL rather than the proxified one.
//
// All other fetch options pass through unchanged.

export function patchFetch(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
): void {
    const nativeFetch = targetWindow.fetch;
    if (!nativeFetch) return;
    const boundNativeFetch = nativeFetch.bind(targetWindow);

    targetWindow.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof input === "string") {
            return boundNativeFetch(rewriteOne(input), init);
        }
        if (input instanceof URL) {
            return boundNativeFetch(rewriteOne(input.href), init);
        }
        if (input instanceof Request) {
            // Request object: clone with the rewritten URL, preserving all options.
            const rewrittenRequest = new Request(rewriteOne(input.url), input);
            return boundNativeFetch(rewrittenRequest, init);
        }
        // Trusted Types URL-like (TrustedURL) or any other toString()-able object.
        return boundNativeFetch(rewriteOne(String(input)), init);
    }) as typeof fetch;

    for (const Ctor of [
        typeof Request !== "undefined" ? Request : undefined,
        typeof Response !== "undefined" ? Response : undefined,
    ]) {
        if (!Ctor?.prototype) continue;
        const urlDesc = Object.getOwnPropertyDescriptor(Ctor.prototype, "url");
        if (!urlDesc?.get) continue;
        const nativeGet = urlDesc.get;
        Object.defineProperty(Ctor.prototype, "url", {
            ...urlDesc,
            get(): string {
                return unwrapOne(nativeGet.call(this) as string);
            },
        });
    }
}
