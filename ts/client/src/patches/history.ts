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
): void {
    const proto = targetWindow.history;
    if (!proto) return;

    const origPushState = History.prototype.pushState.bind(proto);
    const origReplaceState = History.prototype.replaceState.bind(proto);

    const rewriteArg = (url: string | URL | null | undefined): string | null | undefined => {
        if (url == null) return url;
        const raw = url instanceof URL ? url.href : String(url);
        return rewriteOne(raw);
    };

    History.prototype.pushState = function patchedPushState(
        data: unknown,
        unused: string,
        url?: string | URL | null,
    ): void {
        origPushState(data, unused, rewriteArg(url));
    };

    History.prototype.replaceState = function patchedReplaceState(
        data: unknown,
        unused: string,
        url?: string | URL | null,
    ): void {
        origReplaceState(data, unused, rewriteArg(url));
    };
}
