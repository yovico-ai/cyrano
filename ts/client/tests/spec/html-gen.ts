// Markup for the HTML tokenization checks (spec/HtmlTok.agda): pieces
// that move token boundaries — tags whose content is raw text, foreign
// content and its integration points and breakouts, comments with their
// odd endings, CDATA, script escapes, attribute values holding markup.
// Every start tag the generator writes carries data-i="K" (K unique), so
// an element in the browser's tree names the tag it came from.

import fc from "fast-check";

const NAMES = ["div", "p", "b", "i", "span", "a", "svg", "math", "mi", "mtext", "mglyph", "g", "foreignObject", "desc", "title",
    "annotation-xml", "style", "script", "textarea", "xmp", "noscript", "iframe", "noembed", "noframes", "font", "image", "img", "br",
    "circle", "ul", "li", "h1", "em",
    // the start tags that close a <p> (HtmlTok closesP), and a button scope
    "address", "pre", "listing", "form", "hr", "h3", "H6", "plaintext", "button", "section"];
const ENDS = ["p", "br", "svg", "math", "div", "b", "style", "script", "title", "textarea", "foreignObject", "desc", "mi",
    "annotation-xml", "noscript", "iframe", "xmp", "SCRIPT", "Style"];
const ATTRS = ["", " x=\"a>b\"", " y='<p data-i=0>'", " z=<", " w=a/b", " q=\"\"", " encoding=text/html", " encoding=\"APPLICATION/XHTML+XML\"",
    " color=red", " face", " style=\"c:d\"", " STYLE=e", " =f", " \"g\"=h", " k = 'l'", " m/n", " src=x"];
const TEXT = ["x", " ", "\n", "<", "< b", "</", "</>", "</ x>", "<?php y>", "<!x>", "<![CDATA[", "]]>", "<svg><foreignObject><![CDATA[", "<math><mi><![CDATA[", "<!DOCTYPE x>", "-->",
    "<!--", "<!-->", "<!--->", "<!--a--!>", "--!>", "&lt;", "\"", "'", "<script>", "</script>", "</script ", "<!-- <script>",
    "</style>", "</title x>", "</textarea/>", "\t", "\r\n", "<a", "<1>", "<é>"];

/** Markup and the ids it gave its start tags, in order. */
export function markupArb(maxPieces = 18): fc.Arbitrary<string> {
    const piece = fc.oneof(
        { weight: 5, arbitrary: fc.tuple(fc.constantFrom(...NAMES), fc.constantFrom(...ATTRS), fc.boolean(), fc.constantFrom(...ATTRS)).map(([n, a, sc, b]) => ({ k: "start" as const, n, a: a + b, sc })) },
        { weight: 3, arbitrary: fc.constantFrom(...ENDS).map((n) => ({ k: "end" as const, n })) },
        { weight: 4, arbitrary: fc.constantFrom(...TEXT).map((t) => ({ k: "text" as const, t })) },
        { weight: 1, arbitrary: fc.constant({ k: "commented" as const }) },
    );
    return fc.array(piece, { minLength: 1, maxLength: maxPieces }).map((ps) => {
        let id = 1;
        let out = "";
        for (const p of ps) {
            if (p.k === "start") {
                // A script never runs: its type says it is data.
                const t = p.n === "script" ? " type=x" : "";
                out += `<${p.n} data-i=${id++}${t}${p.a}${p.sc ? "/" : ""}>`;
            } else if (p.k === "end") out += `</${p.n}>`;
            else if (p.k === "text") out += p.t;
            else out += `<!-- <b data-i=${id++}> -->`;
        }
        return out;
    });
}

/** Documents for where the bootstrap goes: prologues, then a body of markup. */
export function documentArb(): fc.Arbitrary<string> {
    const pro = fc.array(fc.constantFrom(
        "<!doctype html>", "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\">", "<!--c-->", " ", "\n", "<html>", "<html lang=en>",
        "<head>", "<head x=\"<body>\">", "</head>", "<meta charset=utf-8>", "<title>t</title>", "<base href=/b/>", "<body>", "<body class=k>",
        "text", "<!-- <head> -->", "<link rel=x href=y>", "<style>p{}</style>", "<noscript><p>n</p></noscript>", "<template><p>t</p></template>",
        "<svg><title>s</title></svg>", "<frameset>", "<frame>", "</html>", "<p>", "<head/>",
    ), { maxLength: 7 });
    const body = fc.array(fc.constantFrom("<div>d</div>", "x", "<p>", "<img src=data:,>", "<table><tr><td>c</td></tr></table>", "<!--e-->", "<b>b"), { maxLength: 4 });
    return fc.tuple(pro, body, fc.integer({ min: 0, max: 3 })).map(([p, b, scripts]) => {
        const parts = [...p, ...b];
        // Page scripts somewhere in it, each recording when it ran.
        for (let s = 0; s < scripts; s++) {
            const at = Math.floor(((s + 1) * parts.length) / (scripts + 1));
            parts.splice(at, 0, `<script>(window.__o=window.__o||[]).push(${s})</script>`);
        }
        return parts.join("");
    });
}

/** Elements markup is parsed in (innerHTML's context): namespace, local name, encoding. */
export const CONTEXTS: { ns: "html" | "svg" | "math"; name: string; encoding: string | null }[] = [
    { ns: "html", name: "div", encoding: null }, { ns: "html", name: "p", encoding: null }, { ns: "html", name: "textarea", encoding: null },
    { ns: "html", name: "title", encoding: null }, { ns: "html", name: "style", encoding: null }, { ns: "html", name: "script", encoding: null },
    { ns: "html", name: "noscript", encoding: null }, { ns: "html", name: "xmp", encoding: null }, { ns: "html", name: "template", encoding: null },
    { ns: "svg", name: "svg", encoding: null }, { ns: "svg", name: "g", encoding: null }, { ns: "svg", name: "foreignobject", encoding: null },
    { ns: "svg", name: "title", encoding: null }, { ns: "svg", name: "style", encoding: null },
    { ns: "math", name: "math", encoding: null }, { ns: "math", name: "mi", encoding: null },
    { ns: "math", name: "annotation-xml", encoding: null }, { ns: "math", name: "annotation-xml", encoding: "text/html" },
];
