// Best-effort srcset rewriter.
//
// `srcset` carries a comma-separated list of `"<url> <descriptor>"` candidates,
// e.g.:
//   "img-1x.jpg 1x, img-2x.jpg 2x, img-w480.jpg 480w"
//
// We split on commas, rewrite the URL part of each candidate, and leave the
// descriptor (`1x`, `2w`, etc.) alone. Mirrors the server's
// `shared-utils.rewriteSrcset` for runtime parity.
//
// Edge cases not handled: data: URLs containing commas. Those would require
// proper tokenizing. The server has the same limitation.

export function rewriteSrcsetAttribute(
    srcset: string,
    rewriteOne: (url: string) => string,
): string {
    return srcset
        .split(",")
        .map((candidate) => {
            const trimmed = candidate.trim();
            const firstWhitespace = trimmed.indexOf(" ");
            if (firstWhitespace === -1) return rewriteOne(trimmed);
            const url = trimmed.slice(0, firstWhitespace);
            const descriptor = trimmed.slice(firstWhitespace);
            return `${rewriteOne(url)}${descriptor}`;
        })
        .join(", ");
}
