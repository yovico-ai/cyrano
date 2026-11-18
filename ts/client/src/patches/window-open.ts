// window.open(url, target, features), as page code sees it natively; only a
// given, non-empty URL is proxified (rewriteUrl itself leaves about:,
// javascript:, blob:, data: … as written).

import { crossOriginView } from "../native/cross-origin";
import { wrapMethod } from "../native/surface";

export function patchWindowOpen(targetWindow: Window, rewriteOne: (url: string) => string): void {
    wrapMethod<(...a: unknown[]) => Window | null>(targetWindow, "open", (native, self, args) => {
        // The opened window is another window: cross-origin, it is a view.
        if (!args.length || args[0] == null || String(args[0]) === "") return crossOriginView(Reflect.apply(native, self, args) as Window | null, null, targetWindow);
        return crossOriginView(Reflect.apply(native, self, [rewriteOne(String(args[0])), ...args.slice(1)]) as Window | null, null, targetWindow);
    });
}
