// Shared test helpers.

import { PROXY_ORIGIN, FIXTURE_PORT } from "./playwright.config.ts";

/** Return the proxy URL that fetches target through the proxy. */
export function gotoURL(target: string): string {
    const u = new URL(target);
    const scheme = u.protocol.slice(0, -1); // strip trailing ':'
    const cyranoPath = `/cyrano/${scheme}/${u.host}${u.pathname}`;
    const search = u.search; // already includes leading '?' or is ''
    const hash = u.hash;     // already includes leading '#' or is ''
    return `${PROXY_ORIGIN}${cyranoPath}${search}${hash}`;
}

/** Return the fixture URL for a given hostname and path. */
export function fixtureURL(hostname: string, path = "/"): string {
    return `http://${hostname}:${FIXTURE_PORT}${path}`;
}
