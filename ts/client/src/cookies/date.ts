// A cookie's Expires date as Chromium reads it: a port of spec/CookieDate.agda
// (Chromium's ParseCookieExpirationTime, not RFC 6265bis §5.1.1; Go:
// urlrewrite.CookieDate). Checked against the spec by
// tests/spec/cookie-date-conformance.test.ts, and the spec against Chromium
// by cookie-date-vs-chromium.

import { sCode } from "../native/intrinsics";

const delimiter = (c: number): boolean =>
    c === 9 || (c >= 32 && c <= 47) || (c >= 59 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
const digit = (c: number): boolean => c >= 48 && c <= 57;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** UTF-8 octets of s[a, b). */
function octets(s: string, a: number, b: number): number {
    let n = 0;
    for (let i = a; i < b; i++) {
        const c = sCode(s, i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < b) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

function atoi(s: string, a: number, b: number): number {
    let n = 0;
    for (let i = a; i < b && digit(sCode(s, i)); i++) n = n * 10 + (sCode(s, i) - 48);
    return n;
}

/** %2u at i: [value, next index] or null. */
function upTo2(s: string, i: number, b: number): [number, number] | null {
    if (i >= b || !digit(sCode(s, i))) return null;
    if (i + 1 < b && digit(sCode(s, i + 1))) return [(sCode(s, i) - 48) * 10 + (sCode(s, i + 1) - 48), i + 2];
    return [sCode(s, i) - 48, i + 1];
}

/** sscanf "%2u:%2u:%2u" == 3 on s[a, b). */
function timeOf(s: string, a: number, b: number): [number, number, number] | null {
    const h = upTo2(s, a, b);
    if (!h || h[1] >= b || sCode(s, h[1]) !== 58) return null;
    const m = upTo2(s, h[1] + 1, b);
    if (!m || m[1] >= b || sCode(s, m[1]) !== 58) return null;
    const sec = upTo2(s, m[1] + 1, b);
    return sec ? [h[0], m[0], sec[0]] : null;
}

function monthOf(s: string, a: number, b: number): number | null {
    if (b - a < 3) return null;
    for (let k = 0; k < 12; k++) {
        const m = MONTHS[k]!;
        let ok = true;
        for (let j = 0; j < 3 && ok; j++) {
            let c = sCode(s, a + j);
            if (c >= 65 && c <= 90) c += 32;
            ok = c === sCode(m, j);
        }
        if (ok) return k + 1;
    }
    return null;
}

const leap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysIn = (y: number, m: number): number => m === 2 ? (leap(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
const leapsTo = (n: number): number => Math.floor(n / 4) - Math.floor(n / 100) + Math.floor(n / 400);

/**
 * The instant an Expires value names, in seconds after the epoch (0 for
 * one before it); null when it names none (a session cookie).
 */
export function cookieDate(s: string): number | null {
    let day: number | null = null, month: number | null = null, year: number | null = null;
    let time: [number, number, number] | null = null;
    const n = s.length;
    for (let i = 0; i < n;) {
        while (i < n && delimiter(sCode(s, i))) i++;
        let j = i;
        while (j < n && !delimiter(sCode(s, j))) j++;
        if (j === i) break;
        const c = sCode(s, i);
        if (!digit(c)) {
            if (month === null) month = monthOf(s, i, j);
        } else {
            let colon = false;
            for (let k = i; k < j && !colon; k++) colon = sCode(s, k) === 58;
            if (colon) {
                if (time === null) time = timeOf(s, i, j);
            } else if (day === null && octets(s, i, j) <= 2) day = atoi(s, i, j);
            else if (year === null && octets(s, i, j) <= 5) year = atoi(s, i, j);
        }
        i = j;
    }
    if (day === null || month === null || time === null || year === null) return null;
    if (year >= 70 && year <= 99) year += 1900;
    else if (year <= 69) year += 2000;
    const [h, mi, sec] = time;
    if (day < 1 || day > daysIn(year, month) || h > 23 || mi > 59 || sec > 59) return null;
    if (year < 1970) return 0;
    let days = 365 * (year - 1970) + (leapsTo(year - 1) - leapsTo(1969)) + day - 1;
    for (let m = 1; m < month; m++) days += daysIn(year, m);
    return days * 86400 + h * 3600 + mi * 60 + sec;
}
