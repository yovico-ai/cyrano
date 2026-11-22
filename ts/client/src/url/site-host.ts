// One proxy host per site: spec/SiteHost.agda (Go: internal/sitehost).
//
// A proxied site (a scheme and a registrable domain) is served from
// <label>.<domain>; the label is the first 26 characters of
// base32(SHA-256(site key)), lower case, no padding. URLs are rewritten
// synchronously, so SHA-256 is computed here (FIPS 180-4) rather than by
// SubtleCrypto, which only answers asynchronously; labels are cached per
// key.

import { SafeMap } from "../native/intrinsics";

export const LABEL_LENGTH = 26;

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 bytes of a string (lone surrogates as U+FFFD, as TextEncoder). */
function utf8(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
            else c = 0xfffd;
        } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

/** SHA-256 of bytes: 32 bytes. */
export function sha256(bytes: number[]): number[] {
    const len = bytes.length;
    const msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    const bits = len * 8;
    for (let i = 7; i >= 0; i--) msg.push(Math.floor(bits / 2 ** (8 * i)) & 0xff);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < msg.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = (msg[off + 4 * i]! << 24) | (msg[off + 4 * i + 1]! << 16) | (msg[off + 4 * i + 2]! << 8) | msg[off + 4 * i + 3]!;
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15]!, b = w[i - 2]!;
            const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3), s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
            w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
        }
        let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d;
        h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + hh;
    }
    const out: number[] = [];
    for (let i = 0; i < 8; i++) out.push((h[i]! >>> 24) & 0xff, (h[i]! >>> 16) & 0xff, (h[i]! >>> 8) & 0xff, h[i]! & 0xff);
    return out;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** base32, RFC 4648 §6, lower case, no padding. */
export function base32(bytes: number[]): string {
    let out = "", n = 0, acc = 0;
    for (const b of bytes) {
        acc = (acc << 8) | b; n += 8;
        while (n >= 5) { out += ALPHABET[(acc >>> (n - 5)) & 31]; n -= 5; }
        acc &= (1 << n) - 1;
    }
    if (n > 0) out += ALPHABET[(acc << (5 - n)) & 31];
    return out;
}

/** spec siteKey: "<scheme>://<registrable domain>", the host when it has none (registrable ""). */
export function siteKey(scheme: string, host: string, registrable: string): string {
    return scheme + "://" + (registrable === "" ? host : registrable);
}

const labels = new SafeMap<string, string>();

/** spec siteLabel. */
export function siteLabel(key: string): string {
    const hit = labels.get(key);
    if (hit !== undefined) return hit;
    const l = base32(sha256(utf8(key))).slice(0, LABEL_LENGTH);
    labels.set(key, l);
    return l;
}

/** spec siteHost. */
export function siteHost(domain: string, key: string): string {
    return siteLabel(key) + "." + domain;
}

/** spec labelOf: the one label before "." + domain, or null. */
export function labelOf(domain: string, host: string): string | null {
    const i = host.indexOf(".");
    return i > 0 && host.slice(i + 1) === domain ? host.slice(0, i) : null;
}

/** spec admits. */
export function admits(domain: string, host: string, key: string): boolean {
    const l = labelOf(domain, host);
    return l !== null && l === siteLabel(key);
}
