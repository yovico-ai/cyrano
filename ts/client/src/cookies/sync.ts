// Cookie sync between client and server.
//
// The proxy keeps origin cookies in its own (Redis-backed) per-session store
// to avoid cross-origin cookie collisions when many sites are proxied through
// the same hostname. The cookies the page actually sees in `document.cookie`
// are a snapshot the server hands the client at injection time and refreshes
// on every script/iframe/img load.
//
// On the wire:
//   GET /cookies.json?p=<base64url(comma-joined original URLs)>
//     → "[<set-cookie>, <set-cookie>, ...]"  (encrypted iff userDataEncryption)
//
// The server looks up cookies by the *original* hostname (the one the page
// believes it's on), so we unwrap the proxied URLs before sending them.

import type { ClientConfig } from "../config";
import { b64uEncode } from "../url/base64url";
import { proxyApiBase, unwrapProxiedUrl } from "../url/containment";
import { applyCookiePayload } from "./apply-payload";

export async function syncCookiesForResources(
    proxifiedResourceUrls: string[],
    config: ClientConfig,
    sessionSecret: string,
): Promise<void> {
    const originalUrls: string[] = [];
    for (const proxified of proxifiedResourceUrls) {
        if (!proxified) continue;
        const original = unwrapProxiedUrl(proxified, config);
        // Only http(s) URLs carry cookies. Anything else is dropped.
        if (/^https?:\/\//i.test(original)) {
            originalUrls.push(original);
        }
    }
    if (originalUrls.length === 0) return;

    const param = b64uEncode(originalUrls.join(","));
    const endpoint = `${proxyApiBase(config)}/cookies.json?p=${param}`;

    let response: Response;
    try {
        response = await fetch(endpoint, { credentials: "include" });
    } catch {
        return;
    }
    if (!response.ok) return;

    let body: string;
    try {
        body = await response.text();
    } catch {
        return;
    }
    applyCookiePayload(body, sessionSecret);
}
