// document.featurePolicy as the page's own policy answers it
// (spec/Permissions.agda allows / allowlist; permissions-vs-chromium).
//
// The browser answers for the proxy's origin and the translated header:
// `allowsFeature(f, location.origin)` read false on every proxied page,
// `getAllowlistForFeature` named the proxy, and a feature the policy gives
// only other origins read allowed to the page itself. A top-level
// document answers from the origin's policy (config `pp`, parsed by the
// server); a frame's own policy also takes its container's, which the
// runtime does not model — there the page's origin is put for the
// proxy's, both ways. A feature name the browser does not know is the
// native's (false, []).

import { nO, nR, ncall, aIncludes } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";
import { allowsBy, allowlistBy, type PolicyTable } from "../url/feature-policy";

const NEVER = "https://crn-default.invalid";

export function patchFeaturePolicy(targetWindow: Window, policy: () => PolicyTable | null, docOrigin: () => string, proxyOrigin: string): void {
    const FP = (targetWindow as unknown as Record<string, { prototype: Record<string, unknown> } | undefined>)["FeaturePolicy"]?.prototype;
    if (!FP) return;
    const nat = (k: string): ((...a: unknown[]) => unknown) | undefined => {
        const d = nO.getOwnPropertyDescriptor(FP, k);
        return typeof d?.value === "function" ? (d.value as (...a: unknown[]) => unknown) : undefined;
    };
    const nAllows = nat("allowsFeature"), nList = nat("getAllowlistForFeature"), nFeatures = nat("features"), nAllowed = nat("allowedFeatures");
    if (!nAllows || !nList || !nFeatures) return;
    let isTop = false;
    try { isTop = targetWindow.top === targetWindow; } catch { isTop = false; }
    const known = (self: unknown, f: string): boolean => aIncludes(ncall(nFeatures, self) as string[], f);
    const defaultAll = (self: unknown, f: string): boolean => ncall(nAllows, self, f, NEVER) === true;
    const originArg = (o: unknown): string | null => {
        try { const u = new URL(String(o)); return u.origin === "null" ? null : u.origin; } catch { return null; }
    };
    wrapMethod<(...a: unknown[]) => unknown>(FP, "allowsFeature", (native, self, args) => {
        const r = nR.apply(native, self, args); // its argument errors, and an unknown feature's answer
        const f = String(args[0]);
        if (!known(self, f)) return r;
        const doc = docOrigin();
        const o = args.length > 1 ? originArg(args[1]) : doc;
        if (o === null) return r;
        if (!isTop) return o === doc ? ncall(native, self, f, proxyOrigin) : o === proxyOrigin ? false : r;
        return allowsBy(policy(), defaultAll(self, f), f, doc, o);
    });
    wrapMethod<(...a: unknown[]) => unknown>(FP, "getAllowlistForFeature", (native, self, args) => {
        const r = nR.apply(native, self, args) as string[];
        const f = String(args[0]);
        if (!known(self, f)) return r;
        const doc = docOrigin();
        if (!isTop) return r.map((e) => (e === proxyOrigin ? doc : e));
        return allowlistBy(policy(), defaultAll(self, f), f, doc);
    });
    if (nAllowed) {
        wrapMethod<(...a: unknown[]) => unknown>(FP, "allowedFeatures", (native, self, args) => {
            const r = nR.apply(native, self, args) as string[];
            if (!isTop) return r;
            const doc = docOrigin();
            const all = ncall(nFeatures, self) as string[];
            const out = r.slice(0, 0); // an array of the native's realm
            for (const f of all) if (allowsBy(policy(), defaultAll(self, f), f, doc, doc)) out[out.length] = f;
            return out;
        });
    }
}
