// Translates event.origin on incoming MessageEvents from proxied frames.
//
// Problem: all proxied frames share the same browser origin (the proxy origin,
// e.g. "http://localhost:9081"). When a proxied iframe posts a message to its
// parent, the browser stamps event.origin = "http://localhost:9081". Page code
// that guards on event.origin (e.g. reCAPTCHA checking for "https://www.google.com")
// silently rejects every message.
//
// patchPostMessage (post-message.ts) already translates the SENDING side —
// targetOrigin is rewritten from the upstream value to the proxy origin so
// the browser delivers the message. This patch closes the other half: it
// intercepts addEventListener('message', …) and presents handlers with a
// synthetic event whose .origin is the upstream origin of the sender,
// read from event.source.$rewriter.get_base_url() (the location patch installs
// an own-property getter on the window instance that returns a virtual upstream
// URL, so event.source.location can't be unwrapped to find the proxy URL).

import type { ClientConfig } from "../config";
import { unwrapProxiedUrl } from "../url/containment";

// Maps original handler → wrapped handler so removeEventListener keeps working.
const wrappedHandlers = new WeakMap<
    EventListenerOrEventListenerObject,
    EventListenerOrEventListenerObject
>();

type WindowGlobals = Record<string, { prototype: Record<string, unknown> } | undefined>;

export function patchMessageEventOrigin(
    targetWindow: Window,
    config: ClientConfig,
): void {
    const proxyOrigin = new URL(config.apiBaseURL).origin;
    const globals = targetWindow as unknown as WindowGlobals;
    const TargetWindow = globals["Window"];
    if (!TargetWindow?.prototype) return;

    const proto = TargetWindow.prototype;
    const origAEL = proto["addEventListener"] as typeof EventTarget.prototype.addEventListener;
    const origREL = proto["removeEventListener"] as typeof EventTarget.prototype.removeEventListener;
    if (typeof origAEL !== "function") return;

    proto["addEventListener"] = function patchedAddEventListener(
        this: EventTarget,
        type: string,
        handler: EventListenerOrEventListenerObject | null,
        opts?: AddEventListenerOptions | boolean,
    ): void {
        if (type === "message" && handler != null) {
            const wrapped = makeWrappedHandler(handler, proxyOrigin, config);
            wrappedHandlers.set(handler, wrapped);
            return origAEL.call(this, type, wrapped, opts);
        }
        return origAEL.call(this, type, handler, opts);
    };

    if (typeof origREL === "function") {
        proto["removeEventListener"] = function patchedRemoveEventListener(
            this: EventTarget,
            type: string,
            handler: EventListenerOrEventListenerObject | null,
            opts?: EventListenerOptions | boolean,
        ): void {
            if (type === "message" && handler != null) {
                const wrapped = wrappedHandlers.get(handler) ?? handler;
                wrappedHandlers.delete(handler);
                return origREL.call(this, type, wrapped, opts);
            }
            return origREL.call(this, type, handler, opts);
        };
    }
}

function makeWrappedHandler(
    handler: EventListenerOrEventListenerObject,
    proxyOrigin: string,
    config: ClientConfig,
): EventListenerOrEventListenerObject {
    const fn: EventListener =
        typeof handler === "function" ? handler : (e) => (handler as EventListenerObject).handleEvent(e);

    return function wrappedMessageHandler(this: unknown, event: Event): unknown {
        const msg = event as MessageEvent;
        if (msg.origin === proxyOrigin && msg.source != null) {
            const upstreamOrigin = upstreamOriginOf(msg.source, config);
            if (upstreamOrigin) {
                // Present the handler with a view where .origin is the upstream value.
                const translated = new Proxy(msg, {
                    get(target, prop: string | symbol) {
                        if (prop === "origin") return upstreamOrigin;
                        const val = Reflect.get(target, prop, target);
                        return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
                    },
                });
                return fn.call(this, translated as MessageEvent);
            }
        }
        return fn.call(this, event);
    } as EventListener;
}

// Exported for unit testing only.
export function upstreamOriginOf(source: Window, config: ClientConfig): string | null {
    try {
        // source.location reads the own-property getter the location patch installs
        // on each window instance, returning a virtual upstream URL, not the real
        // proxy URL — so unwrapProxiedUrl can't identify it as proxified.
        // Read the virtual origin directly from $rewriter.get_base_url() instead.
        type RewriterApi = { get_base_url?: () => URL | null };
        const sourceRewriter = (source as unknown as { $rewriter?: RewriterApi }).$rewriter;
        if (sourceRewriter && typeof sourceRewriter.get_base_url === "function") {
            const base = sourceRewriter.get_base_url();
            if (base) return base.origin;
        }
        // Fallback: source window isn't proxied — try unwrapping its real proxy URL.
        // location is patched as an own property on the instance; call the prototype
        // getter directly to get the real URL, then unwrap it.
        const realHref = Object.getOwnPropertyDescriptor(Window.prototype, "location")
            ?.get?.call(source) as Location | undefined;
        if (!realHref) return null;
        const upstream = unwrapProxiedUrl(realHref.href, config);
        if (upstream === realHref.href) return null;
        return new URL(upstream).origin;
    } catch {
        return null;
    }
}
