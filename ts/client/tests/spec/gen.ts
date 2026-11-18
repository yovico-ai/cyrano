// Generators for the conformance properties: strings built from pieces on
// the rules' edges. The Go suite (go/src/internal/specoracle/gen.go)
// draws from the same pieces; keep the two lists alike so both runtimes
// face the same edges.

import fc from "fast-check";

export const proxies = ["http://localhost:9081", "https://proxy.example.com"];
export const bases = [
    "https://example.com/p/", "https://example.com/p/q?x=1#h", "http://other.org/",
    "https://example.com", "https://example.com/a/b/c", "wss://socket.example.com/s",
];
const schemeToks = ["http:", "https:", "HTTPS:", "Http:", "ws:", "wss:"];
const slashToks = ["//", "//", "//", "///", "\\\\", "/\\", "/", ""];
const userToks = ["", "", "", "u@", "u:p@", "@"];
const hostToks = [
    "example.com", "EXAMPLE.com", "a.b-c.org", "cdn.example.com", "localhost",
    "1.2.3.4", "x_y.com", "google.com", "proxy.example.com", ".", "..",
];
const oddHosts = [
    "[::1]", "0x7f.1", "%41.com", "exämple.com", "1.2.3", "",
    "{x}", "a`\"b", "%7Bx%7D", "%2541.com", "a%3Ab", "1.2.3.%34", "%C3%A9.com", "xn--a.com", "xn--9ca.com", "%", "%zz",
    "[1:0:0:2::3]", "[::ffff:1.2.3.4]", "[ABCD::EF]", "[::]", "0x7f.0.0.1", "4294967295", "1.2.3.4.", "[::1%251]", "08.1", "[1::2::3]",
];
const portToks = ["", "", "", ":80", ":443", ":0080", ":8080", ":9081", ":", ":99999", ":x"];
const segToks = [
    "a", "b", "index.html", ".", "..", "%2e", "%2E%2e", "a b", "é", "a%2Fb",
    "cyrano", "https", "q,w", "{x}", "`", "\"", "<>", "'", "^|", "", "日本", "😀",
];
const queryToks = ["", "", "?", "?q=1", "?q=1 2", "?a='b'", "?é", "?%20", "?x=`{}`"];
const fragToks = ["", "", "#", "#x", "#x y", "#x%20y", "#é", "#`", "#a#b", "#\"q\""];
const padToks = ["", "", "", " ", "\t", "\n", " \x01", "\r\n"];
const otherToks = [
    "javascript:void(0)", "JavaScript:x", "java\nscript:x", "data:image/png;base64,AA",
    "blob:https://x/1", "mailto:a@b", "tel:+1", "about:blank", "ftp://h/x", "c:foo",
    "localhost:9081/x", "#top", "#", "", "   ",
];
const cyranoSchemes = ["http", "https", "ws", "wss", "ftp", "x", "", "HTTPS"];
const cyranoHosts = ["example.com", "H.com:443", "a.b:8080", ""];

const pick = (xs: string[]) => fc.constantFrom(...xs);

const path = fc
    .array(fc.tuple(pick(["/", "/", "\\"]), pick(segToks)), { maxLength: 4 })
    .map((parts) => parts.map(([sep, seg], i) => (i > 0 ? sep : "") + seg).join(""));

const host = fc.oneof(
    { weight: 4, arbitrary: pick(hostToks) },
    { weight: 1, arbitrary: pick(oddHosts) },
);

const qf = fc.tuple(pick(queryToks), pick(fragToks)).map(([q, f]) => q + f);

const cat = (...parts: fc.Arbitrary<string>[]) =>
    fc.tuple(...parts).map((xs) => xs.join(""));
const lit = (s: string) => fc.constant(s);

/** A URL as it might appear in a page. */
export function url(proxy: string): fc.Arbitrary<string> {
    const body = fc.oneof(
        { weight: 2, arbitrary: cat(pick(schemeToks), pick(slashToks), pick(userToks), host, pick(portToks), lit("/"), path, qf) },
        { weight: 1, arbitrary: cat(pick(["//", "\\\\", "///"]), host, pick(portToks), lit("/"), path, qf) },
        { weight: 1, arbitrary: cat(lit("/"), path, qf) },
        { weight: 1, arbitrary: cat(path, qf) },
        { weight: 1, arbitrary: pick(otherToks) },
        { weight: 1, arbitrary: cat(lit(proxy), pick(["/cyrano/https/example.com/a", "/other", "/cyrano", "/cyrano/", "/cyrano/x/h/y"]), qf) },
        { weight: 2, arbitrary: cat(lit("https://"), host, lit("/cyrano/"), pick(cyranoSchemes), lit("/"), pick(cyranoHosts), lit("/"), path, qf) },
    );
    return cat(pick(padToks), body, pick(padToks));
}

/** What page code might read back from location.href and the like. */
export function proxiedHref(proxy: string): fc.Arbitrary<string> {
    return fc.oneof(
        { weight: 3, arbitrary: cat(lit(proxy + "/cyrano/"), pick(cyranoSchemes), lit("/"), pick(cyranoHosts), pick(["", "/"]), path, qf) },
        { weight: 1, arbitrary: cat(lit(proxy + "/"), path, qf) },
        { weight: 1, arbitrary: cat(lit("https://"), host, lit("/cyrano/https/example.com/"), path, qf) },
        { weight: 1, arbitrary: pick(["about:blank", "not a url", "", "javascript:x", "/cyrano/https/h/x"]) },
    );
}

const srcURLs = ["a.jpg", "b.png", "/cdn-cgi/image/w=640,q=75/x.jpg", "https://x.com/y.jpg", "a,b.jpg", "img.jpg,", "c.jpg,,", "(p).jpg"];
const srcDescs = ["", "", "1x", "2x", "640w", "1x  foo", "(a, b)", "1.5x", "1x (c"];
const srcWS = [" ", " ", "\t", "\n", "\f", "\v", "  ", "\r"];
const srcSeps = [",", ", ", " ,", ",,", " , ", ",\n"];

/** A srcset attribute value. */
export const srcset: fc.Arbitrary<string> = fc
    .tuple(
        pick(["", "", " ", ",", "\n "]),
        fc.array(fc.tuple(pick(srcSeps), pick(srcURLs), pick(srcWS), pick(srcDescs)), { maxLength: 4 }),
        pick(["", "", " ", ",", "\t"]),
    )
    .map(([lead, cands, trail]) =>
        lead +
        cands.map(([sep, u, ws, d], i) => (i > 0 ? sep : "") + u + (d !== "" ? ws + d : "")).join("") +
        trail);
