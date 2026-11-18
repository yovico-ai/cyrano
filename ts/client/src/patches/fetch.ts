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

import { wrapAccessor, wrapMethod } from "../native/surface";

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
): void {
    const w = targetWindow as unknown as { Request?: { prototype: object }; Response?: { prototype: object } };
    wrapMethod<typeof fetch>(targetWindow, "fetch", (native, self, args) => {
        const [input, ...rest] = args;
        if (isRequest(input)) {
            // input.url reads back the original (patched getter below).
            const original = input.url;
            if (nativeRefuses(original, baseUrl)) return Reflect.apply(native, self, args) as Promise<Response>;
            const Req = (input.constructor ?? Request) as typeof Request;
            return Reflect.apply(native, self, [new Req(rewriteOne(original), input), ...rest]) as Promise<Response>;
        }
        const raw = String(input);
        if (nativeRefuses(raw, baseUrl)) return Reflect.apply(native, self, args) as Promise<Response>;
        return Reflect.apply(native, self, [rewriteOne(raw), ...rest]) as Promise<Response>;
    });

    for (const Ctor of [w.Request, w.Response]) {
        if (!Ctor?.prototype) continue;
        wrapAccessor<string>(Ctor.prototype, "url", { get: (get, self) => unwrapOne(get.call(self)) });
    }
}
