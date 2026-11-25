// Whether a page may intercept a navigation (spec/Route.agda canIntercept;
// HTML "can have its URL rewritten"): the destination's scheme, userinfo,
// host and port are the document's. Judged on the original URLs — the
// browser compares proxified ones, always same-origin.
export function canIntercept(documentUrl: string, target: string): boolean {
    let d: URL, t: URL;
    try { d = new URL(documentUrl); t = new URL(target, d); } catch { return false; }
    return d.protocol === t.protocol && d.username === t.username && d.password === t.password && d.host === t.host;
}
