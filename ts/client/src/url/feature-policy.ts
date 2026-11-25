// What a document reads of its Permissions-Policy (spec/Permissions.agda
// allows, allowlist), from the table the server gives it (spec table:
// each declared feature and its entries — "*", "'self'", an origin,
// "<scheme>://*.<host>").

export type PolicyTable = string[][];

const lookup = (t: PolicyTable | null, f: string): string[] | null => {
    if (!t) return null;
    for (const row of t) if (row[0] === f) return row.slice(1);
    return null;
};

/** spec Permissions.matches */
function matches(doc: string, o: string, e: string): boolean {
    if (e === "*") return true;
    if (e === "'self'") return o === doc;
    const star = e.indexOf("://*");
    if (star >= 0) {
        const p = e.slice(0, star + 3), h = e.slice(star + 4);
        return o.startsWith(p) && o.endsWith(h);
    }
    return o === e;
}

/** spec Permissions.allows: may origin `o` use feature f, for a document of origin `doc`. */
export function allowsBy(t: PolicyTable | null, defaultAll: boolean, f: string, doc: string, o: string): boolean {
    const es = lookup(t, f);
    if (es === null) return defaultAll || o === doc;
    return es.some((e) => matches(doc, o, e));
}

/** spec Permissions.allowlist: getAllowlistForFeature. */
export function allowlistBy(t: PolicyTable | null, defaultAll: boolean, f: string, doc: string): string[] {
    const es = lookup(t, f);
    if (es === null) return [defaultAll ? "*" : doc];
    if (es.includes("*")) return ["*"];
    const wild = (e: string): boolean => e.includes("://*");
    return [...(es.includes("'self'") ? [doc] : []), ...es.filter((e) => e !== "'self'" && !wild(e)), ...es.filter(wild)];
}
