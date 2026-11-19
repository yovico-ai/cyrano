// postMessage's targetOrigin, per HTML, against the windows' original
// origins (src/messaging/target-origin.ts), and the rewritten-code wrapper
// that calls the recipient's own native from the sender's realm.

import { describe, expect, it, vi } from "vitest";
import { callerUrls, delivery, installSender, originalOrigin, sendAs } from "../../src/messaging/target-origin";
import type { Internals } from "../../src/native/internals";
import { wrapPostMessage } from "../../src/wrappers/post-message";

const PROXY = "http://localhost:9081";
const unwrap = (h: string) => h.startsWith(`${PROXY}/cyrano/https/`) ? `https://${h.slice(`${PROXY}/cyrano/https/`.length)}` : h;
const at = (href: string) => ({ location: { href } });
const frame = at(`${PROXY}/cyrano/https/widget.example/w`);

describe("originalOrigin", () => {
    it("is the unwrapped origin of a proxied window", () => {
        expect(originalOrigin(frame, unwrap)).toBe("https://widget.example");
    });
    it("prefers the window's own runtime base URL", () => {
        expect(originalOrigin({ $rewriter: { get_base_url: () => new URL("https://a.example/x") } }, unwrap)).toBe("https://a.example");
    });
    it("is null for a window cyrano does not proxy, or a cross-origin one", () => {
        expect(originalOrigin(at("https://elsewhere.example/"), unwrap)).toBeNull();
        expect(originalOrigin({ get location() { throw new Error("SecurityError"); } }, unwrap)).toBeNull();
    });
});

describe("delivery", () => {
    it("'*' and non-strings go to the native as written", () => {
        expect(delivery(frame, "*", null, PROXY, unwrap)).toEqual({ kind: "native" });
        expect(delivery(frame, undefined, null, PROXY, unwrap)).toEqual({ kind: "native" });
    });
    it("a matching origin is delivered, with the proxy origin", () => {
        expect(delivery(frame, "https://widget.example", null, PROXY, unwrap)).toEqual({ kind: "send", origin: PROXY });
        expect(delivery(frame, "https://widget.example/any/path", null, PROXY, unwrap)).toEqual({ kind: "send", origin: PROXY });
    });
    it("a mismatch is dropped silently, as natively", () => {
        expect(delivery(frame, "https://other.example", null, PROXY, unwrap)).toEqual({ kind: "drop" });
        expect(delivery(frame, PROXY, null, PROXY, unwrap)).toEqual({ kind: "drop" });
    });
    it("'/' is the sender's own origin", () => {
        expect(delivery(frame, "/", "https://widget.example", PROXY, unwrap)).toEqual({ kind: "send", origin: PROXY });
        expect(delivery(frame, "/", "https://top.example", PROXY, unwrap)).toEqual({ kind: "drop" });
    });
    it("an unparseable targetOrigin goes to the native, which throws its own SyntaxError", () => {
        expect(delivery(frame, "not a url", null, PROXY, unwrap)).toEqual({ kind: "native" });
    });
    it("a window cyrano does not proxy is left to the native", () => {
        expect(delivery(at("https://elsewhere.example/"), "https://elsewhere.example", null, PROXY, unwrap)).toEqual({ kind: "native" });
    });
});

describe("sending as the sender", () => {
    // Each window's runtime state lives inside its $rewriter (native/internals.ts).
    const withRuntime = (win: Record<string, unknown>, native: (...a: unknown[]) => unknown) => {
        const internals = { api: {} } as unknown as Internals;
        installSender(internals, native);
        win["window"] = win; // a window: only windows have internals (native/brand.ts)
        win["$rewriter"] = { _: internals };
        return win;
    };
    it("the sender's helper calls the recipient's own native", () => {
        const recipientNative = vi.fn();
        const recipient = withRuntime({ ...frame, postMessage: vi.fn() }, recipientNative);
        const sender = withRuntime({}, vi.fn());
        sendAs(sender, recipient, ["hi", PROXY], () => "fallback");
        expect(recipientNative).toHaveBeenCalledWith("hi", PROXY);
        expect(recipient["postMessage"]).not.toHaveBeenCalled();
    });
    it("falls back when the sender has no runtime", () => {
        expect(sendAs({}, frame, ["hi", "*"], () => "fallback")).toBe("fallback");
    });
    it("puts nothing on the window itself", () => {
        const w = withRuntime({}, vi.fn());
        expect(Object.getOwnPropertySymbols(w)).toEqual([]);
        expect(Object.keys(w)).toEqual(["window", "$rewriter"]);
    });
});

describe("wrapPostMessage (rewritten code)", () => {
    it("calls the target's own postMessage (the native-surface wrapper) as written", () => {
        const port = { postMessage: vi.fn() };
        wrapPostMessage({ obj: port }, PROXY, () => null, unwrap).postMessage("hi", "https://widget.example");
        expect(port.postMessage).toHaveBeenCalledWith("hi", "https://widget.example");
    });
});

describe("callerUrls", () => {
    it("reads script URLs off the stack, untouched by the page's prepareStackTrace", () => {
        const E = Error as unknown as { prepareStackTrace?: unknown; stackTraceLimit: number };
        const prep = () => "page's own";
        E.prepareStackTrace = prep;
        const limit = E.stackTraceLimit;
        E.stackTraceLimit = 0;
        try {
            const urls = callerUrls(Error);
            expect(urls.length).toBeGreaterThan(0);
            expect(E.prepareStackTrace).toBe(prep);
            expect(E.stackTraceLimit).toBe(0);
        } finally {
            delete E.prepareStackTrace;
            E.stackTraceLimit = limit;
        }
    });
});
