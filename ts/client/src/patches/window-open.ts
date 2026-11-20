// window.open(url, target, features), as page code sees it natively; only a
// given, non-empty URL is proxified (rewriteUrl itself leaves about:,
// javascript:, blob:, data: … as written). The features' attributionsrc
// URLs, which the browser requests itself, are proxified in place
// (spec/Features.agda); the rest of the string is passed as written.

import { nR } from "../native/intrinsics";
import { crossOriginView } from "../native/cross-origin";
import { wrapMethod } from "../native/surface";
import { decodeSource, mapSources } from "../url/features";

export function patchWindowOpen(targetWindow: Window, rewriteOne: (url: string) => string): void {
    wrapMethod<(...a: unknown[]) => Window | null>(targetWindow, "open", (native, self, a) => {
        let args = a;
        if (typeof args[2] === "string" && args[2] !== "") {
            const features = mapSources(args[2], (v) => encodeURIComponent(rewriteOne(decodeSource(v))));
            if (features !== args[2]) args = [args[0], args[1], features, ...args.slice(3)];
        }
        // The opened window is another window: cross-origin, it is a view.
        if (!args.length || args[0] == null || String(args[0]) === "") return crossOriginView(nR.apply(native, self, args) as Window | null, null, targetWindow);
        return crossOriginView(nR.apply(native, self, [rewriteOne(String(args[0])), ...args.slice(1)]) as Window | null, null, targetWindow);
    });
}
