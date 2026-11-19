// fetchLater(input, init), as page code sees it natively.
//
// The browser keeps a deferred-fetch quota per destination origin (64 KiB:
// the URL without its fragment, every header name and value, the body, and
// 12 bytes more — measured in Chromium 147). Under the proxy every
// destination is the proxy's origin, so all of a page's deferred fetches
// share one quota (tumblr: "exceeds its quota" where natively there is
// room); and a proxy reached over plain http makes every proxied URL
// insecure, which fetchLater refuses.
//
// So the runtime keeps the quota per original origin itself: it refuses,
// with the native's error, exactly where a direct browser would. Where the
// native refuses for the proxy's reasons, the request is deferred here:
// a FetchLaterResult (its `activated` answered by the wrapped getter) and
// the request sent with fetch(…, {keepalive: true}) when the page goes away
// (pagehide) or after activateAfter, unless its signal aborted it.
//
// Not modelled: the 640 KiB per-document total (the native's), FormData and
// stream bodies (left to the native). Known limit: requests deferred here
// are sent with keepalive, whose in-flight budget at unload is 64 KiB per
// document — deferred bodies beyond that are lost (the native's are not);
// beacons are small. A proxy-side store fired by a small beacon would lift it.

import { SafeMap, SafeWeakMap, nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";

const PER_ORIGIN = 65536;
const OVERHEAD = 12;

type Init = RequestInit & { activateAfter?: number };

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** The bytes a deferred request counts against its origin's quota, or null when not known here. */
function deferredSize(url: URL, init: Init | undefined, H: typeof Headers): number | null {
    const body = init?.body;
    let bodySize = 0;
    let contentType: string | null = null;
    if (body === undefined || body === null) {
        bodySize = 0;
    } else if (typeof body === "string") {
        bodySize = utf8Length(body);
        contentType = "text/plain;charset=UTF-8";
    } else if (body instanceof URLSearchParams) {
        bodySize = utf8Length(body.toString());
        contentType = "application/x-www-form-urlencoded;charset=UTF-8";
    } else if (body instanceof Blob) {
        bodySize = body.size;
        if (body.type) contentType = body.type;
    } else if (body instanceof ArrayBuffer) {
        bodySize = body.byteLength;
    } else if (ArrayBuffer.isView(body)) {
        bodySize = body.byteLength;
    } else {
        return null;
    }
    let headerSize = 0;
    let hasType = false;
    try {
        new H(init?.headers).forEach((v, k) => {
            headerSize += k.length + v.length;
            if (k === "content-type") hasType = true;
        });
    } catch {
        return null; // the native throws its own error
    }
    if (contentType !== null && !hasType) headerSize += "content-type".length + contentType.length;
    const u = new URL(url.href);
    u.hash = "";
    return u.href.length + headerSize + bodySize + OVERHEAD;
}

export function patchFetchLater(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    baseUrl: () => URL,
    nativeFetch: ((...a: unknown[]) => Promise<Response>) | undefined,
    refusedAsIs: (raw: string) => boolean,
    isRequest: (x: unknown) => boolean,
): void {
    const w = targetWindow as unknown as Record<string, unknown> & {
        FetchLaterResult?: { prototype: object };
        QuotaExceededError?: new (message: string, options?: object) => Error;
        DOMException: typeof DOMException;
        Headers: typeof Headers;
    };
    if (typeof w["fetchLater"] !== "function") return;
    const FLR = w.FetchLaterResult?.prototype;
    // Per original origin: the bytes deferred so far (this document's).
    const used = new SafeMap<string, number>();
    const emulated = new SafeWeakMap<object, { activated: boolean }>();
    if (FLR) {
        wrapAccessor<boolean>(FLR, "activated", {
            get: (get, self) => {
                const e = typeof self === "object" && self !== null ? emulated.get(self) : undefined;
                return e ? e.activated : ncall(get, self);
            },
        });
    }
    const quotaError = (got: number, left: number): Error => {
        const msg = `Failed to execute 'fetchLater' on 'Window': fetchLater exceeds its quota for the origin: got ${got} bytes, expected less than ${left} bytes.`;
        return w.QuotaExceededError ? new w.QuotaExceededError(msg) : new w.DOMException(msg, "QuotaExceededError");
    };
    // The native's refusals that are the proxy's doing: the proxy origin's
    // shared quota; and, on a plain-http proxy, the proxied URL being
    // insecure ("only supported over HTTPS", a TypeError — counted as the
    // proxy's only when the proxied URL is http: for an https original).
    const proxysRefusal = (e: unknown, proxied: string): boolean => {
        const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
        return name === "QuotaExceededError" || name === "SecurityError" ||
            (name === "TypeError" && proxied.startsWith("http:"));
    };
    const defer = (url: string, init: Init | undefined): object => {
        const result = nO.create(FLR ?? Object.prototype) as object;
        const state = { activated: false };
        emulated.set(result, state);
        const signal = init?.signal ?? null;
        const fetchInit: Record<string, unknown> = { ...(init ?? {}), keepalive: true };
        delete fetchInit["activateAfter"];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const send = (): void => {
            if (state.activated || (signal && signal.aborted)) return;
            state.activated = true;
            targetWindow.removeEventListener("pagehide", send);
            if (timer !== undefined) clearTimeout(timer);
            if (nativeFetch) {
                try { void nR.apply(nativeFetch, targetWindow, [url, fetchInit]).catch(() => undefined); } catch { /* as a lost beacon */ }
            }
        };
        targetWindow.addEventListener("pagehide", send);
        if (typeof init?.activateAfter === "number") timer = setTimeout(send, init.activateAfter);
        signal?.addEventListener("abort", () => {
            targetWindow.removeEventListener("pagehide", send);
            if (timer !== undefined) clearTimeout(timer);
        });
        return result;
    };

    wrapMethod<(...a: unknown[]) => unknown>(targetWindow, "fetchLater", (native, self, args) => {
        if (!args.length || isRequest(args[0])) return nR.apply(native, self, args);
        const raw = String(args[0]);
        if (refusedAsIs(raw)) return nR.apply(native, self, args);
        const init = (typeof args[1] === "object" && args[1] !== null ? args[1] : undefined) as Init | undefined;
        let original: URL;
        try { original = new URL(raw, baseUrl()); } catch { return nR.apply(native, self, args); }
        // An insecure original URL is refused as natively (a TLS proxy would
        // make its proxied URL secure). Loopback hosts are trustworthy.
        if (original.protocol === "http:" && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$|\.localhost$/i.test(original.hostname)) {
            throw new w.DOMException("Failed to execute 'fetchLater' on 'Window': fetchLater was passed an insecure URL.", "SecurityError");
        }
        // The native's own argument errors (a negative activateAfter, …) as
        // natively; only a request it would accept is counted.
        let size: number | null = null;
        if (original.protocol === "https:" && !(typeof init?.activateAfter === "number" && init.activateAfter < 0)) {
            size = deferredSize(original, init, w.Headers);
        }
        const next = [rewriteOne(raw), ...args.slice(1)];
        if (size === null) return nR.apply(native, self, next);
        const before = used.get(original.origin) ?? 0;
        if (before + size > PER_ORIGIN) throw quotaError(size, PER_ORIGIN - before);
        let result: unknown;
        try {
            result = nR.apply(native, self, next);
        } catch (e) {
            if (!proxysRefusal(e, next[0] as string)) throw e;
            result = defer(next[0] as string, init); // the proxy's refusal, not the page's
        }
        used.set(original.origin, before + size);
        return result;
    });
}
