// Patch the `WebSocket` constructor so dynamic WS connections go through the
// proxy.
//
// We can't subclass WebSocket — its constructor must be invoked with `new`
// and produces native handles that browsers special-case. Instead we replace
// the global with a function that delegates to the native ctor with a
// rewritten URL, then preserve the prototype + static class constants.

import { getGlobal, setGlobal } from "./globals";

interface WebSocketConstants {
    CONNECTING: number;
    OPEN: number;
    CLOSING: number;
    CLOSED: number;
}

type WebSocketCtor = new (
    url: string | URL,
    protocols?: string | string[],
) => WebSocket;

export function patchWebSocket(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
): void {
    const NativeWebSocket = getGlobal<WebSocketCtor & WebSocketConstants>("WebSocket");
    if (!NativeWebSocket) return;
    const Native = NativeWebSocket;

    function PatchedWebSocket(
        this: unknown,
        url: string | URL,
        protocols?: string | string[],
    ): WebSocket {
        const rawUrl = typeof url === "string" ? url : url.href;
        return new Native(rewriteOne(rawUrl), protocols);
    }
    PatchedWebSocket.prototype = Native.prototype;
    Object.assign(PatchedWebSocket, {
        CONNECTING: Native.CONNECTING,
        OPEN: Native.OPEN,
        CLOSING: Native.CLOSING,
        CLOSED: Native.CLOSED,
    });

    setGlobal("WebSocket", PatchedWebSocket);

    const urlDesc = Object.getOwnPropertyDescriptor(Native.prototype, "url");
    if (urlDesc?.get) {
        const nativeGet = urlDesc.get;
        Object.defineProperty(Native.prototype, "url", {
            ...urlDesc,
            get(): string {
                return unwrapOne(nativeGet.call(this) as string);
            },
        });
    }
}
