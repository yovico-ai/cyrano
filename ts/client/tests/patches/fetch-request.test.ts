// Runs under happy-dom. The page's own Request objects, `new Request(url)`
// and fetchLater, as patchFetch hands them to the browser.
//
// happy-dom's Request keeps `url` on a base class's prototype (a browser
// keeps it on Request.prototype itself), so each test gets a small Request
// class shaped as the browser's: `url` an accessor on its own prototype,
// branded "[object Request]". A fresh class per test: patchFetch wraps the
// constructor and the accessor in place.

import { describe, expect, it, vi } from "vitest";
import { patchFetch } from "../../src/patches/fetch";
import { deferredSize } from "../../src/patches/fetch-later";
import type { CorsContext } from "../../src/patches/cors";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";
const untag = (url: string): string => url.replace(/[?&]proxified=1/, "");
const base = (): URL => new URL("https://page.example/app/");

interface FakeRequestInit { method?: string; body?: unknown; headers?: HeadersInit; mode?: RequestMode; credentials?: RequestCredentials }

function makeRequestClass() {
    class FakeRequest {
        readonly [Symbol.toStringTag] = "Request";
        #url: string;
        method: string;
        body: unknown;
        headers: Headers;
        mode: RequestMode;
        credentials: RequestCredentials;
        constructor(input: string | FakeRequest, init: FakeRequestInit = {}) {
            const from = input instanceof FakeRequest ? input : undefined;
            this.#url = from ? from.#url : new URL(String(input)).href;
            this.method = init.method ?? from?.method ?? "GET";
            this.body = init.body ?? from?.body ?? null;
            this.headers = new Headers(init.headers ?? from?.headers);
            this.mode = init.mode ?? from?.mode ?? "cors";
            this.credentials = init.credentials ?? from?.credentials ?? "same-origin";
        }
        get url(): string {
            return this.#url;
        }
    }
    // The URL the request really holds: the accessor as it was.
    const nativeUrl = Object.getOwnPropertyDescriptor(FakeRequest.prototype, "url")!.get! as (this: unknown) => string;
    return { FakeRequest, held: (r: unknown): string => nativeUrl.call(r) };
}

function setup(cors?: CorsContext) {
    const { FakeRequest, held } = makeRequestClass();
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    const fetchLaterMock = vi.fn().mockReturnValue({ activated: false });
    const win = {
        fetch: fetchMock,
        fetchLater: fetchLaterMock,
        Request: FakeRequest,
        Headers,
        Promise,
        TypeError,
    } as unknown as Window & { Request: typeof FakeRequest; fetchLater: (...a: unknown[]) => unknown };
    patchFetch(win, tag, untag, base, cors);
    return { win, FakeRequest, held, fetchMock, fetchLaterMock };
}

const sameOriginCors: CorsContext = {
    origin: () => "https://page.example",
    proxy: "http://localhost:9081",
    href: () => "https://page.example/app/#frag",
    always: true,
};

describe("new Request(url) (wrapped constructor)", () => {
    it("holds the proxified URL; request.url reads the original", () => {
        const { win, held } = setup();
        const req = new win.Request("https://page.example/api/items");
        expect(held(req)).toBe("https://page.example/api/items?proxified=1");
        expect(req.url).toBe("https://page.example/api/items");
    });

    it("new Request(request) does not proxify a second time", () => {
        const { win, held } = setup();
        const first = new win.Request("https://page.example/a");
        const copy = new win.Request(first as unknown as string);
        expect(held(copy)).toBe("https://page.example/a?proxified=1");
        expect(copy.url).toBe("https://page.example/a");
    });

    it("a URL with credentials is left to the native as written", () => {
        const { win, held } = setup();
        const req = new win.Request("https://u:p@page.example/a");
        expect(held(req)).toBe("https://u:p@page.example/a");
    });
});

describe("fetch(request): the page's own Request goes to the native as is", () => {
    it("without a CORS context: the same object, not a rebuilt one", async () => {
        const { win, fetchMock } = setup();
        const req = new win.Request("https://page.example/upload", { method: "POST", body: "payload" });
        await win.fetch(req as unknown as Request);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // A rebuilt Request carries the body as a stream, which HTTP/1.1 cannot send.
        expect(fetchMock.mock.calls[0]![0]).toBe(req);
    });

    it("with a CORS context: the same object, only Crn-I / Crn-C / Crn-A set on it", async () => {
        const { win, held, fetchMock } = setup(sameOriginCors);
        const req = new win.Request("https://page.example/upload", { method: "POST", body: "payload", headers: { "x-page": "1" } });
        await win.fetch(req as unknown as Request);
        const sent = fetchMock.mock.calls[0]![0];
        expect(sent).toBe(req);
        expect(fetchMock.mock.calls[0]!.length).toBe(1);
        expect(held(sent)).toBe("https://page.example/upload?proxified=1");
        expect(req.method).toBe("POST");
        expect(req.body).toBe("payload");
        expect([...req.headers.keys()].map((k) => k.toLowerCase()).sort()).toEqual(["crn-a", "crn-c", "crn-i", "x-page"]);
        // the page's own header names (preflights; a body's Content-Type, when
        // the DOM adds one, is listed too — the proxy checks it either way)
        expect(req.headers.get("Crn-A")!.split(",")).toContain("x-page");
        expect(req.headers.get("Crn-I")).toBe("https://page.example/app/");
        expect(req.headers.get("Crn-C")).toBe("same-origin") // the page's mode: the proxy resolves it per target;
    });

    // YouTube's blocker bait: a data: Request whose subclass's `url` names
    // its player API. It is judged by the URL it holds, as the browser
    // fetches it — not rebuilt for the API.
    it("a subclass whose url lies is judged by the URL it holds", async () => {
        const { win, fetchMock } = setup(sameOriginCors);
        class Bait extends win.Request {
            override get url(): string { return "https://api.other.example/youtubei/v1/player"; }
        }
        const req = new Bait("data:application/json,%7B%7D", { method: "POST", body: "{}" });
        await win.fetch(req as unknown as Request);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]![0]).toBe(req);
        expect(fetchMock.mock.calls[0]!.length).toBe(1); // not rebuilt for the URL its getter names
    });

    it("with init headers: the Request still goes as is, the marks in the init's headers", async () => {
        const { win, fetchMock } = setup(sameOriginCors);
        const req = new win.Request("https://page.example/upload", { method: "POST", body: "payload" });
        const init = { headers: { "x-init": "1" } };
        await win.fetch(req as unknown as Request, init);
        const [sent, sentInit] = fetchMock.mock.calls[0]! as [unknown, { headers: HeadersInit }];
        expect(sent).toBe(req);
        // Handed over as pairs: a Headers is read by its iterator, which hides the marks.
        const h = new Headers(sentInit.headers);
        expect(h.get("x-init")).toBe("1");
        expect(h.get("Crn-I")).toBe("https://page.example/app/");
        // The page's init object is not modified.
        expect(init).toEqual({ headers: { "x-init": "1" } });
    });

    it("cross-origin with default credentials: Crn-C is the page's same-origin, the Request still as is", async () => {
        const { win, fetchMock } = setup({ ...sameOriginCors, always: false });
        const req = new win.Request("https://api.other.example/v1", { method: "POST", body: "payload" });
        await win.fetch(req as unknown as Request);
        expect(fetchMock.mock.calls[0]![0]).toBe(req);
        expect(req.headers.get("Crn-C")).toBe("same-origin");
        expect(req.headers.get("Crn-I")).toBe("https://page.example/app/");
    });

    it("a Request made by the unwrapped native (another realm's) is rebuilt on the proxified URL", async () => {
        const { win, FakeRequest, held, fetchMock } = setup();
        // FakeRequest itself is the native the wrapper calls: it does not proxify.
        const foreign = new FakeRequest("https://page.example/b");
        await win.fetch(foreign as unknown as Request);
        const sent = fetchMock.mock.calls[0]![0];
        expect(sent).not.toBe(foreign);
        expect(held(sent)).toBe("https://page.example/b?proxified=1");
    });
});

describe("fetchLater", () => {
    it("proxifies a string URL and passes the init through", () => {
        const { win, fetchLaterMock } = setup();
        const init = { method: "POST", activateAfter: 60000 };
        const result = win.fetchLater("https://ads.example/measure?id=7", init);
        expect(fetchLaterMock).toHaveBeenCalledWith("https://ads.example/measure?id=7&proxified=1", init);
        expect(result).toEqual({ activated: false });
    });

    it("proxifies a URL object by its href", () => {
        const { win, fetchLaterMock } = setup();
        win.fetchLater(new URL("https://ads.example/x"));
        expect(fetchLaterMock.mock.calls[0]![0]).toBe("https://ads.example/x?proxified=1");
    });

    it("a Request and a URL with credentials go to the native untouched", () => {
        const { win, fetchLaterMock } = setup();
        const req = new win.Request("https://ads.example/r");
        win.fetchLater(req);
        expect(fetchLaterMock.mock.calls[0]![0]).toBe(req);
        win.fetchLater("https://u:p@ads.example/r");
        expect(fetchLaterMock.mock.calls[1]![0]).toBe("https://u:p@ads.example/r");
    });

    it("keeps the receiver (a wrong this still reaches the native)", () => {
        const { win, fetchLaterMock } = setup();
        win.fetchLater("https://ads.example/x");
        expect(fetchLaterMock.mock.contexts[0]).toBe(win);
    });

    // Measured in Chromium (spec/FetchLater.agda): an empty body is a
    // TypeError there; the native's TypeError under a plain-http proxy read
    // as the proxy's refusal, and the request was deferred instead.
    it("an empty body throws the native's TypeError, under any proxy", () => {
        const { win, fetchLaterMock } = setup();
        fetchLaterMock.mockImplementation(() => { throw new TypeError("insecure"); });
        expect(() => win.fetchLater("https://ads.example/x", { method: "POST", body: "" })).toThrow(/body with unknown length/);
        expect(() => win.fetchLater("https://ads.example/x", { method: "POST", body: new ArrayBuffer(0) })).toThrow(TypeError);
        expect(fetchLaterMock).not.toHaveBeenCalled();
    });

    // Chromium counts a string body's UTF-16 length, not its UTF-8 bytes.
    it("a non-ASCII string body is counted by its length", () => {
        const { win, fetchLaterMock } = setup();
        win.fetchLater("https://ads.example/x", { method: "POST", body: "\u{1F600}".repeat(32000) }); // 64000 units, 128000 UTF-8 bytes
        expect(fetchLaterMock).toHaveBeenCalledTimes(1);
    });

    // Chromium counts each header-list entry: a name given twice, twice.
    it("a header given twice counts twice", () => {
        expect(deferredSize(new URL("https://a.example/"), { headers: [["x-b", "1"], ["X-B", " 2 "]] }, Headers)).toBe(18 + 8 + 12);
        expect(deferredSize(new URL("https://a.example/#f"), { headers: { "X-B": "1", "x-b": "2" } }, Headers)).toBe(18 + 8 + 12);
    });
});
