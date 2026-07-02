import { describe, expect, it } from "vitest";
import { WorkerWrappedLocation } from "../../src/wrappers/worker-location";

describe("WorkerWrappedLocation", () => {
    it("reflects the upstream URL it was constructed with", () => {
        const loc = new WorkerWrappedLocation("https://example.com:8443/path?q=1#frag");
        expect(loc.href).toBe("https://example.com:8443/path?q=1#frag");
        expect(loc.origin).toBe("https://example.com:8443");
        expect(loc.protocol).toBe("https:");
        expect(loc.host).toBe("example.com:8443");
        expect(loc.hostname).toBe("example.com");
        expect(loc.port).toBe("8443");
        expect(loc.pathname).toBe("/path");
        expect(loc.search).toBe("?q=1");
        expect(loc.hash).toBe("#frag");
    });

    it("toString returns the href", () => {
        const loc = new WorkerWrappedLocation("https://example.com/");
        expect(loc.toString()).toBe("https://example.com/");
    });

    it("assign/replace/reload are safe no-ops — a worker can't navigate", () => {
        const loc = new WorkerWrappedLocation("https://example.com/");
        expect(() => loc.assign("https://evil.com/")).not.toThrow();
        expect(() => loc.replace("https://evil.com/")).not.toThrow();
        expect(() => loc.reload()).not.toThrow();
        // Calling them must not mutate the snapshot.
        expect(loc.href).toBe("https://example.com/");
    });
});
