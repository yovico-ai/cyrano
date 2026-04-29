// Helper for reading individual cookie values out of `document.cookie`.
//
// `document.cookie` is a single string of `name1=value1; name2=value2; ...`
// pairs — the standard DOM API offers no per-name accessor. We trim and
// URL-decode the value, mirroring how a browser would parse `Set-Cookie`.

export function readCookieValue(name: string, doc: Document): string | undefined {
    const allCookies = doc.cookie;
    if (!allCookies) return undefined;
    const prefix = `${name}=`;
    for (const part of allCookies.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) {
            return decodeURIComponent(trimmed.slice(prefix.length));
        }
    }
    return undefined;
}
