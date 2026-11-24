// setTimeout / setInterval given code as a string (or anything not
// callable: converted once, as the native converts it — ToString, a
// TrustedScript kept trusted): the code is rewritten as global code, as an
// indirect eval's is, before the native compiles it. It read the proxy's
// location, and what it navigated went to the navigation net only (round
// J). Windows and workers. Under Trusted Types a page's plain string is a
// string still (the native's default policy sees the rewritten text: the
// gap eval has too).

import { nO, nR } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";
import { isTrustedValue, trusted } from "../native/trusted";
import { rewriteJsSource } from "../js/rewriter";
import { madeCodeOptions } from "../js/made-code";

export function patchTimers(scope: object): void {
    for (const name of ["setTimeout", "setInterval"]) {
        let holder: object | null = scope;
        while (holder && !nO.getOwnPropertyDescriptor(holder, name)) holder = nO.getPrototypeOf(holder) as object | null;
        if (!holder || typeof nO.getOwnPropertyDescriptor(holder, name)?.value !== "function") continue;
        wrapMethod<(...a: unknown[]) => unknown>(holder, name, (native, self, args) => {
            // (a Symbol: the native's own TypeError, its message the binding's)
            if (!args.length || typeof args[0] === "function" || typeof args[0] === "symbol") return nR.apply(native, self, args);
            const h = args[0];
            const wasTrusted = isTrustedValue(h);
            const text = wasTrusted ? String(h) : `${h as string}`;
            const code = rewriteJsSource(text, madeCodeOptions(scope, text));
            return nR.apply(native, self, [wasTrusted ? trusted(scope, "Script", code) : code, ...args.slice(1)]);
        });
    }
}
