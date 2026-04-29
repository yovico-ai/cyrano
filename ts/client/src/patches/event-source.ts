// Patch the `EventSource` constructor (Server-Sent Events) so dynamic SSE
// connections go through the proxy.
//
// Same shape as the WebSocket patch — replace the global with a delegating
// function, preserve prototype + static class constants.

import { getGlobal, setGlobal } from "./globals";

interface EventSourceConstants {
    CONNECTING: number;
    OPEN: number;
    CLOSED: number;
}

type EventSourceCtor = new (
    url: string | URL,
    init?: EventSourceInit,
) => EventSource;

export function patchEventSource(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    const NativeEventSource = getGlobal<EventSourceCtor & EventSourceConstants>("EventSource");
    if (!NativeEventSource) return;
    const Native = NativeEventSource;

    function PatchedEventSource(
        this: unknown,
        url: string | URL,
        init?: EventSourceInit,
    ): EventSource {
        const rawUrl = typeof url === "string" ? url : url.href;
        return new Native(rewriteOne(rawUrl), init);
    }
    PatchedEventSource.prototype = Native.prototype;
    Object.assign(PatchedEventSource, {
        CONNECTING: Native.CONNECTING,
        OPEN: Native.OPEN,
        CLOSED: Native.CLOSED,
    });

    setGlobal("EventSource", PatchedEventSource);
}
