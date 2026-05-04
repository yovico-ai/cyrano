// In-memory cookie store for the proxy runtime.
//
// Replaces the native browser cookie store so all upstream cookies live in JS
// memory rather than in the browser's persistent cookie jar. Benefits:
//   - no cross-site pollution (browser stores cookies under the proxy origin,
//     so cookies from every proxied site would otherwise pile up together)
//   - eviction is deterministic (no stale cookies from previous proxy sessions)
//   - HttpOnly semantics are irrelevant here since there is no network: the
//     server never sends these cookies via Set-Cookie headers at all
//
// Module singleton — each frame gets a fresh IIFE execution and therefore a
// fresh store instance.

interface StoredCookie {
    name: string;
    value: string;
    path: string;     // defaults to "/"
    expires?: number; // Date.now() ms, absent = session cookie
}

const store: StoredCookie[] = [];

/**
 * Parse a Set-Cookie-style string and upsert into the store.
 * Deletion directives (Max-Age <= 0 or Expires in the past) remove the entry.
 */
export function setCookie(cookieStr: string): void {
    const semi = cookieStr.indexOf(";");
    const nameValue = semi >= 0 ? cookieStr.slice(0, semi) : cookieStr;
    const eq = nameValue.indexOf("=");
    if (eq < 0) return;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1);
    if (!name) return;

    let path = "/";
    let expires: number | undefined;
    let isDelete = false;

    const attrs = semi >= 0 ? cookieStr.slice(semi + 1) : "";
    for (const part of attrs.split(";")) {
        const attr = part.trim();
        const lower = attr.toLowerCase();
        if (lower.startsWith("path=")) {
            path = attr.slice(5).trim() || "/";
        } else if (lower.startsWith("max-age=")) {
            const age = parseInt(attr.slice(8), 10);
            if (!isNaN(age)) {
                if (age <= 0) {
                    isDelete = true;
                } else {
                    expires = Date.now() + age * 1000;
                }
            }
        } else if (!isDelete && lower.startsWith("expires=")) {
            const ms = Date.parse(attr.slice(8));
            if (!isNaN(ms)) {
                if (ms <= Date.now()) {
                    isDelete = true;
                } else {
                    expires = ms;
                }
            }
        }
    }

    if (isDelete) {
        _remove(name, path);
        return;
    }

    const idx = store.findIndex(e => e.name === name && e.path === path);
    const entry: StoredCookie = { name, value, path };
    if (expires !== undefined) entry.expires = expires;
    if (idx >= 0) {
        store[idx] = entry;
    } else {
        store.push(entry);
    }
}

/**
 * Returns the `document.cookie`-style string of all non-expired cookies
 * applicable to `reqPath`, following RFC 6265 §5.1.4 path matching.
 */
export function getCookiesForPath(reqPath: string): string {
    const now = Date.now();
    const result: string[] = [];
    for (let i = store.length - 1; i >= 0; i--) {
        const e = store[i]!;
        if (e.expires !== undefined && e.expires <= now) {
            store.splice(i, 1); // evict expired
            continue;
        }
        if (_pathMatches(reqPath, e.path)) {
            result.push(`${e.name}=${e.value}`);
        }
    }
    return result.reverse().join("; ");
}

/**
 * Populate the store from an array of Set-Cookie-style strings.
 * Called by the bootstrap script ($rewriter.set_cookies) and by the
 * /cookies.json live-sync endpoint.
 */
export function populateFromPayload(cookies: string[]): void {
    for (const c of cookies) {
        setCookie(c);
    }
}

/** Remove all entries. Used in tests to reset state between cases. */
export function clearStore(): void {
    store.length = 0;
}

function _remove(name: string, path: string): void {
    const idx = store.findIndex(e => e.name === name && e.path === path);
    if (idx >= 0) store.splice(idx, 1);
}

/** RFC 6265 §5.1.4 cookie-path matching. */
function _pathMatches(reqPath: string, cookiePath: string): boolean {
    if (!cookiePath || cookiePath === "/") return true;
    if (reqPath === cookiePath) return true;
    if (reqPath.startsWith(cookiePath)) {
        return cookiePath[cookiePath.length - 1] === "/" || reqPath[cookiePath.length] === "/";
    }
    return false;
}
