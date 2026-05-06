// @vitest-environment node
//
// URL containment parity tests. Expected outputs are byte-identical to the
// Go server's go/src/internal/urlrewrite/rewrite_test.go fixtures so any
// regression that breaks parity between the runtimes will fail here.
//
// Single-public-URL invariant: there is exactly one proxy origin
// (`config.apiBaseURL`) and every rewritten URL lands there regardless of
// the target's scheme. Two realistic shapes are exercised:
//   - dev:  http://localhost:9081       (HTTP-only local deploy)
//   - prod: https://proxy.example.com   (HTTPS via load balancer)

import { describe, expect, it } from "vitest";
import type { ClientConfig } from "../../src/config";
import {
    proxyApiBase,
    rewriteUrl,
    unwrapProxiedUrl,
} from "../../src/url/containment";

function makeConfig(apiBaseURL: string): ClientConfig {
    return {
        apiBaseURL,
        cacheKey: "",
        source: "/rewriter.js",
        secretCookieName: "crnsct",
        userDataEncryption: false,
        version: "0.0.1",
        rewrite_css_selectors: false,
    };
}

const devCfg = makeConfig("http://localhost:9081");
const prodCfg = makeConfig("https://proxy.example.com");

describe("proxyApiBase", () => {
    it("returns the dev public URL verbatim", () => {
        expect(proxyApiBase(devCfg)).toBe("http://localhost:9081");
    });
    it("returns the prod public URL verbatim", () => {
        expect(proxyApiBase(prodCfg)).toBe("https://proxy.example.com");
    });
});

describe("rewriteUrl — passthrough cases", () => {
    const base = new URL("https://example.com/");

    it("fragment-only URLs pass through", () => {
        expect(rewriteUrl("#top", base, devCfg)).toBe("#top");
    });

    const passthroughSchemes = [
        "javascript:void(0)",
        "data:image/png;base64,abc",
        "blob:https://example.com/uuid",
        "mailto:hi@example.com",
        "tel:+15551234",
        "about:blank",
    ];
    for (const raw of passthroughSchemes) {
        it(`${raw} passes through`, () => {
            expect(rewriteUrl(raw, base, devCfg)).toBe(raw);
        });
    }

    it("empty string passes through", () => {
        expect(rewriteUrl("", base, devCfg)).toBe("");
    });
});

describe("rewriteUrl — dev (http://localhost:9081)", () => {
    // Real-world case: dev proxy is HTTP-only on localhost, browsing an
    // HTTPS upstream. All proxified URLs land on the HTTP origin.
    const httpsBase = new URL("https://example.com/");

    it("absolute https URL lands on http://localhost:9081/cyrano/https/...", () => {
        const got = rewriteUrl("https://example.com/foo", httpsBase, devCfg);
        expect(got).toBe("http://localhost:9081/cyrano/https/example.com/foo");
    });

    it("relative path resolves against base, lands on dev origin", () => {
        const got = rewriteUrl("/about", httpsBase, devCfg);
        expect(got).toBe("http://localhost:9081/cyrano/https/example.com/about");
    });

    it("protocol-relative URL inherits base protocol, lands on dev origin", () => {
        const got = rewriteUrl("//cdn.example.com/script.js", httpsBase, devCfg);
        expect(got).toBe("http://localhost:9081/cyrano/https/cdn.example.com/script.js");
    });

    it("fragment is preserved on the proxified URL, not encoded inside cyrano path", () => {
        const got = rewriteUrl("https://example.com/page#section", httpsBase, devCfg);
        expect(got).toBe("http://localhost:9081/cyrano/https/example.com/page#section");
    });

    it("Wikipedia thumbnail URL — regression for cookies.json :9444 bug", () => {
        // The exact shape that broke before the single-URL refactor: an
        // HTTPS subresource on a proxified Wikipedia page used to rewrite
        // to the unreachable HTTPS port. Single-PublicURL fixes it.
        const got = rewriteUrl(
            "https://upload.wikimedia.org/wikipedia/en/foo.png",
            new URL("https://wikipedia.org/"),
            devCfg,
        );
        expect(got).toBe("http://localhost:9081/cyrano/https/upload.wikimedia.org/wikipedia/en/foo.png");
    });
});

describe("rewriteUrl — prod (https://proxy.example.com)", () => {
    const httpsBase = new URL("https://target.com/");

    it("HTTPS upstream lands on the prod public URL", () => {
        const got = rewriteUrl("https://cdn.target.com/a.js", httpsBase, prodCfg);
        expect(got).toBe("https://proxy.example.com/cyrano/https/cdn.target.com/a.js");
    });

    it("HTTP upstream still lands on the prod public URL", () => {
        // Single-public-URL invariant: the target's scheme is preserved
        // in the /cyrano/ path, not at the proxy origin.
        const httpBase = new URL("http://target.com/");
        const got = rewriteUrl("http://target.com/foo", httpBase, prodCfg);
        expect(got).toBe("https://proxy.example.com/cyrano/http/target.com/foo");
    });
});

describe("rewriteUrl — already-proxified detection", () => {
    it("a URL already on the proxy origin with /cyrano/ path is left alone (dev)", () => {
        const proxified = "http://localhost:9081/cyrano/https/example.com/";
        const onProxyBase = new URL("http://localhost:9081/");
        expect(rewriteUrl(proxified, onProxyBase, devCfg)).toBe(proxified);
    });

    it("a bare URL on the proxy origin without /cyrano/ is also left alone (static asset)", () => {
        const onProxy = "http://localhost:9081/rewriter.js";
        const onProxyBase = new URL("http://localhost:9081/");
        expect(rewriteUrl(onProxy, onProxyBase, devCfg)).toBe(onProxy);
    });

    it("default-port equivalence: explicit and implicit ports compare equal", () => {
        // Prod public URL has no explicit port; an explicit :443 form
        // pointing at the same origin is the same place.
        const explicit = "https://proxy.example.com:443/cyrano/https/example.com/";
        const got = rewriteUrl(explicit, new URL("https://example.com/"), prodCfg);
        expect(got).toBe(explicit);
    });
});

describe("rewriteUrl — virtual-origin + proxy-path double-encoding", () => {
    it("https://virtual-origin/cyrano/... is re-mapped to proxy origin, not proxified again", () => {
        // reCAPTCHA mixes virtual window.location.origin ("https://www.google.com") with a
        // real proxy path ("/cyrano/https/www.google.com/...") → must collapse, not double-encode.
        const mixed = "https://www.google.com/cyrano/https/www.google.com/recaptcha/api2/webworker.js?hl=en&v=abc";
        const base = new URL("https://www.google.com/recaptcha/api2/anchor");
        const want = "http://localhost:9081/cyrano/https/www.google.com/recaptcha/api2/webworker.js?hl=en&v=abc";
        expect(rewriteUrl(mixed, base, devCfg)).toBe(want);
    });
});

describe("unwrapProxiedUrl — inverse of rewriteUrl", () => {
    const cases: Array<[string, string]> = [
        // proxified → original
        ["http://localhost:9081/cyrano/https/example.com/foo", "https://example.com/foo"],
        ["http://localhost:9081/cyrano/https/example.com/page#section", "https://example.com/page#section"],
        // not on proxy → unchanged
        ["https://example.com/", "https://example.com/"],
        // on proxy without /cyrano/ path → unchanged
        ["http://localhost:9081/rewriter.js", "http://localhost:9081/rewriter.js"],
    ];
    for (const [proxified, expected] of cases) {
        it(`${proxified} → ${expected}`, () => {
            expect(unwrapProxiedUrl(proxified, devCfg)).toBe(expected);
        });
    }
});
