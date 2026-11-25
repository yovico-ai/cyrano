// Whether an image source is origin-clean for a canvas (spec/Canvas.agda
// imageClean): its request was CORS (crossorigin, as the page wrote it),
// or its URL — as the page knows it — is data:, blob: (under the proxy
// every blob: URL is the page's own), or of the document's origin.

const lead = /^[\x00-\x20]+|[\x00-\x20]+$/g;
const tabNl = /[\t\n\r]/g;

export function imageClean(cors: boolean, docOrigin: string, url: string): boolean {
    if (cors) return true;
    const p = url.replace(lead, "").replace(tabNl, "");
    const head = p.slice(0, 5).toLowerCase();
    if (head === "data:" || head === "blob:") return true;
    let o: string;
    try { o = new URL(p).origin; } catch { return false; }
    // An opaque origin (file:, any scheme without one) is no document's.
    return o !== "null" && o === docOrigin;
}
