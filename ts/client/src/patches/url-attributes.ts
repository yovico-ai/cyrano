// Patch the URL-bearing attribute setters on HTML element prototypes.
//
// The server-side HTML rewriter rewrites attributes in the *source* HTML, but
// it can't catch later mutations made by JS:
//   img.src = computeUrl();
//   anchor.href = `/p/${slug}`;
// Hooking into the prototype's setter for each known URL-bearing attribute
// lets us intercept these dynamic assignments and rewrite the value before
// it lands on the live DOM node.
//
// Each entry below is `[ConstructorName, [attribute names...]]`. We probe
// each constructor on globalThis at install time — missing ones (in headless
// envs or older browsers) are silently skipped.

import { rewriteSrcsetAttribute } from "./srcset";
import { URL_BEARING_ELEMENTS } from "./url-attribute-map";

type ProtoLike = { prototype: object };

export function patchUrlAttributes(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string = (u) => u,
): void {
    const globals = globalThis as unknown as Record<string, ProtoLike | undefined>;
    for (const { ctorName, attrs } of URL_BEARING_ELEMENTS) {
        const Constructor = globals[ctorName];
        if (!Constructor?.prototype) continue;
        for (const attribute of attrs) {
            // srcset is a multi-URL value; unwrapping each entry is complex
            // and not needed for the publicPath-detection fix, so we only
            // unwrap single-URL attributes.
            patchAttribute(
                Constructor.prototype,
                attribute,
                rewriteOne,
                attribute === "srcset" ? undefined : unwrapOne,
            );
        }
    }
}

function patchAttribute(
    prototype: object,
    attribute: string,
    rewriteOne: (url: string) => string,
    unwrapOne: ((url: string) => string) | undefined,
): void {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, attribute);
    if (!descriptor?.set || !descriptor?.get) return;
    const originalSet = descriptor.set;
    const originalGet = descriptor.get;

    Object.defineProperty(prototype, attribute, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get(): unknown {
            const raw = originalGet.call(this) as unknown;
            // Unwrap so page code (e.g. webpack reading document.currentScript.src
            // to auto-detect publicPath) sees the original URL, not the proxy URL.
            if (unwrapOne && typeof raw === "string") return unwrapOne(raw);
            return raw;
        },
        set(value: unknown): void {
            // Only rewrite when the assigned value is a string. Some sites
            // null out attributes; pass non-strings through verbatim.
            if (typeof value !== "string") {
                originalSet.call(this, value);
                return;
            }
            if (attribute === "srcset") {
                originalSet.call(this, rewriteSrcsetAttribute(value, rewriteOne));
            } else {
                originalSet.call(this, rewriteOne(value));
            }
        },
    });
}
