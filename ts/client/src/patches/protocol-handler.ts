// navigator.registerProtocolHandler / unregisterProtocolHandler (round K):
// the native judges the handler URL against the document's origin — the
// proxy's — so the page's own absolute URL threw SecurityError. A URL of
// the page's original origin is handed over proxified (its `%s` kept
// where it is); one of another origin goes to the native as given, which
// throws as directly. (A handler registered so is the proxy origin's:
// every proxied site shares it — the browser keeps one list per origin.)

import { nR } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";

const HOLE = "crn0s0hole";

export function patchProtocolHandlers(targetWindow: Window, rewriteOne: (url: string) => string, baseUrl: () => URL): void {
    const N = (targetWindow as unknown as { Navigator?: { prototype: object } }).Navigator?.prototype as Record<string, unknown> | undefined;
    if (!N) return;
    for (const key of ["registerProtocolHandler", "unregisterProtocolHandler"]) {
        if (typeof N[key] !== "function") continue;
        wrapMethod<(...a: unknown[]) => unknown>(N, key, (native, self, args) => {
            if (args.length < 2) return nR.apply(native, self, args);
            const given = String(args[1]);
            let u: URL;
            try { u = new URL(given.split("%s").join(HOLE), baseUrl()); } catch { return nR.apply(native, self, args); }
            if (u.origin !== baseUrl().origin) return nR.apply(native, self, args);
            const proxied = rewriteOne(u.href).split(HOLE).join("%s");
            return nR.apply(native, self, [args[0], proxied, ...args.slice(2)]);
        });
    }
}
