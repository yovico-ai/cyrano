// Runs under happy-dom. Tests that navigator.sendBeacon rewrites its URL
// argument before forwarding to the native implementation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { patchSendBeacon } from "../../src/patches/beacon";

const proxify = (url: string): string =>
    url.startsWith("http://localhost") ? url : `http://localhost:9081/?goto=${btoa(url)}`;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("patchSendBeacon", () => {
    it("rewrites a string URL before sending", () => {
        const spy = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
        patchSendBeacon(window, proxify);

        navigator.sendBeacon("https://stats.g.doubleclick.net/g/collect?v=2");
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![0]).toBe(
            proxify("https://stats.g.doubleclick.net/g/collect?v=2"),
        );
    });

    it("passes the data body through unchanged", () => {
        const spy = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
        patchSendBeacon(window, proxify);

        const body = JSON.stringify({ event: "pageview" });
        navigator.sendBeacon("https://analytics.example.com/collect", body);
        expect(spy.mock.calls[0]![1]).toBe(body);
    });

    it("rewrites a URL object argument", () => {
        const spy = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
        patchSendBeacon(window, proxify);

        navigator.sendBeacon(new URL("https://analytics.example.com/hit"));
        expect(spy.mock.calls[0]![0]).toBe(proxify("https://analytics.example.com/hit"));
    });

    it("passes already-proxied URLs through unchanged", () => {
        const spy = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
        patchSendBeacon(window, proxify);

        const alreadyProxied = "http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS8";
        navigator.sendBeacon(alreadyProxied);
        expect(spy.mock.calls[0]![0]).toBe(alreadyProxied);
    });

    it("is a no-op if sendBeacon is unavailable", () => {
        const win = { navigator: {} } as unknown as Window;
        expect(() => patchSendBeacon(win, proxify)).not.toThrow();
    });
});
