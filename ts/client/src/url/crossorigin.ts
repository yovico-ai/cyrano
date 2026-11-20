// The crossorigin the runtime writes: a port of spec/Attrs.agda
// crossoriginValue (Go: htmlrewrite crossoriginValue; both checked against
// the spec). On an HTML element use-credentials — a resource and its
// preload keep one credentials mode — except a font or fetch preload or
// prefetch, kept as written to match @font-face's anonymous fetch and the
// page's own fetch(). null: as written.

export function crossoriginValue(html: boolean, tag: string, rel: string, as: string): string | null {
    if (!html) return null;
    const r = rel.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const a = as.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (tag === "link" && (r === "preload" || r === "prefetch") && (a === "font" || a === "fetch")) return null;
    return "use-credentials";
}
