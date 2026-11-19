// An iframe's allow attribute as the browser is given it: a port of
// spec/Allow.agda rewriteAllow, which is the authority (Go:
// urlrewrite.RewriteAllow; both checked against the spec, the spec against
// Chromium in allow-vs-chromium). Through the proxy the frame's src is a
// proxy URL, so an origin in the attribute names nothing there: each
// allowlist word naming an origin becomes 'src'. Every other byte is kept;
// page code reads the attribute as written (read-back).

const ws = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

const KEYWORDS = ["*", "'self'", "'src'", "'none'"];

/** A word that names an origin: an absolute http(s)/ws(s) URL without userinfo. */
function namesOrigin(w: string): boolean {
    const lower = w.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (KEYWORDS.indexOf(lower) >= 0) return false;
    let u: URL;
    try { u = new URL(w); } catch { return false; }
    const p = u.protocol;
    return (p === "http:" || p === "https:" || p === "ws:" || p === "wss:") && u.username === "" && u.password === "";
}

export function rewriteAllow(v: string): string {
    const dirs = v.split(";");
    for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i]!;
        let out = "";
        let seenName = false;
        let j = 0;
        while (j < d.length) {
            if (ws(d[j]!)) { out += d[j]; j++; continue; }
            let k = j;
            while (k < d.length && !ws(d[k]!)) k++;
            const w = d.slice(j, k);
            out += seenName && namesOrigin(w) ? "'src'" : w;
            seenName = true;
            j = k;
        }
        dirs[i] = out;
    }
    return dirs.join(";");
}
