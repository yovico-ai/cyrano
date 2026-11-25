// Protected Audience (spec/AdAuction.agda). navigator.joinAdInterestGroup
// with another owner makes the browser fetch that owner's
// /.well-known/interest-group/permissions/ itself — outside any page, so
// outside the proxy, naming the proxy as the origin; a join it allows
// stores URLs the browser fetches later by itself, and runAdAuction fetches
// the seller's decision logic the same way. Proxied it could not work
// either: every site's groups would be the proxy origin's.
//
// Answered as Chrome answers a caller it does not allow (measured, stock
// Chrome 139): a join for the page's own origin resolves without joining,
// one for another owner rejects NotAllowedError, runAdAuction resolves
// null. A call the native refuses before it fetches anything (a required
// member missing, an owner that is not an https URL) goes to the native,
// for its own TypeError. Known difference: other members the native would
// refuse (a biddingLogicURL of another origin than the owner) are not
// judged here.

import { stacked } from "../native/stacked";
import { nO, nR, ncall } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";

export type Join = "native" | "joined" | "denied";

/** spec AdAuction.joinAnswer: complete — owner, name and lifetimeMs present; page — the page's origin. */
export function joinAnswer(complete: boolean, owner: string, page: string): Join {
    if (!complete) return "native";
    let u: URL;
    try { u = new URL(owner); } catch { return "native"; }
    if (u.protocol !== "https:") return "native";
    return u.origin === page ? "joined" : "denied";
}

const member = (o: unknown, k: string): unknown => {
    try { return (o as Record<string, unknown>)[k]; } catch { return undefined; }
};

export function patchAdAuction(targetWindow: Window, pageOrigin: () => string): void {
    const g = targetWindow as unknown as Record<string, unknown>;
    const nav = (g["Navigator"] as { prototype?: object } | undefined)?.prototype;
    if (!nav) return;
    const P = g["Promise"] as PromiseConstructor | undefined;
    const DE = g["DOMException"] as (new (m: string, n: string) => Error) | undefined;
    if (!P || !DE) return;
    const resolve = P.resolve, reject = P.reject;
    const done = (v: unknown): Promise<unknown> => ncall(resolve, P, v) as Promise<unknown>;

    if (typeof nO.getOwnPropertyDescriptor(nav, "joinAdInterestGroup")?.value === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(nav, "joinAdInterestGroup", (native, self, args) => {
            const group = args[0];
            if (typeof group !== "object" || group === null) return nR.apply(native, self, args);
            const owner = member(group, "owner");
            const complete = owner !== undefined && member(group, "name") !== undefined && member(group, "lifetimeMs") !== undefined;
            const answer = joinAnswer(complete, String(owner), pageOrigin());
            if (answer === "native") return nR.apply(native, self, args);
            if (answer === "joined") return done(undefined);
            return ncall(reject, P, stacked(new DE("Permission to join interest group denied.", "NotAllowedError")));
        });
    }
    if (typeof nO.getOwnPropertyDescriptor(nav, "runAdAuction")?.value === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(nav, "runAdAuction", (native, self, args) => {
            const config = args[0];
            const complete = typeof config === "object" && config !== null &&
                member(config, "seller") !== undefined && member(config, "decisionLogicURL") !== undefined;
            return complete ? done(null) : nR.apply(native, self, args);
        });
    }
}
