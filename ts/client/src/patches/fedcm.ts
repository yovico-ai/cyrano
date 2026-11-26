// FedCM (navigator.credentials.get({identity})) cannot go through the
// proxy: the browser itself fetches the identity provider's well-known
// file, config and account list — outside any page, straight to the
// provider, naming the proxy's origin as the relying party. It could not
// work (the provider does not know that origin) and it tells the provider
// where the user is.
//
// Such a request is answered the way Chrome answers when the user has
// turned third-party sign-in off in its settings: the promise rejects with
// a NetworkError, and the site falls back to its redirect or popup
// sign-in (Google Identity Services does). Everything else about
// navigator.credentials is the browser's.

import { stacked } from "../native/stacked";
import { nR } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";

/** About Chrome's round trips to the provider before it rejects (well-known file, config, accounts). */
export const FEDCM_REJECT_MS = 400;

export function patchFedCM(targetWindow: Window): void {
    const g = targetWindow as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const C = g["CredentialsContainer"]?.prototype as object | undefined;
    if (!C || !("get" in C)) return;
    const setTimer = g["setTimeout"] as typeof setTimeout; // the native's, saved: no page hook sees it
    wrapMethod<(...a: unknown[]) => unknown>(C, "get", (native, self, args) => {
        let identity: unknown;
        try { identity = (args[0] as { identity?: unknown } | undefined)?.identity; } catch { identity = undefined; }
        if (identity === undefined || identity === null) return nR.apply(native, self, args);
        const DE = g["DOMException"] as typeof DOMException;
        const P = g["Promise"] as PromiseConstructor;
        const err = stacked(new DE("Error retrieving a token.", "NetworkError"));
        // Chrome rejects after fetching the provider's well-known file,
        // config and accounts list (a few hundred ms), not at once: GSI's
        // button installs what its rejection handler reads after calling
        // get() (abide.com threw "reading 'P'" twice). A timer, no request:
        // the page sees no fetch of ours (none in its resource timing).
        return new P((_ok, reject) => { nR.apply(setTimer, targetWindow, [() => reject(err), FEDCM_REJECT_MS]); });
    });
}
