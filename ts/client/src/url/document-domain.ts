// Setting document.domain (spec/Frames.agda domainSet, relaxed).
import { getPublicSuffix } from "tldts";

export type DomainSet = { kind: "set"; v: string } | { kind: "empty" } | { kind: "tld"; v: string } | { kind: "notsuffix"; v: string; current: string };

/** spec/Frames.agda domainSet. */
export function domainSet(host: string, ip: boolean, current: string, v: string, empty: boolean, publicSuffix: boolean): DomainSet {
    if (empty) return { kind: "empty" };
    if (ip) return v === host ? { kind: "set", v } : { kind: "notsuffix", v, current };
    if (publicSuffix) return { kind: "tld", v };
    if (v === host || host.endsWith("." + v)) return { kind: "set", v };
    return { kind: "notsuffix", v, current };
}

/** The value as Chromium canonicalizes it: a URL host (lowercase, IPv4 forms), a space as %20. */
export function canonicalDomain(value: string): string {
    if (/[\x00-\x20%]/.test(value)) return value.replace(/ /g, "%20");
    try { return new URL("http://" + value + "/").hostname; } catch { return value; }
}

export const isIpHost = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[");

/** A public suffix, ICANN or private (github.io is refused: measured). */
export const isPublicSuffix = (d: string): boolean => getPublicSuffix(d, { allowPrivateDomains: true }) === d;

/** spec/Frames.agda relaxed. */
export function relaxed(a: string | undefined, b: string | undefined, sameSchemePort: boolean): boolean {
    return a !== undefined && b !== undefined && a === b && sameSchemePort;
}
