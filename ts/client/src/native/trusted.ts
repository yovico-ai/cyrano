import { SafeWeakMap, nO, nOP, ncall } from "./intrinsics";
// Trusted Types, enforced as the page asked (the proxy keeps its
// `require-trusted-types-for` / `trusted-types` directives: a page checks
// that they hold — Cloudflare's challenge does).
//
// Under enforcement a string cannot be assigned to an HTML or script sink
// (innerHTML, script text, eval, a worker's URL …); only a value made by a
// policy can. The page hands the runtime such a value, the runtime
// rewrites the text in it — and must hand the sink a trusted value again.
// It makes one with a policy of its own, whose name the proxy added to the
// page's `trusted-types` directive (Go: urlrewrite.TrustedTypesPolicy;
// config.tt). One policy per realm, made before page code runs.
//
// The page's own strings stay strings: where it assigns a plain string,
// the sink sees a plain string, and refuses it (or asks the page's
// default policy) exactly as natively.

type Kind = "HTML" | "Script" | "ScriptURL";

interface Policy {
    createHTML(s: string): unknown;
    createScript(s: string): unknown;
    createScriptURL(s: string): unknown;
}

const policies = new SafeWeakMap<object, Policy | null>();
let policyName: string | undefined;
/** A realm's Function.prototype → the realm (its global object). */
const realms = new SafeWeakMap<object, object>();

/** The realm (global object) a built-in function belongs to, or this module's. */
export function realmOfFunction(fn: unknown): object {
    try {
        const fp = typeof fn === "function" ? nO.getPrototypeOf(fn) as object | null : null;
        return (fp && realms.get(fp)) || globalThis;
    } catch {
        return globalThis;
    }
}

/** The runtime's policy name (the proxy's, the same for every page it serves), once known. */
export const trustedPolicyName = (): string | undefined => policyName;
const same = (s: string): string => s;

/** Makes the runtime's policy in `realm` (a window or worker scope). Idempotent. */
export function initTrusted(realm: object, name: string | undefined, made?: unknown): void {
    if (name) policyName = name;
    if (policies.has(realm)) return;
    try {
        const fp = nO.getPrototypeOf((realm as { Object: object }).Object) as object | null;
        if (fp) realms.set(fp, realm);
    } catch { /* no Object: not a script realm */ }
    let policy: Policy | null = null;
    if (made && typeof made === "object") {
        policy = made as Policy; // a worker's preamble made it, to load the runtime with
    } else if (name) {
        try {
            const factory = (realm as { trustedTypes?: { createPolicy(n: string, rules: object): Policy } }).trustedTypes;
            if (factory) policy = factory.createPolicy(name, { createHTML: same, createScript: same, createScriptURL: same });
        } catch {
            policy = null; // not admitted, or made already: strings, as before
        }
    }
    policies.set(realm, policy);
}

/** `text` as a trusted value of `kind` in `realm`; the string itself where the realm has no policy. */
export function trusted(realm: object, kind: Kind, text: string): unknown {
    const p = policies.get(realm);
    if (!p) return text;
    try {
        return kind === "HTML" ? p.createHTML(text) : kind === "Script" ? p.createScript(text) : p.createScriptURL(text);
    } catch {
        return text;
    }
}

/**
 * What to hand a sink in place of the page's `given`, whose text the
 * runtime turned into `text`: a trusted value where the page gave one, the
 * string where it gave a string (the sink then judges it as natively).
 */
export function trustedLike(realm: object, kind: Kind, given: unknown, text: string): unknown {
    return typeof given === "string" || given === null || given === undefined ? text : trusted(realm, kind, text);
}

/** True when `v` is a Trusted Types value (TrustedHTML, TrustedScript, TrustedScriptURL). */
export function isTrustedValue(v: unknown): boolean {
    if (typeof v !== "object" || v === null) return false;
    const tag = ncall(nOP.toString, v);
    return tag === "[object TrustedHTML]" || tag === "[object TrustedScript]" || tag === "[object TrustedScriptURL]";
}
