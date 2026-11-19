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

import { SafeWeakMap, nO, nOP, nR, ncall } from "../native/intrinsics";
import { patchFetchLater } from "./fetch-later";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";
import { CREDENTIALS, INITIATOR, includesCredentials, initiatorValue, corsAllows, exposedBy, isCrossOrigin, type CorsContext, type Exposed } from "./cors";
import { headerViewsOf } from "./response-headers";

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

export function patchFetch(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
    baseUrl: () => URL,
    cors?: CorsContext,
): void {
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
    /** Responses that passed the CORS check → what they expose. */
    const corsResponses = new SafeWeakMap<object, Exposed>();

    const nativeFetch = wrapMethod<typeof fetch>(targetWindow, "fetch", (native, self, args) => {
        const [input, ...rest] = args;
        const viaRequest = isRequest(input);
        // input.url reads back the original (patched getter below).
        const original = viaRequest ? input.url : String(input);
        if (nativeRefuses(original, baseUrl)) return nR.apply(native, self, args) as Promise<Response>;
        const rewritten = rewriteOne(original);
        // The page's own Request goes to the native as it is wherever it
        // already names the proxied URL (the Request constructor below
        // proxifies it): a Request rebuilt from another has that one's body
        // as a stream, which no HTTP/1.1 connection can send.
        const asIs = viaRequest && nativeUrl !== undefined && sameUrl(ncall(nativeUrl, input), rewritten);
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
            !(cors!.proxy && target.startsWith(cors!.proxy + "/"));
        if (own === undefined || (!cross && !cors?.always)) return plain();

        const init = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : undefined) as RequestInit | undefined;
        const mode = init?.mode ?? (viaRequest ? input.mode : "cors");
        const credentials = init?.credentials ?? (viaRequest ? input.credentials : "same-origin");
        const credentialed = credentials === "include";
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
                    sent = nR.apply(native, self, [first, { ...init, headers: mark(new H(init.headers)) }]) as Promise<Response>;
                } else if (viaRequest) {
                    const req = asIs ? input : new (NativeRequest ?? Request)(rewritten, input);
                    mark(req.headers);
                    sent = nR.apply(native, self, [req, ...rest]) as Promise<Response>;
                } else {
                    sent = nR.apply(native, self, [rewritten, { ...(init ?? {}), headers: mark(new H()) }]) as Promise<Response>;
                }
            }
        } catch {
            sent = plain();
        }
        const views = headerViewsOf(targetWindow);
        if (!cross || mode !== "cors" || !views || !headersOf) return sent;
        return nR.apply(then, sent, [(resp: Response) => {
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
    wrapConstructor<typeof Request>(targetWindow, "Request", (Native, args, newTarget) => {
        const next = args.slice();
        if (next.length && !isRequest(next[0])) {
            const raw = String(next[0]);
            if (!nativeRefuses(raw, baseUrl)) next[0] = rewriteOne(raw);
        }
        return nR.construct(Native, next, newTarget as typeof Request);
    });
    for (const Ctor of [w.Request, w.Response]) {
        if (!Ctor?.prototype) continue;
        wrapAccessor<string>(Ctor.prototype, "url", { get: (get, self) => unwrapOne(ncall(get, self)) });
    }
}
