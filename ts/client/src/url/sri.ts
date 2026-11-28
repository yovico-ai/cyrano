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

/**
 * Where an honored element's integrity goes (spec Sri.carry): a module
 * member — a module script's src, a modulepreload's href — is named by its
 * URL in the module map, so its integrity is not marked there (two URLs were
 * two module instances: gigabyte.com's Nuxt entry ran twice). The server
 * keeps it for the document (Go proxy.RecordModuleIntegrity); the runtime has
 * no such record, so one the page sets itself goes unchecked (as a map the
 * runtime inserts). Everything else honored is marked in its URL.
 */
export type SriCarry = "url" | "document" | "unchecked";

export function sriCarry(svg: boolean, tag: string, attr: string, rels: readonly string[], isModule: boolean): SriCarry {
    if (!sriHonored(svg, tag, attr, rels)) return "unchecked";
    if (tag === "script" && isModule) return "document";
    if (tag === "link" && rels.some((r) => r === "modulepreload")) return "document";
    return "url";
}
