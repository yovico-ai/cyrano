// fetch(), Request.prototype.url and Response.prototype.url, as page code
// sees them natively (REQUIREMENTS.md, the page cannot tell).
//
// fetch(input, init): input may be a string or any stringifiable object
// (URL, TrustedURL, …) or a Request — of this realm or another frame's.
// The URL is proxified; everything else passes to the native untouched,
// with the caller's receiver, so a wrong `this` still throws "Illegal
// invocation". A URL the native would reject — notably one with
// credentials, which fetch refuses with a TypeError — is handed to the
// native as written, so the rejection is the browser's own.
//
// Request/Response.url read back the original URL.
//
// A request to another origin is under CORS as it is natively (cors.ts):
// "same-origin" mode is refused by the browser itself, a "cors" response
// must pass the CORS check, shows only its exposed headers and has type
// "cors".

import { SafeWeakMap, nO, nOP, nR, ncall, sStarts } from "../native/intrinsics";
import { patchFetchLater } from "./fetch-later";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";
import { CREDENTIALS, INITIATOR, namesContext, includesCredentials, initiatorValue, corsAllows, exposedBy, isCrossOrigin, type CorsContext, type Exposed } from "./cors";
import { headerViewsOf } from "./response-headers";
import { type RewriteOne } from "./referrer-policy";
import { isReferrerPolicy } from "../url/containment";

const isRequest = (x: unknown): x is Request =>
    typeof x === "object" && x !== null && ncall(nOP.toString, x) === "[object Request]";

/** True when the browser itself would refuse `raw` in fetch (credentials). */
function nativeRefuses(raw: string, base: () => URL): boolean {
    try {
        const u = new URL(raw, base());
        return u.username !== "" || u.password !== "";
    } catch {
        return true; // unparseable: the native rejects it with its own error
    }
}

/** The referrer policy a RequestInit names (a valid one; anything else is the native's to judge). */
function policyOf(init: unknown): string | null {
    if (typeof init !== "object" || init === null) return null;
    let p: unknown;
    try { p = (init as { referrerPolicy?: unknown }).referrerPolicy; } catch { return null; }
    return typeof p === "string" && isReferrerPolicy(p) ? p : null;
}

/** The page's init, its referrerPolicy read as unsafe-url (its other members its own, read once each). */
function unsafeUrlInit(init: object): object {
    return new Proxy(init, { get: (t, k, r) => (k === "referrerPolicy" ? "unsafe-url" : nR.get(t, k, r)) });
}

/**
 * A RequestInit's referrer as the browser must get it (spec/Referrer.agda
 * initReferrer, checked against Chromium): "" stays; a URL of the context's
 * origin — parsed against its base — is the request's referrer, handed to
 * the browser proxified (on the proxy's origin, so honoured; the proxy
 * reads it back and applies the policy to the original); anything else is
 * the context's own (about:client). A value that does not parse is left
 * for the native to refuse. Mapbox's worker names its page so: unmapped,
 * the browser dropped it and the tiles' URL-restricted token was refused.
 */
export function initReferrer(v: string, base: URL, contextOrigin: string, rewriteOne: (u: string) => string): string {
    if (v === "") return "";
    let u: URL;
    try { u = new URL(v, base); } catch { return v; }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== contextOrigin) return "about:client";
    return rewriteOne(u.href);
}

/** The page's init with its referrer (if it names one) as initReferrer maps it; the init itself otherwise. */
function referrerInit(init: unknown, base: () => URL, contextOrigin: (() => string) | undefined, rewriteOne: (u: string) => string): unknown {
    if (typeof init !== "object" || init === null) return init;
    let v: unknown;
    try { v = (init as { referrer?: unknown }).referrer; } catch { return init; }
    if (v === undefined) return init;
    const own = contextOrigin?.() ?? base().origin;
    const mapped = initReferrer(String(v), base(), own, rewriteOne);
    return new Proxy(init, { get: (t, k, r) => (k === "referrer" ? mapped : nR.get(t, k, r)) });
}

export function patchFetch(
    targetWindow: Window,
    rewriteOne: RewriteOne,
    unwrapOne: (url: string) => string,
    baseUrl: () => URL,
    cors?: CorsContext,
): void {
    // Response#type, the browser's own (read before the runtime wraps it).
    const nativeType = (w0 => { try { return nO.getOwnPropertyDescriptor((w0 as unknown as { Response?: { prototype: object } }).Response?.prototype ?? {}, "type")?.get as ((this: unknown) => string) | undefined; } catch { return undefined; } })(targetWindow);
    const w = targetWindow as unknown as {
        Request?: typeof Request; Response?: typeof Response; Promise?: PromiseConstructor; TypeError?: TypeErrorConstructor;
    };
    const NativeRequest = w.Request;
    // (Before the accessor is wrapped below: the URL the Request really holds.)
    const nativeUrl = NativeRequest?.prototype
        ? nO.getOwnPropertyDescriptor(NativeRequest.prototype, "url")?.get as ((this: unknown) => string) | undefined
        : undefined;
    const sameUrl = (a: string, b: string): boolean => {
        if (a === b) return true;
        try { return new URL(a).href === new URL(b, a).href; } catch { return false; }
    };
    const then = (w.Promise ?? Promise).prototype.then;
    const TypeErr = w.TypeError ?? TypeError;
    const headersOf = w.Response?.prototype
        ? nO.getOwnPropertyDescriptor(w.Response.prototype, "headers")?.get as ((this: unknown) => Headers) | undefined
        : undefined;
    // A Headers handed over in an init is read by its iterator, which the
    // runtime wraps to keep its own request headers out of the page's
    // sight (response-headers.ts): the native gets the pairs instead,
    // listed with the native forEach (captured before that patch).
    const HeadersProto = (targetWindow as unknown as { Headers?: { prototype: Headers } }).Headers?.prototype;
    const nativeHeadersForEach = HeadersProto?.forEach;
    const pairsOf = (h: Headers): Array<[string, string]> | Headers => {
        if (!nativeHeadersForEach) return h;
        const out: Array<[string, string]> = [];
        ncall(nativeHeadersForEach, h, (v: string, k: string) => { out[out.length] = [k, v]; });
        return out;
    };
    /** Responses that passed the CORS check → what they expose. */
    const corsResponses = new SafeWeakMap<object, Exposed>();

    const nativeFetch = wrapMethod<typeof fetch>(targetWindow, "fetch", (native, self, args) => {
        const [input, ...rest] = args;
        const viaRequest = isRequest(input);
        // A Request's URL is the one it holds, read by the native getter
        // (and unwrapped): a page's `url` can be its own (a subclass's
        // getter — YouTube checks for blockers with a data: Request whose
        // `url` names its player API; the runtime fetched the API instead,
        // over a rebuilt request HTTP/1.1 could not send).
        const original = viaRequest ? (nativeUrl ? unwrapOne(ncall(nativeUrl, input)) : input.url) : String(input);
        if (nativeRefuses(original, baseUrl)) return nR.apply(native, self, args) as Promise<Response>;
        // The request's own referrer policy: carried by its URL, the browser
        // told unsafe-url (patches/referrer-policy.ts). A Request made by the
        // page carries it already.
        const policy = policyOf(rest[0]);
        if (policy !== null) rest[0] = unsafeUrlInit(rest[0] as object);
        if (rest.length) rest[0] = referrerInit(rest[0], baseUrl, cors?.origin, rewriteOne) as RequestInit | undefined;
        let rewritten = policy !== null && rewriteOne.withPolicy ? rewriteOne.withPolicy(original, policy) : rewriteOne(original);
        // The page's own Request goes to the native as it is wherever it
        // already names the proxied URL (the Request constructor below
        // proxifies it): a Request rebuilt from another has that one's body
        // as a stream, which no HTTP/1.1 connection can send.
        let asIs = viaRequest && nativeUrl !== undefined && sameUrl(ncall(nativeUrl, input), rewritten);
        const plain = (): Promise<Response> => {
            if (!viaRequest) return nR.apply(native, self, [rewritten, ...rest]) as Promise<Response>;
            if (asIs) return nR.apply(native, self, args) as Promise<Response>;
            const Req = (NativeRequest ?? Request) as typeof Request; // the native: the URL is rewritten already
            return nR.apply(native, self, [new Req(rewritten, input), ...rest]) as Promise<Response>;
        };
        const own = cors?.origin();
        // Judged by where the request really goes: the original of the URL
        // sent. One left on the proxy's own origin is a page URL resolved
        // against the proxy (the server routes it by its Referer): the
        // page's own origin.
        const target = unwrapOne(rewritten);
        const cross = own !== undefined && isCrossOrigin(target, baseUrl(), own) &&
            !(cors!.proxy && sStarts(target, cors!.proxy + "/"));
        const init = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : undefined) as RequestInit | undefined;
        const mode = init?.mode ?? (viaRequest ? input.mode : "cors");
        const credentials = init?.credentials ?? (viaRequest ? input.credentials : "same-origin");
        // no-cors to another origin with no credentials for it (fetch's
        // default "same-origin"): the browser drops the runtime's headers in
        // no-cors, so the URL says it (spec Containment destAnon). A page's
        // Request with a body is not rebuilt (a stream body).
        if (cross && cors?.opaque !== true && mode === "no-cors" && !includesCredentials(String(credentials), false) && rewriteOne.withMark) {
            const method = String(init?.method ?? (viaRequest ? input.method : "GET")).toUpperCase();
            if (!viaRequest || (init?.body == null && (method === "GET" || method === "HEAD"))) {
                rewritten = rewriteOne.withMark(original, policy, "anon");
                asIs = false;
            }
        }
        if (own === undefined || !namesContext(cors?.opaque === true, cross, cors?.always === true)) return plain();

        const credentialed = credentials === "include";
        const redirect = init?.redirect ?? (viaRequest ? input.redirect : "follow");
        // The browser refuses this before any request: let it, on the original URL.
        if (cross && mode === "same-origin") return nR.apply(native, self, args) as Promise<Response>;

        // Name the requesting context to the proxy, in two request headers
        // (cors.ts) — set where the request's headers are taken from: the
        // init's when it has any (they replace a Request's), else the
        // page's Request itself, else a new init. Never by rebuilding the
        // request (see asIs above).
        let sent: Promise<Response>;
        try {
            const from = initiatorValue(cors!.href());
            if (!from) {
                sent = plain();
            } else {
                const mark = (h: Headers): Headers => {
                    h.set(INITIATOR, from);
                    h.set(CREDENTIALS, includesCredentials(credentials, !cross) ? "include" : "omit");
                    return h;
                };
                const H = (w as unknown as { Headers: typeof Headers }).Headers;
                if (init && init.headers !== undefined) {
                    const first = viaRequest ? (asIs ? input : new (NativeRequest ?? Request)(rewritten, input)) : rewritten;
                    sent = nR.apply(native, self, [first, { ...init, headers: pairsOf(mark(new H(init.headers))) }]) as Promise<Response>;
                } else if (viaRequest) {
                    const req = asIs ? input : new (NativeRequest ?? Request)(rewritten, input);
                    mark(req.headers);
                    sent = nR.apply(native, self, [req, ...rest]) as Promise<Response>;
                } else {
                    sent = nR.apply(native, self, [rewritten, { ...(init ?? {}), headers: pairsOf(mark(new H())) }]) as Promise<Response>;
                }
            }
        } catch {
            sent = plain();
        }
        // no-cors with a redirect not followed, to another origin: natively
        // a network error once the redirect comes; through the proxy it is
        // same-origin, an opaque redirect.
        if (cross && mode === "no-cors" && redirect !== "follow") {
            const TE = (w as unknown as { TypeError: typeof TypeError }).TypeError;
            return nR.apply(then, sent, [(resp: Response) => {
                if (resp.type === "opaqueredirect") throw new TE("Failed to fetch");
                return resp;
            }]) as Promise<Response>;
        }
        const views = headerViewsOf(targetWindow);
        if (!cross || mode !== "cors" || !views || !headersOf) return sent;
        return nR.apply(then, sent, [(resp: Response) => {
            // An opaque redirect (redirect: "manual") shows no headers: the
            // proxy checked the redirect itself (round I: Chromium gives it).
            if (nativeType && ncall(nativeType, resp) === "opaqueredirect") return resp;
            const h = ncall(headersOf, resp);
            if (!corsAllows(views.original(h, "access-control-allow-origin"), views.original(h, "access-control-allow-credentials"), own, credentialed)) {
                throw new TypeErr("Failed to fetch");
            }
            const allow = exposedBy(views.original(h, "access-control-expose-headers"), credentialed);
            views.expose(h, allow);
            corsResponses.set(resp, allow);
            return resp;
        }]) as Promise<Response>;
    });

    // fetchLater: its quota per original origin, and deferred here where
    // the native refuses for the proxy's reasons (fetch-later.ts).
    patchFetchLater(targetWindow, rewriteOne, baseUrl, nativeFetch as ((...a: unknown[]) => Promise<Response>) | undefined,
        (raw) => nativeRefuses(raw, baseUrl), isRequest);

    const R = w.Response?.prototype;
    if (R) {
        wrapAccessor<string>(R, "type", {
            get: (get, self) => {
                const t = ncall(get, self);
                return t === "basic" && typeof self === "object" && self !== null && corsResponses.has(self) ? "cors" : t;
            },
        });
        wrapMethod<(...a: unknown[]) => Response>(R, "clone", (native, self, args) => {
            const copy = nR.apply(native, self, args) as Response;
            const allow = typeof self === "object" && self !== null ? corsResponses.get(self) : undefined;
            if (allow && headersOf) {
                corsResponses.set(copy, allow);
                headerViewsOf(targetWindow)?.expose(ncall(headersOf, copy), allow);
            }
            return copy;
        });
    }

    // new Request(url): the URL is proxified as fetch's is — left to the
    // browser it resolves against the proxy's origin.
    // A Request made with a referrer policy: its URL carries it and the
    // native holds unsafe-url; its referrerPolicy reads the page's.
    const requestPolicies = new SafeWeakMap<object, string>();
    wrapConstructor<typeof Request>(targetWindow, "Request", (Native, args, newTarget) => {
        const next = args.slice();
        const policy = policyOf(next[1]);
        if (policy !== null) next[1] = unsafeUrlInit(next[1] as object);
        if (next.length > 1) next[1] = referrerInit(next[1], baseUrl, cors?.origin, rewriteOne);
        if (next.length && !isRequest(next[0])) {
            const raw = String(next[0]);
            if (!nativeRefuses(raw, baseUrl)) next[0] = policy !== null && rewriteOne.withPolicy ? rewriteOne.withPolicy(raw, policy) : rewriteOne(raw);
        }
        const req = nR.construct(Native, next, newTarget as typeof Request) as Request;
        const kept = policy ?? (isRequest(next[0]) ? requestPolicies.get(next[0]) : undefined);
        if (kept !== undefined) requestPolicies.set(req, kept);
        return req;
    });
    if (NativeRequest?.prototype && nO.getOwnPropertyDescriptor(NativeRequest.prototype, "referrerPolicy")) {
        wrapAccessor<string>(NativeRequest.prototype, "referrerPolicy", {
            get: (get, self) => (typeof self === "object" && self !== null ? requestPolicies.get(self) : undefined) ?? ncall(get, self),
        });
    }
    for (const Ctor of [w.Request, w.Response]) {
        if (!Ctor?.prototype) continue;
        wrapAccessor<string>(Ctor.prototype, "url", { get: (get, self) => unwrapOne(ncall(get, self)) });
    }
    // A Request's referrer reads the original (about:client and "" as they are).
    if (NativeRequest?.prototype && nO.getOwnPropertyDescriptor(NativeRequest.prototype, "referrer")) {
        wrapAccessor<string>(NativeRequest.prototype, "referrer", {
            get: (get, self) => {
                const v = ncall(get, self);
                return v === "" || v === "about:client" ? v : unwrapOne(v);
            },
        });
    }
}
