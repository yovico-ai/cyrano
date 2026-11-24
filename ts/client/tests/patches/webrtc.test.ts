// spec/WebRtc.agda shown-toNative: the page reads back what it gave,
// whatever the relay is; the native gets the relay only.
import { describe, expect, it } from "vitest";
import { shown, toNative } from "../../src/patches/webrtc";

describe("WebRTC configuration through the relay", () => {
    const page = { iceServers: [{ urls: ["stun:s.example"], username: "", credential: "" }], iceTransportPolicy: "all", bundlePolicy: "max-bundle", iceCandidatePoolSize: 0 };
    const relay = { urls: ["turn:203.0.113.7:3478?transport=udp"], username: "123", credential: "x" };
    it("gives the native the relay only, and the page reads back its own", () => {
        const native = toNative(page, relay);
        expect(native).toEqual({ ...page, iceServers: [{ urls: relay.urls, username: "123", credential: "x" }], iceTransportPolicy: "relay" });
        expect(shown(page, native)).toEqual(page);
    });
    it("with no relay the native gets no servers at all, relay only", () => {
        expect(toNative(page, undefined)).toMatchObject({ iceServers: [], iceTransportPolicy: "relay" });
    });
});
