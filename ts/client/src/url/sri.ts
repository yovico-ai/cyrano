// Subresource Integrity's mark (spec/Sri.agda markOf). Through the proxy a
// script or stylesheet is rewritten, so its bytes can never match the
// page's `integrity`: the rewriters drop the attribute and carry the
// metadata in the element's URL (the scheme segment's "!=" marker); the
// proxy checks the origin's bytes against it and fails a mismatch.

const RANK: Record<string, number> = { sha256: 1, sha384: 2, sha512: 3 };

/** spec Sri.canon: base64 / base64url made canonical ("+" "-", "/" "_", no "="), or null. */
function canon(v: string): string | null {
    const s = v.replace(/=+$/, "");
    if (s === "" || !/^[A-Za-z0-9+/_-]+$/.test(s)) return null;
    return s.replace(/\+/g, "-").replace(/\//g, "_");
}

/** spec Sri.itemOf: alg "-" value ["?" options]. */
function itemOf(t: string): { alg: string; value: string } | null {
    const i = t.indexOf("-");
    if (i < 0) return null;
    const alg = t.slice(0, i).replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (!RANK[alg]) return null;
    let rest = t.slice(i + 1);
    const q = rest.indexOf("?");
    if (q >= 0) rest = rest.slice(0, q);
    const value = canon(rest);
    return value === null ? null : { alg, value };
}

/** spec Sri.markOf: the strongest algorithm's valid items, canonical, joined by "."; null when nothing is to be checked. */
export function sriMark(metadata: string): string | null {
    const items = metadata.split(/[ \t\n\f\r]/).map(itemOf).filter((x): x is { alg: string; value: string } => x !== null);
    let top = 0;
    for (const it of items) top = Math.max(top, RANK[it.alg]!);
    const parts = items.filter((it) => RANK[it.alg] === top).map((it) => it.alg + "-" + it.value);
    return parts.length ? parts.join(".") : null;
}

/** spec Sri.honored: the browser checks this element attribute's integrity (rels lowercased). */
export function sriHonored(svg: boolean, tag: string, attr: string, rels: readonly string[]): boolean {
    if (svg) return false;
    if (tag === "script" && attr === "src") return true;
    return tag === "link" && attr === "href" && rels.some((r) => r === "stylesheet" || r === "preload" || r === "modulepreload");
}
