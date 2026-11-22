// The Payment Request API (spec/Payment.agda). For a URL-based payment
// method ("https://google.com/pay") Chrome itself fetches the method's
// manifest and payment app when the PaymentRequest is constructed —
// outside any page, straight to the provider (Stripe's Google Pay frames
// fetched gstatic's transparent_square.svg off the proxy). It could not
// work proxied either: the payment's origin would be the proxy's.
//
// Such a method is answered as one with no payment app, as FedCM is
// refused (fedcm.ts): the request is constructed with an identifier Chrome
// cannot resolve in its place, so nothing is fetched; canMakePayment()
// answers false and show() rejects with NotSupportedError, its message
// naming the page's identifier. Known difference: directly, Chrome answers
// canMakePayment() true for Google Pay (its app installs just in time).

import { SafeWeakMap, nO, nR, ncall } from "../native/intrinsics";
import { wrapConstructor, wrapMethod } from "../native/surface";

/** spec Payment.refused: an absolute https: URL, a URL-based payment method identifier. */
export function refusedMethod(id: string): boolean {
    try { return new URL(id).protocol === "https:"; } catch { return false; }
}

// A standardized identifier no app answers (Chromium's format: lowercase
// parts of letters then digits, joined by "-"): its index in letters.
const PLACEHOLDER = "crn-no-app-";
const letters = (i: number): string => { let s = ""; do { s = String.fromCharCode(97 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0); return s; };
const indexOf = (l: string): number => { let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 96); return n - 1; };

export function patchPaymentRequest(targetWindow: Window): void {
    const g = targetWindow as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const PR = g["PaymentRequest"] as unknown;
    if (typeof PR !== "function") return;
    const ids = new SafeWeakMap<object, string[]>(); // a request → the page's identifiers in place of the placeholders

    wrapConstructor(targetWindow as unknown as object, "PaymentRequest", (native, args, newTarget) => {
        const next = args.slice();
        const methods = next[0];
        const replaced: string[] = [];
        if (Array.isArray(methods)) {
            next[0] = methods.map((m: unknown) => {
                if (typeof m !== "object" || m === null) return m;
                // The page's dictionary read through a Proxy: each member once, in the native's order.
                return new Proxy(m as object, {
                    get: (t, k, r) => {
                        const v = nR.get(t, k, r);
                        if (k !== "supportedMethods" || v === undefined) return v;
                        const s = String(v);
                        if (!refusedMethod(s)) return s;
                        replaced.push(s);
                        return PLACEHOLDER + letters(replaced.length - 1);
                    },
                });
            });
        }
        const req = nR.construct(native as unknown as new (...a: unknown[]) => object, next, newTarget as never) as object;
        if (replaced.length) ids.set(req, replaced);
        return req;
    });

    // A refusal names the page's identifier, not the placeholder.
    const P = (PR as { prototype: object }).prototype;
    const DE = g["DOMException"] as (new (m: string, n: string) => Error) | undefined;
    const named = (self: unknown, e: unknown): unknown => {
        const list = typeof self === "object" && self !== null ? ids.get(self) : undefined;
        const m = (e as { message?: unknown } | null)?.message;
        if (!list || !DE || typeof m !== "string" || m.indexOf(PLACEHOLDER) < 0) return e;
        return new DE(m.replace(/crn-no-app-([a-z]+)/g, (_x, l: string) => list[indexOf(l)] ?? _x), String((e as { name?: unknown }).name));
    };
    for (const k of ["show", "canMakePayment", "hasEnrolledInstrument"]) {
        if (typeof nO.getOwnPropertyDescriptor(P, k)?.value !== "function") continue;
        wrapMethod<(...a: unknown[]) => unknown>(P, k, (native, self, a) => {
            const r = nR.apply(native, self, a) as Promise<unknown>;
            if (!(typeof self === "object" && self !== null && ids.get(self))) return r;
            return ncall(nO.getPrototypeOf(r).then as (this: Promise<unknown>, f: unknown, g: unknown) => Promise<unknown>, r, undefined, (e: unknown) => { throw named(self, e); });
        });
    }
}
