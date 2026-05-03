// Cookie site-key computation — must produce byte-identical output to
// Go's cookieSiteKey() in internal/proxy/handler.go.
//
// Both sides use eTLD+1 (via the Public Suffix List) so that subdomains
// share a namespace: www.casio.com and cdn.casio.com both map to "casio_com".

import { getDomain } from "tldts";

export function cookieSiteKey(host: string): string {
    const bare = host.split(":")[0].toLowerCase();
    const etld1 = getDomain(bare) ?? bare;
    return etld1.replace(/\./g, "_");
}

export function cookiePrefixFor(host: string): string {
    return `__crn__${cookieSiteKey(host)}__`;
}
