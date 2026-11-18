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

import { wrapAccessor, wrapMethod } from "../native/surface";
import { CREDENTIALS, INITIATOR, initiatorValue, corsAllows, exposedBy, isCrossOrigin, type CorsContext, type Exposed } from "./cors";
import { headerViewsOf } from "./response-headers";

const isRequest = (x: unknown): x is Request =>
    typeof x === "object" && x !== null && Object.prototype.toString.call(x) === "[object Request]";

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
    const then = (w.Promise ?? Promise).prototype.then;
    const TypeErr = w.TypeError ?? TypeError;
    const headersOf = w.Response?.prototype
        ? Object.getOwnPropertyDescriptor(w.Response.prototype, "headers")?.get as ((this: unknown) => Headers) | undefined
        : undefined;
    /** Responses that passed the CORS check → what they expose. */
    const corsResponses = new WeakMap<object, Exposed>();

    wrapMethod<typeof fetch>(targetWindow, "fetch", (native, self, args) => {
        const [input, ...rest] = args;
        const viaRequest = isRequest(input);
        // input.url reads back the original (patched getter below).
        const original = viaRequest ? input.url : String(input);
        if (nativeRefuses(original, baseUrl)) return Reflect.apply(native, self, args) as Promise<Response>;
        const rewritten = rewriteOne(original);
        const plain = (): Promise<Response> => {
            if (!viaRequest) return Reflect.apply(native, self, [rewritten, ...rest]) as Promise<Response>;
            const Req = (input.constructor ?? Request) as typeof Request;
            return Reflect.apply(native, self, [new Req(rewritten, input), ...rest]) as Promise<Response>;
        };
        const own = cors?.origin();
        const cross = own !== undefined && isCrossOrigin(original, baseUrl(), own);
        if (own === undefined || (!cross && !cors?.always)) return plain();

        const init = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : undefined) as RequestInit | undefined;
        const mode = init?.mode ?? (viaRequest ? input.mode : "cors");
        const credentials = init?.credentials ?? (viaRequest ? input.credentials : "same-origin");
        const credentialed = credentials === "include";
        // The browser refuses this before any request: let it, on the original URL.
        if (cross && mode === "same-origin") return Reflect.apply(native, self, args) as Promise<Response>;

        // Name the requesting origin to the proxy. fetch(input, init) is
        // fetch(new Request(input, init)); a Request the constructor refuses
        // is left to the native to refuse.
        let sent: Promise<Response>;
        try {
            const Req = ((viaRequest ? input.constructor : undefined) ?? NativeRequest ?? Request) as typeof Request;
            let req = viaRequest ? new Req(rewritten, input) : new Req(rewritten, init);
            if (viaRequest && init) req = new Req(req, init);
            const from = initiatorValue(cors!.href());
            if (from) {
                req.headers.set(INITIATOR, from);
                req.headers.set(CREDENTIALS, credentialed || (credentials === "same-origin" && !cross) ? "include" : "omit");
            }
            sent = Reflect.apply(native, self, [req]) as Promise<Response>;
        } catch {
            sent = plain();
        }
        const views = headerViewsOf(targetWindow);
        if (!cross || mode !== "cors" || !views || !headersOf) return sent;
        return Reflect.apply(then, sent, [(resp: Response) => {
            const h = headersOf.call(resp);
            if (!corsAllows(views.original(h, "access-control-allow-origin"), views.original(h, "access-control-allow-credentials"), own, credentialed)) {
                throw new TypeErr("Failed to fetch");
            }
            const allow = exposedBy(views.original(h, "access-control-expose-headers"), credentialed);
            views.expose(h, allow);
            corsResponses.set(resp, allow);
            return resp;
        }]) as Promise<Response>;
    });

    const R = w.Response?.prototype;
    if (R) {
        wrapAccessor<string>(R, "type", {
            get: (get, self) => {
                const t = get.call(self);
                return t === "basic" && typeof self === "object" && self !== null && corsResponses.has(self) ? "cors" : t;
            },
        });
        wrapMethod<(...a: unknown[]) => Response>(R, "clone", (native, self, args) => {
            const copy = Reflect.apply(native, self, args) as Response;
            const allow = typeof self === "object" && self !== null ? corsResponses.get(self) : undefined;
            if (allow && headersOf) {
                corsResponses.set(copy, allow);
                headerViewsOf(targetWindow)?.expose(headersOf.call(copy), allow);
            }
            return copy;
        });
    }

    for (const Ctor of [w.Request, w.Response]) {
        if (!Ctor?.prototype) continue;
        wrapAccessor<string>(Ctor.prototype, "url", { get: (get, self) => unwrapOne(get.call(self)) });
    }
}
