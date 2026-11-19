// A Refresh value (<meta http-equiv=refresh content>), as Chromium reads it:
// a port of spec/Refresh.agda, which is the authority (Go:
// urlrewrite.RewriteRefresh; both checked against the spec, the spec
// against Chromium in refresh-vs-chromium). Only the URL is edited.

import { sStarts } from "../native/intrinsics";

const ws = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/** The value around its URL, or null when it is not a refresh to a URL (or a reload). */
export function refreshUrl(v: string): [string, string, string] | null {
    let i = 0;
    while (i < v.length && ws(v[i])) i++;
    if (i === v.length) return null;
    let digit = false;
    while (i < v.length && ((v[i]! >= "0" && v[i]! <= "9") || v[i] === ".")) { digit = digit || v[i] !== "."; i++; }
    if (!digit || i === v.length) return null;
    if (!(v[i] === ";" || v[i] === "," || ws(v[i]))) return null;
    while (i < v.length && ws(v[i])) i++;
    if (v[i] === ";" || v[i] === ",") i++;
    while (i < v.length && ws(v[i])) i++;
    let start = i;
    if (v.length - i >= 3 && v.slice(i, i + 3).toLowerCase() === "url") {
        let k = i + 3;
        while (k < v.length && ws(v[k])) k++;
        if (v[k] === "=") {
            k++;
            while (k < v.length && ws(v[k])) k++;
            start = k;
        }
    }
    let end = v.length;
    if (v[start] === "'" || v[start] === '"') {
        const q = v[start]!;
        start++;
        const j = v.lastIndexOf(q);
        if (j >= start) end = j;
    }
    while (start < end && ws(v[start])) start++;
    while (end > start && ws(v[end - 1])) end--;
    if (start === end) return null;
    return [v.slice(0, start), v.slice(start, end), v.slice(end)];
}

/** The value with its URL proxified (as written when it names none). */
export function rewriteRefresh(v: string, rewriteOne: (url: string) => string): string {
    const parts = refreshUrl(v);
    if (parts === null) return v;
    return parts[0] + rewriteOne(parts[1]) + parts[2];
}

/** Whether an http-equiv value is "refresh" (ASCII case-insensitive). */
export function isRefreshEquiv(v: string | null): boolean {
    return v !== null && v.length === 7 && sStarts(v.toLowerCase(), "refresh");
}
