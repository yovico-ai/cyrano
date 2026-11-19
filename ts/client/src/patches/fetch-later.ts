// fetchLater(input, init), as page code sees it natively.
//
// The browser keeps a deferred-fetch quota per destination origin (64 KiB:
// the URL without its fragment, every header-list entry, the body, and 12
// bytes more — spec/FetchLater.agda, checked against Chromium). Under the proxy every
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

import { SafeMap, SafeWeakMap, nO, nR, ncall, sStarts } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";

const PER_ORIGIN = 65536;
const OVERHEAD = 12;

type Init = RequestInit & { activateAfter?: number };

const isHttpSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;

/** A header value as the header list holds it (leading and trailing HTTP whitespace removed). */
function trimHttp(v: string): string {
    let a = 0;
    let b = v.length;
    while (a < b && isHttpSpace(v.charCodeAt(a))) a++;
    while (b > a && isHttpSpace(v.charCodeAt(b - 1))) b--;
    return v.slice(a, b);
}

const CONTENT_TYPE = "content-type";
function isContentType(k: string): boolean {
    if (k.length !== CONTENT_TYPE.length) return false;
    for (let i = 0; i < k.length; i++) {
        const c = k.charCodeAt(i);
        if ((c >= 65 && c <= 90 ? c + 32 : c) !== CONTENT_TYPE.charCodeAt(i)) return false;
    }
    return true;
}

/**
 * The request's header list: one entry per header given (Chromium counts a
 * name given twice twice). A Headers object only shows its entries
 * combined — counted so (a gap: duplicates there count ", " instead).
 */
function headerList(given: HeadersInit | undefined, H: typeof Headers): [string, string][] {
    const out: [string, string][] = [];
    if (given === undefined || given === null) return out;
    if (given instanceof H || !(nO.getPrototypeOf(given) === Array.prototype || nO.getPrototypeOf(given) === Object.prototype || nO.getPrototypeOf(given) === null)) {
        new H(given).forEach((v, k) => { out[out.length] = [k, v]; });
        return out;
    }
    if (nO.getPrototypeOf(given) === Array.prototype) {
        const a = given as [string, string][];
        for (let i = 0; i < a.length; i++) out[out.length] = [String(a[i]![0]), trimHttp(String(a[i]![1]))];
        return out;
    }
    const keys = nO.keys(given);
    for (let i = 0; i < keys.length; i++) out[out.length] = [keys[i]!, trimHttp(String((given as Record<string, string>)[keys[i]!]))];
    return out;
}

/** The bytes a deferred request counts against its origin's quota, or null when not known here (spec/FetchLater.agda deferredSize). */
export function deferredSize(url: URL, init: Init | undefined, H: typeof Headers): number | null | "unknown-length" {
    const body = init?.body;
    let bodySize = 0;
    let contentType: string | null = null;
    if (body === undefined || body === null) {
        bodySize = 0;
    } else if (typeof body === "string") {
        bodySize = body.length; // UTF-16 code units, as Chromium counts it
        contentType = "text/plain;charset=UTF-8";
    } else if (body instanceof URLSearchParams) {
        bodySize = body.toString().length; // ASCII
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
    if (body !== undefined && body !== null && bodySize === 0) return "unknown-length"; // refused natively, a TypeError
    let headerSize = 0;
    let hasType = false;
    try {
        new H(init?.headers); // the native throws its own error
        const list = headerList(init?.headers, H);
        for (let i = 0; i < list.length; i++) {
            const [k, v] = list[i]!;
            headerSize += k.length + v.length;
            if (isContentType(k)) hasType = true;
        }
    } catch {
        return null;
    }
    if (contentType !== null && !hasType) headerSize += "content-type".length + contentType.length;
    const u = new URL(url.href);
    u.hash = "";
    return u.href.length + headerSize + bodySize + OVERHEAD;
}

/** The QuotaExceededError message for a request of `size` with `used` deferred to its origin, or null: admitted (spec/FetchLater.agda admit). */
export function quotaRefusal(used: number, size: number): string | null {
    if (used + size <= PER_ORIGIN) return null;
    return `Failed to execute 'fetchLater' on 'Window': fetchLater exceeds its quota for the origin: got ${size} bytes, expected less than ${PER_ORIGIN - used} bytes.`;
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
    const quotaError = (msg: string): Error =>
        w.QuotaExceededError ? new w.QuotaExceededError(msg) : new w.DOMException(msg, "QuotaExceededError");
    // The native's refusals that are the proxy's doing: the proxy origin's
    // shared quota; and, on a plain-http proxy, the proxied URL being
    // insecure ("only supported over HTTPS", a TypeError — counted as the
    // proxy's only when the proxied URL is http: for an https original).
    const proxysRefusal = (e: unknown, proxied: string): boolean => {
        const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
        return name === "QuotaExceededError" || name === "SecurityError" ||
            (name === "TypeError" && sStarts(proxied, "http:"));
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
        let size: number | null | "unknown-length" = null;
        if (original.protocol === "https:" && !(typeof init?.activateAfter === "number" && init.activateAfter < 0)) {
            size = deferredSize(original, init, w.Headers);
        }
        // The native would say so too, but under a plain-http proxy its
        // TypeError reads as the proxy's refusal.
        if (size === "unknown-length") throw new (targetWindow as unknown as { TypeError: typeof TypeError }).TypeError("Failed to execute 'fetchLater' on 'Window': fetchLater doesn't support body with unknown length.");
        const next = [rewriteOne(raw), ...args.slice(1)];
        if (size === null) return nR.apply(native, self, next);
        const before = used.get(original.origin) ?? 0;
        const refused = quotaRefusal(before, size);
        if (refused !== null) throw quotaError(refused);
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
