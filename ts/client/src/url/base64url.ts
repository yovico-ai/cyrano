// URL-safe base64 codec (RFC 4648 §5).
//
// Same alphabet as the Go server's `internal/b64u/b64u.go` and the v1 Node.js
// server's `utils/base64.js`, so encoded URLs round-trip byte-for-byte
// regardless of which runtime emitted them.
//
// We use the browser's atob/btoa for the actual base64 step. They speak
// "binary string" (one Latin-1 char per byte), so for arbitrary UTF-8 input
// we route through encodeURIComponent + unescape — the canonical browser-side
// trick for getting a btoa-safe binary string out of a UTF-8 JS string.

export function b64uEncode(input: string): string {
    const utf8BinaryString = unescape(encodeURIComponent(input));
    return btoa(utf8BinaryString)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export function b64uDecode(input: string): string {
    let standardBase64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const remainder = standardBase64.length % 4;
    if (remainder === 2) {
        standardBase64 += "==";
    } else if (remainder === 3) {
        standardBase64 += "=";
    } else if (remainder !== 0) {
        // remainder === 1 is never valid for base64.
        throw new Error(`invalid base64url string: ${input}`);
    }
    const utf8BinaryString = atob(standardBase64);
    return decodeURIComponent(escape(utf8BinaryString));
}
