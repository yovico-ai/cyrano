import { describe, expect, it } from "vitest";

import { FEDCM_REJECT_MS, patchFedCM } from "../../src/patches/fedcm";

describe("FedCM refusal", () => {
    it("rejects with Chrome's NetworkError after the provider's round trips, not at once", async () => {
        const w = window as unknown as { CredentialsContainer?: { prototype: object } };
        if (!w.CredentialsContainer) {
            class CredentialsContainer { get(): Promise<unknown> { return Promise.resolve("native"); } }
            (w as Record<string, unknown>).CredentialsContainer = CredentialsContainer;
        }
        patchFedCM(window);
        const C = (w.CredentialsContainer as unknown as new () => { get(a: unknown): Promise<unknown> });
        const c = Object.create(C.prototype) as { get(a: unknown): Promise<unknown> };
        const t0 = Date.now();
        let ready = false;
        setTimeout(() => { ready = true; }, 20); // what GSI's button installs after calling get()
        const e = await c.get({ identity: { providers: [{ configURL: "https://idp.example/c.json", clientId: "x" }] } }).then(() => null, (x: unknown) => x as DOMException);
        expect(ready).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(FEDCM_REJECT_MS - 20);
        expect(e?.name).toBe("NetworkError");
        expect(e?.message).toBe("Error retrieving a token.");
    });
});
