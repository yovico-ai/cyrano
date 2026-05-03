// Patches History.prototype.pushState and History.prototype.replaceState so
// that URL arguments pointing at the upstream origin are rewritten to the
// proxy form before being handed to the browser.
//
// Without this patch, code like:
//   history.replaceState(null, '', 'https://original.com/page')
// throws a SecurityError because the URL is cross-origin relative to the
// proxy window (http://localhost:9081).
//
// The URL argument may be null/undefined (leave the address bar unchanged),
// an absolute URL, or a relative path. Null/undefined is passed through
// unchanged; everything else is rewritten.

export function patchHistory(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    setBaseUrl: (href: string) => void,
    unwrapOne: (proxied: string) => string,
): void {
    const proto = targetWindow.history;
    if (!proto) return;

    // Capture the real Location object now, before patchWindowLocation later
    // overrides window.location. The native Location.href is a live getter so
    // realLocation.href always returns the actual browser URL even after the
    // override — we rely on this in the popstate handler.
    const realLocation = targetWindow.location;

    const origPushState = History.prototype.pushState.bind(proto);
    const origReplaceState = History.prototype.replaceState.bind(proto);

    // Rewrite the URL arg and update baseUrlState so window.location.pathname
    // reads back the correct upstream path after SPA navigation.
    function rewriteAndUpdate(url: string | URL | null | undefined): string | null | undefined {
        if (url == null) return url;
        const raw = url instanceof URL ? url.href : String(url);
        const proxified = rewriteOne(raw);
        // Decode the proxified URL to recover the original upstream URL and
        // store it in baseUrlState so subsequent window.location reads are
        // correct.  If rewriteOne left the URL unchanged (fragment-only,
        // non-proxifiable scheme, etc.) skip the update.
        if (proxified !== raw) {
            const original = unwrapOne(proxified);
            if (original !== proxified) {
                setBaseUrl(original);
            }
        }
        return proxified;
    }

    History.prototype.pushState = function patchedPushState(
        data: unknown,
        unused: string,
        url?: string | URL | null,
    ): void {
        origPushState(data, unused, rewriteAndUpdate(url));
    };

    History.prototype.replaceState = function patchedReplaceState(
        data: unknown,
        unused: string,
        url?: string | URL | null,
    ): void {
        origReplaceState(data, unused, rewriteAndUpdate(url));
    };

    // Keep baseUrlState in sync when the user navigates back/forward.
    targetWindow.addEventListener("popstate", () => {
        const proxyHref = realLocation.href;
        const original = unwrapOne(proxyHref);
        if (original !== proxyHref) {
            setBaseUrl(original);
        }
    });
}
