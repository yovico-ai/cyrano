// window.open's features string as Chromium tokenizes it, for its
// attributionsrc features (spec/Features.agda): each value is a
// percent-encoded URL the browser requests itself, so the runtime
// proxifies it — and leaves every other character of the string as it is.

const isSep = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 61 || c === 44;

function isSource(key: string): boolean {
    if (key.length !== 14) return false;
    const want = "attributionsrc";
    for (let i = 0; i < 14; i++) {
        const c = key.charCodeAt(i);
        if ((c >= 65 && c <= 90 ? c + 32 : c) !== want.charCodeAt(i)) return false;
    }
    return true;
}

type Feature = { before: string; key: string; value: string; end: number };

function next(s: string, i: number): Feature {
    const start = i;
    while (i < s.length && isSep(s.charCodeAt(i))) i++;
    const k0 = i;
    while (i < s.length && !isSep(s.charCodeAt(i))) i++;
    const key = s.slice(k0, i);
    // separators up to "=", not past "," or anything else
    while (i < s.length && isSep(s.charCodeAt(i)) && s.charCodeAt(i) !== 61 && s.charCodeAt(i) !== 44) i++;
    if (i >= s.length || s.charCodeAt(i) !== 61) return { before: s.slice(start, i), key, value: "", end: i }; // no "=": no value
    while (i < s.length && isSep(s.charCodeAt(i)) && s.charCodeAt(i) !== 44) i++;
    const v0 = i;
    while (i < s.length && !isSep(s.charCodeAt(i))) i++;
    return { before: s.slice(start, v0), key, value: s.slice(v0, i), end: i };
}

/** s with each non-empty attributionsrc value v replaced by f(v) (Features.agda mapSources). */
export function mapSources(s: string, f: (v: string) => string): string {
    let out = "";
    for (let i = 0; i < s.length;) {
        const ft = next(s, i);
        out += ft.before + (isSource(ft.key) && ft.value !== "" ? f(ft.value) : ft.value);
        i = ft.end;
    }
    return out;
}

/** The non-empty attributionsrc values, in order (Features.agda sources). */
export function sources(s: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < s.length;) {
        const ft = next(s, i);
        if (isSource(ft.key) && ft.value !== "") out[out.length] = ft.value;
        i = ft.end;
    }
    return out;
}

/** Percent-decoding as Chromium does a source's value: UTF-8, else byte for byte. */
export function decodeSource(v: string): string {
    const bytes: number[] = [];
    let plain = true;
    for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c === 37 && i + 2 < v.length && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) {
            bytes[bytes.length] = parseInt(v.slice(i + 1, i + 3), 16);
            i += 2;
            plain = false;
        } else if (c < 0x80) {
            bytes[bytes.length] = c;
        } else {
            const enc = new TextEncoder().encode(v[i]!);
            for (let j = 0; j < enc.length; j++) bytes[bytes.length] = enc[j]!;
        }
    }
    if (plain) return v;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
        let s = "";
        for (let j = 0; j < bytes.length; j++) s += String.fromCharCode(bytes[j]!);
        return s;
    }
}
