// initWorker builds the `$rewriter`-equivalent object for a Worker's own
// global scope. Tests pass a fake `scope` object (not the real globalThis) so
// they never touch the test process's actual fetch/XHR globals.

import { describe, expect, it, vi } from "vitest";
import type { ClientConfig } from "../../src/config";
import { initWorker } from "../../src/runtime/worker-bootstrap";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    cacheKey: "",
    source: "/rewriter.js",
    secretCookieName: "crnsct",
    userDataEncryption: false,
    version: "0.0.1",
    rewrite_css_selectors: false,
};

function makeFakeScope() {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    // `open` must live on the prototype (not as an instance class field) so
    // patchWorkerScope's prototype patch actually intercepts calls made
    // through `new FakeXHR().open(...)` — an instance field would shadow it.
    class FakeXHR {
        declare open: (...args: unknown[]) => void;
    }
    const openSpy = vi.fn();
    FakeXHR.prototype.open = openSpy;
    const importScriptsSpy = vi.fn();
    const scope = {
        fetch: fetchSpy as unknown as typeof fetch,
        XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest,
        importScripts: importScriptsSpy,
    };
    return { scope, fetchSpy, openSpy, importScriptsSpy };
}

describe("initWorker — location", () => {
    it("wrap_get_location masks the worker's real (blob:) location with the upstream URL", () => {
        const { scope } = makeFakeScope();
        const api = initWorker(config, "https://claude.ai/cdn-cgi/challenge-platform/worker", scope);
        const loc = api.wrap_get_location(undefined);
        expect(loc.href).toBe("https://claude.ai/cdn-cgi/challenge-platform/worker");
        expect(loc.host).toBe("claude.ai");
    });

    it("wrap_set_location rewrites the assigned value through the URL containment logic", () => {
        const { scope } = makeFakeScope();
        const setter = vi.fn();
        const api = initWorker(config, "https://claude.ai/", scope);
        const assignable = api.wrap_set_location(undefined, setter);
        assignable.value = "https://claude.ai/other";
        expect(setter).toHaveBeenCalledWith(
            "http://localhost:9081/cyrano/https/claude.ai/other",
        );
    });
});

describe("initWorker — wrap_member_expression", () => {
    it("dispatches obj['location'] to the wrapped location when obj looks location-bearing", () => {
        const { scope } = makeFakeScope();
        const api = initWorker(config, "https://claude.ai/", scope);
        const result = api.wrap_member_expression({ location: {} }, "location") as { location: unknown };
        expect((result.location as { host: string }).host).toBe("claude.ai");
    });

    it("passes through unrelated properties unchanged", () => {
        const { scope } = makeFakeScope();
        const api = initWorker(config, "https://claude.ai/", scope);
        const obj = { foo: "bar" };
        expect(api.wrap_member_expression(obj, "foo")).toBe(obj);
    });
});

describe("initWorker — eval", () => {
    it("wrap_eval_arg rewrites a string source argument", () => {
        const { scope } = makeFakeScope();
        const api = initWorker(config, "https://claude.ai/", scope);
        const rewritten = api.wrap_eval_arg(eval, "location.href");
        expect(rewritten).toContain("$rewriter.wrap_get_location");
    });
});

describe("initWorker — patches the worker's own fetch/XHR/importScripts", () => {
    it("rewrites a bare-path fetch to the proxified upstream URL", async () => {
        const { scope, fetchSpy } = makeFakeScope();
        initWorker(config, "https://claude.ai/cdn-cgi/challenge-platform/x", scope);

        await scope.fetch("/cdn-cgi/challenge-platform/h/g/ci/rayid/1/tok");

        expect(fetchSpy).toHaveBeenCalledWith(
            "http://localhost:9081/cyrano/https/claude.ai/cdn-cgi/challenge-platform/h/g/ci/rayid/1/tok",
            undefined,
        );
    });

    it("rewrites the URL argument of XMLHttpRequest.open", () => {
        const { scope, openSpy } = makeFakeScope();
        initWorker(config, "https://claude.ai/cdn-cgi/challenge-platform/x", scope);

        const xhr = new scope.XMLHttpRequest();
        xhr.open("GET", "/cdn-cgi/challenge-platform/h/g/pat/rayid/1/tok");

        expect(openSpy).toHaveBeenCalledWith(
            "GET",
            "http://localhost:9081/cyrano/https/claude.ai/cdn-cgi/challenge-platform/h/g/pat/rayid/1/tok",
        );
    });

    it("rewrites importScripts URL arguments before delegating", () => {
        const { scope, importScriptsSpy } = makeFakeScope();
        initWorker(config, "https://claude.ai/cdn-cgi/challenge-platform/x", scope);

        scope.importScripts("/cdn-cgi/challenge-platform/h/g/extra.js");

        expect(importScriptsSpy).toHaveBeenCalledWith(
            "http://localhost:9081/cyrano/https/claude.ai/cdn-cgi/challenge-platform/h/g/extra.js",
        );
    });

    it("does nothing when the scope has no fetch/XHR/importScripts", () => {
        expect(() => initWorker(config, "https://claude.ai/", {})).not.toThrow();
    });
});
