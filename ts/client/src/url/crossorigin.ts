// The crossorigin the runtime writes: a port of spec/Attrs.agda
// crossoriginValue (Go: htmlrewrite crossoriginValue; both checked against
// the spec). On an HTML element use-credentials — a resource and its
// preload keep one credentials mode — except a font or fetch preload or
// prefetch, kept as written to match @font-face's anonymous fetch and the
// page's own fetch(). null: as written.

// Host mode: each origin on its own host, so a crossorigin request is a
// real CORS request; forcing use-credentials would demand an exact
// Access-Control-Allow-Origin of every CDN. Kept as written.
let keepAsWritten = false;
export function keepCrossorigin(): void { keepAsWritten = true; }

export function crossoriginValue(html: boolean, tag: string, rel: string, as: string): string | null {
    if (!html || keepAsWritten) return null;
    const r = rel.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const a = as.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (tag === "link" && (r === "preload" || r === "prefetch") && (a === "font" || a === "fetch")) return null;
    return "use-credentials";
}
