// Patch `window.fetch` so dynamic fetch() calls go through the proxy.
//
// `fetch` accepts a string, a URL, or a Request object as its input. Each
// shape needs a different rewrite path:
//   - string  → rewrite directly
//   - URL     → rewrite the href
//   - Request → clone with the rewritten URL, preserving init overrides
//
// All other fetch options pass through unchanged.

export function patchFetch(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
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
        // Request object: build a new Request with the rewritten URL,
        // copying body/method/headers/etc. from the original. `init`, when
        // provided, takes precedence over the cloned values.
        const rewrittenRequest = new Request(rewriteOne(input.url), input);
        return boundNativeFetch(rewrittenRequest, init);
    }) as typeof fetch;
}
