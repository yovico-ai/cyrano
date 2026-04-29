// A mutable holder for the page's effective base URL.
//
// "Base URL" here means the URL the page-side code *believes* it's on — the
// origin URL, not the proxified URL the browser actually loaded. The bootstrap
// script the server injects calls $rewriter.set_base_url(...) early in page
// load to declare it, and many wrappers read it back to compute relative URL
// resolution and to respond truthfully to `location.host` / `location.href`
// reads.
//
// We expose it as a tiny object so wrappers can be parameterized by it
// without holding direct closures over a let-binding (and so it can be
// swapped out in tests, eventually).

export class BaseUrlState {
    private current: URL;

    constructor(initial: URL) {
        this.current = initial;
    }

    get(): URL {
        return this.current;
    }

    /** Replace the base URL. Invalid input is silently dropped. */
    setFromHref(href: string): void {
        try {
            this.current = new URL(href);
        } catch {
            // ignore — keep the previous value
        }
    }

    setFromUrl(url: URL): void {
        this.current = url;
    }
}
