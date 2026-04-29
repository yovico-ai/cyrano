// Apply a cookie payload from the server to `document.cookie`.
//
// Wire format (matching server's `getCookiesForClient()` →
// `cookie.toSafeHeaderValue()` per entry):
//   "[\"name1=val1; Path=/; ...\", \"name2=val2; ...\"]"
//
// I.e. a JSON-encoded array of `Set-Cookie`-style strings, optionally wrapped
// in AES-CTR encryption when `userDataEncryption` is on.
//
// Each element becomes a single `document.cookie = entry` assignment, which
// the browser parses just like a real Set-Cookie header response — honoring
// Path, Max-Age, Secure, etc.

import { maybeDecryptCookiePayload } from "./decrypt";

export function applyCookiePayload(
    payload: string,
    sessionSecret: string,
): void {
    let plaintext: string;
    try {
        plaintext = maybeDecryptCookiePayload(payload, sessionSecret);
    } catch {
        // Decryption failure — drop the payload. Logging here would be noisy
        // in normal operation and we don't have a logger plumbed yet.
        return;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(plaintext);
    } catch {
        return;
    }
    if (!Array.isArray(parsed)) return;

    for (const entry of parsed) {
        if (typeof entry !== "string" || entry.length === 0) continue;
        try {
            document.cookie = entry;
        } catch {
            // An entry might not be valid for the current origin (Domain
            // mismatch, etc.). The browser silently ignores most such cases,
            // but throws on a few — skip and keep going.
        }
    }
}
