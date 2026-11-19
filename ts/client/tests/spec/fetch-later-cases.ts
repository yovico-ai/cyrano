// Requests for the fetchLater checks (fetch-later-conformance, fetch-later-vs-chromium).

export const URLS = ["https://a.example/", "https://a.example/p?q=1#frag", "https://b.example:8443/x/y/z?long=" + "v".repeat(300), "https://a.example/é?ü#x"];
export const HEADERS: [string, string][][] = [[], [["X-A", "1"]], [["Content-Type", "text/csv"]], [["x-b", "two words"], ["X-B", "again"]], [["x-d", " padded\t"], ["X-D", "1"], ["x-d", "2"]], [["Content-TYPE", "q/r"]], [["x-l", "café"]], [["content-type", "a/b"], ["x-c", "c"]]];
export type BodyKind = "none" | "text" | "params" | "blob" | "typed-blob" | "buffer" | "view";
export const BODIES: BodyKind[] = ["none", "text", "params", "blob", "typed-blob", "buffer", "view"];

export const makeBody = (kind: BodyKind, n: number): BodyInit | undefined =>
    kind === "none" ? undefined : kind === "text" ? "é€😀x".repeat(n >> 2) : kind === "params" ? new URLSearchParams({ k: "v w".repeat(n) })
        : kind === "blob" ? new Blob(["x".repeat(n)]) : kind === "typed-blob" ? new Blob(["x".repeat(n)], { type: "Text/Weird" })
            : kind === "buffer" ? new ArrayBuffer(n) : new Uint16Array(n);

/** The oracle's arguments for a request, from what it is made of. */
export const sizeArgs = (url: string, headers: [string, string][], kind: BodyKind, n: number): string[] => {
    const u = new URL(url);
    u.hash = "";
    const hs = headers.map(([k, v]) => `${k}:${v.trim()}`); // the header list: each entry as given
    const body = makeBody(kind, n);
    const len = body === undefined ? 0 : typeof body === "string" ? body.length : body instanceof URLSearchParams ? body.toString().length
        : body instanceof Blob ? body.size : body instanceof ArrayBuffer ? body.byteLength : (body as ArrayBufferView).byteLength;
    const k = kind === "none" ? "none" : kind === "text" ? "text" : kind === "params" ? "params" : kind === "blob" ? "blob:" : kind === "typed-blob" ? "blob:text/weird" : "buffer";
    return [u.href, hs.join("\n"), k, String(len)];
};

