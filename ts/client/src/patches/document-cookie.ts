// Patch document.cookie to use the proxy's in-memory cookie store.
//
// All upstream cookies are absorbed server-side into the session jar and
// delivered to the page via the bootstrap script's $rewriter.set_cookies()
// call, which populates the in-memory store. No cookies flow through
// document.cookie in the browser sense — this patch makes document.cookie
// read and write the in-memory store instead.
//
// Getter: returns all non-expired cookies applicable to the current upstream
//         pathname (RFC 6265 §5.1.4 path matching).
// Setter: writes the cookie into the in-memory store (parse + upsert).

import { getCookiesForPath, setCookie } from "../cookies/in-memory-store";

export function patchDocumentCookie(
    targetWindow: Window,
    getCurrentPathname: () => string,
): void {
    const doc = targetWindow.document;

    Object.defineProperty(doc, "cookie", {
        get(): string {
            return getCookiesForPath(getCurrentPathname());
        },
        set(value: string): void {
            setCookie(value as string);
        },
        configurable: true,
        enumerable: true,
    });
}
