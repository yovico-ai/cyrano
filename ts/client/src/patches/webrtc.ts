// WebRTC through cyrano's relay (spec/WebRtc.agda; Go internal/turn).
// Directly a peer connection gathers host and server-reflexive candidates:
// STUN to the page's servers and media straight from the browser — the one
// traffic class that left the proxy and showed the user's address. Every
// peer connection now uses only cyrano's TURN server.
//
// The page's configuration goes to the native first, as given (its
// validation, its errors, its normalization), and then — synchronously,
// before any gathering task runs — the native is given the relay in its
// place (iceServers, iceTransportPolicy "relay"; setConfiguration may
// change those two before negotiation). getConfiguration reads the native's
// with the page's own two members back (toNative / shown, proved there).
// With no relay configured the native gets none: relay only, nothing
// gathered — the page's servers are never contacted.
//
// Known, inherent: only relay candidates; the candidates and getStats name
// the relay's address.

import { SafeWeakMap, nO, nR, ncall } from "../native/intrinsics";
import { replaceValue, wrapConstructor, wrapMethod } from "../native/surface";
import type { ClientConfig } from "../config";

type Cfg = Record<string, unknown>;

/** spec WebRtc.toNative: the native's configuration for one the page gave (normalized). */
export function toNative(page: Cfg, relay: ClientConfig["rtc"]): Cfg {
    return { ...page, iceServers: relay ? [{ urls: relay.urls, username: relay.username, credential: relay.credential }] : [], iceTransportPolicy: "relay" };
}

/** spec WebRtc.shown: what the page reads — the native's, with the page's servers and policy. */
export function shown(page: Cfg, native: Cfg): Cfg {
    return { ...native, iceServers: page["iceServers"], iceTransportPolicy: page["iceTransportPolicy"] };
}

export function patchWebRtc(targetWindow: Window, relay: () => ClientConfig["rtc"]): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const PC = g["RTCPeerConnection"]?.prototype;
    if (!PC) return;
    const nGet = nO.getOwnPropertyDescriptor(PC, "getConfiguration")?.value as ((this: unknown) => Cfg) | undefined;
    const nSet = nO.getOwnPropertyDescriptor(PC, "setConfiguration")?.value as ((this: unknown, c?: unknown) => void) | undefined;
    if (!nGet || !nSet) return;
    const pages = new SafeWeakMap<object, Cfg>(); // a connection → the page's configuration, normalized
    // The page's configuration is in place (validated, normalized by the
    // native): it is noted, and the relay given in its place.
    const takeOver = (pc: object): void => {
        const page = ncall(nGet, pc) as Cfg;
        pages.set(pc, page);
        ncall(nSet, pc, toNative(page, relay()));
    };
    const original = g["RTCPeerConnection"] as unknown;
    wrapConstructor<new (...a: unknown[]) => object>(targetWindow, "RTCPeerConnection", (Native, args, newTarget) => {
        const pc = nR.construct(Native, args, newTarget as never) as object;
        try { takeOver(pc); } catch { try { pc && (pc as { close?: () => void }).close?.(); } catch { /* closed */ } throw new TypeError("RTCPeerConnection: no relay"); }
        return pc;
    });
    // The legacy alias is the same native: it is the wrapper too.
    try {
        const w = targetWindow as unknown as Record<string, unknown>;
        if (w["webkitRTCPeerConnection"] === original) replaceValue(targetWindow, "webkitRTCPeerConnection", w["RTCPeerConnection"]);
    } catch { /* none */ }
    wrapMethod<(...a: unknown[]) => unknown>(PC, "getConfiguration", (native, self, args) => {
        const now = nR.apply(native, self, args) as Cfg;
        const page = typeof self === "object" && self !== null ? pages.get(self) : undefined;
        return page ? shown(page, now) : now;
    });
    wrapMethod<(...a: unknown[]) => unknown>(PC, "setConfiguration", (native, self, args) => {
        // The page's, to the native first (its errors are the native's), then the relay again.
        nR.apply(native, self, args);
        if (typeof self === "object" && self !== null) takeOver(self);
        return undefined;
    });
}
