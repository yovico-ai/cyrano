// A srcdoc frame's document.referrer (spec/Referrer.agda srcdocReferrer):
// its parent's URL by the parent's policy, about:srcdoc taken as another
// origin, never a downgrade (Chromium, measured). null: none ("").

const LEGACY: Record<string, string> = { never: "no-referrer", default: "strict-origin-when-cross-origin", always: "unsafe-url", "origin-when-crossorigin": "origin-when-cross-origin" };
const POLICIES = ["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"];

/**
 * The policy a header gives (the last known token of its list), or a
 * <meta name=referrer> (spec/Referrer.agda metaPolicy: one whole token,
 * HTML's legacy keywords, no list); null for none.
 */
export function policyOf(v: string, meta = false): string | null {
    if (meta) {
        const t = v.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "").toLowerCase();
        if (LEGACY[t]) return LEGACY[t]!;
        return !t.includes(",") && POLICIES.includes(t) ? t : null;
    }
    let out: string | null = null;
    for (const raw of v.split(",")) {
        const t = raw.trim().toLowerCase();
        if (POLICIES.includes(t)) out = t;
    }
    return out;
}

export function srcdocReferrer(policy: string, ref: string): string | null {
    let u: URL;
    try { u = new URL(ref); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const only = u.origin + "/";
    let full = u.origin + u.pathname + u.search;
    if ([...full].length > 4096) full = only;
    switch (policy) {
        case "no-referrer": case "same-origin": return null;
        case "no-referrer-when-downgrade": case "unsafe-url": return full;
        default: return only; // origin, strict-origin, origin-when-cross-origin, strict-origin-when-cross-origin
    }
}

/**
 * A srcdoc frame's referrer from the document of `win`: its URL by its
 * policy — the header's (config.rp), or the last <meta name=referrer> it holds.
 */
export function srcdocReferrerFrom(win: Window, config: { rp?: unknown }): string | null {
    let policy = policyOf(String(config.rp ?? "")) ?? "strict-origin-when-cross-origin";
    let href: string | null = null;
    try {
        href = win.document.URL;
        const metas = win.document.querySelectorAll('meta[name="referrer" i]');
        for (let i = 0; i < metas.length; i++) {
            const p = policyOf(metas[i]!.getAttribute("content") ?? "", true);
            if (p) policy = p;
        }
    } catch { /* the header's */ }
    return href ? srcdocReferrer(policy, href) : null;
}
