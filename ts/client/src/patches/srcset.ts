// Spec-compliant srcset rewriter.
//
// Per https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute
// URLs end at ASCII whitespace — commas within a URL (e.g. Cloudflare Image
// Resizing paths like /cdn-cgi/image/width=640,quality=75,format=auto/...) are
// valid and must NOT be treated as candidate separators. The separator between
// candidates is a comma that appears AFTER a descriptor (or after a URL-only
// entry with no descriptor).
//
// Algorithm mirrors go/src/internal/htmlrewrite/srcset.go — keep in sync.

const WS = /[ \t\n\r\v]/;

export function rewriteSrcsetAttribute(
    srcset: string,
    rewriteOne: (url: string) => string,
): string {
    const out: string[] = [];
    let s = srcset;

    while (true) {
        // Skip leading whitespace and commas (separators from previous candidate).
        s = s.replace(/^[ \t\n\r\v,]+/, "");
        if (s === "") break;

        // URL token ends at first ASCII whitespace.
        const wsIdx = s.search(WS);
        let urlToken: string;
        if (wsIdx === -1) {
            urlToken = s;
            s = "";
        } else {
            urlToken = s.slice(0, wsIdx);
            s = s.slice(wsIdx);
        }

        // Trailing commas on the URL itself are candidate separators.
        urlToken = urlToken.replace(/,+$/, "");
        if (urlToken === "") continue;

        // Skip whitespace between URL and optional descriptor.
        s = s.replace(/^[ \t\n\r\v]+/, "");

        // Descriptor: everything up to the next comma.
        const commaIdx = s.indexOf(",");
        let descriptor: string;
        if (commaIdx === -1) {
            descriptor = s.trim();
            s = "";
        } else {
            descriptor = s.slice(0, commaIdx).trim();
            s = s.slice(commaIdx); // leave the comma for next iteration's trim
        }

        if (descriptor !== "") {
            out.push(`${rewriteOne(urlToken)} ${descriptor}`);
        } else {
            out.push(rewriteOne(urlToken));
        }
    }

    return out.join(", ");
}
