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
//
// patchAnchorUrlReflection (below) extends this to fix the reflected URL-part
// properties (host, hostname, protocol, etc.) on anchor and area elements.
// It MUST be called before patchUrlAttributes so it can capture the native
// href getter/setter before we wrap them.

import { rewriteSrcsetAttribute } from "./srcset";
import { URL_BEARING_ELEMENTS } from "./url-attribute-map";

type ProtoLike = { prototype: object };

export function patchUrlAttributes(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string = (u) => u,
): void {
    const globals = globalThis as unknown as Record<string, ProtoLike | undefined>;
    for (const { ctorName, attrs, idlNames } of URL_BEARING_ELEMENTS) {
        const Constructor = globals[ctorName];
        if (!Constructor?.prototype) continue;
        for (const attribute of attrs) {
            // srcset is a multi-URL value; unwrapping each entry is complex
            // and not needed for the publicPath-detection fix, so we only
            // unwrap single-URL attributes.
            patchAttribute(
                Constructor.prototype,
                attribute,
                idlNames?.[attribute] ?? attribute,
                rewriteOne,
                attribute === "srcset" ? undefined : unwrapOne,
            );
        }
    }
}

/**
 * Patches the reflected URL-part properties on HTMLAnchorElement and
 * HTMLAreaElement so they read and write values derived from the *upstream* URL
 * rather than the proxified URL our href setter stores.
 *
 * A common pattern for URL decomposition is:
 *   var a = document.createElement("a");
 *   a.href = someUrl;           // our setter runs, proxifies the value
 *   var host = a.host;          // without this patch: returns proxy host!
 *
 * We intercept each getter and setter, read the raw stored href via the native
 * getter (before our href-rewrite patch), unwrap it to the original URL, then
 * delegate to URL to extract or modify the requested component.
 *
 * MUST be called before patchUrlAttributes — it captures the native href
 * getter/setter; if patchUrlAttributes has already wrapped them, we'd be
 * operating on already-processed values.
 */
export function patchAnchorUrlReflection(
    unwrapOne: (url: string) => string,
    rewriteOne: (url: string) => string,
): void {
    for (const ctorName of ["HTMLAnchorElement", "HTMLAreaElement"]) {
        const ctor = (globalThis as unknown as Record<string, { prototype: object } | undefined>)[ctorName];
        if (!ctor?.prototype) continue;
        patchReflectedUrlProps(ctor.prototype, unwrapOne, rewriteOne);
    }
}

// Mutable URL-part properties that anchor/area elements reflect from their href.
const REFLECTED_URL_PROPS_RW = [
    "protocol", "host", "hostname", "port",
    "pathname", "search", "hash", "username", "password",
] as const;

// origin is read-only on the URL interface — no setter to wrap.
const REFLECTED_URL_PROPS_RO = ["origin"] as const;

function patchReflectedUrlProps(
    prototype: object,
    unwrapOne: (url: string) => string,
    rewriteOne: (url: string) => string,
): void {
    const hrefDesc = Object.getOwnPropertyDescriptor(prototype, "href");
    if (!hrefDesc?.get || !hrefDesc?.set) return;
    // Capture BEFORE patchUrlAttributes wraps them — we need the native
    // getter/setter to read/write the raw proxified href on the DOM node.
    const nativeHrefGet = hrefDesc.get;
    const nativeHrefSet = hrefDesc.set;

    const roSet = new Set<string>(REFLECTED_URL_PROPS_RO);
    for (const prop of [...REFLECTED_URL_PROPS_RW, ...REFLECTED_URL_PROPS_RO]) {
        const desc = Object.getOwnPropertyDescriptor(prototype, prop);
        if (!desc?.get) continue;
        const nativeGet = desc.get;
        const nativeSet = desc.set;

        const propDescriptor: PropertyDescriptor = {
            configurable: true,
            enumerable: desc.enumerable ?? false,
            get(): unknown {
                const rawHref = nativeHrefGet.call(this) as string;
                if (!rawHref) return nativeGet.call(this);
                const unwrapped = unwrapOne(rawHref);
                // If unwrap was a no-op (URL isn't a proxy URL) fall through.
                if (unwrapped === rawHref) return nativeGet.call(this);
                try {
                    return new URL(unwrapped)[prop] as unknown;
                } catch {
                    return nativeGet.call(this);
                }
            },
        };

        if (nativeSet && !roSet.has(prop)) {
            // Setter: modify the upstream URL component, then re-proxify and
            // write back via the native href setter.
            propDescriptor.set = function(value: unknown): void {
                const rawHref = nativeHrefGet.call(this) as string;
                if (!rawHref) { nativeSet.call(this, value); return; }
                const unwrapped = unwrapOne(rawHref);
                if (unwrapped === rawHref) {
                    // Not a proxified URL — delegate to native setter directly.
                    nativeSet.call(this, value);
                    return;
                }
                try {
                    const u = new URL(unwrapped);
                    (u as unknown as Record<string, unknown>)[prop] = value;
                    nativeHrefSet.call(this, rewriteOne(u.href));
                } catch {
                    nativeSet.call(this, value);
                }
            };
        } else if (nativeSet) {
            propDescriptor.set = nativeSet;
        }

        Object.defineProperty(prototype, prop, propDescriptor);
    }
}

function patchAttribute(
    prototype: object,
    attribute: string,
    idlAttr: string,
    rewriteOne: (url: string) => string,
    unwrapOne: ((url: string) => string) | undefined,
): void {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, idlAttr);
    if (!descriptor?.set || !descriptor?.get) return;
    const originalSet = descriptor.set;
    const originalGet = descriptor.get;

    Object.defineProperty(prototype, idlAttr, {
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
            // null/undefined clear the attribute — pass through verbatim.
            // TrustedTypes objects (TrustedScriptURL, TrustedHTML, etc.) coerce
            // to their wrapped URL string via String(); pass them through the
            // rewrite path so GTM/GTags can't escape URL containment by handing
            // the setter a TrustedScriptURL instead of a plain string.
            if (value == null) {
                originalSet.call(this, value);
                return;
            }
            const strValue = typeof value === "string" ? value : String(value);
            if (attribute === "srcset") {
                originalSet.call(this, rewriteSrcsetAttribute(strValue, rewriteOne));
            } else {
                originalSet.call(this, rewriteOne(strValue));
            }
        },
    });
}
