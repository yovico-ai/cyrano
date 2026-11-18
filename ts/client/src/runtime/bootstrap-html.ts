// The runtime's bootstrap as HTML, for documents created from markup at
// run time (document.write, an iframe's srcdoc): the same two scripts the
// server puts at the top of every page (Go: htmlrewrite/inject.go).
//
// Each window builds its own (native/internals.ts `bootstrapHtml`): the
// written document's base URL is its creator's, so the builder of the
// window that writes it is the right one.

import type { ClientConfig } from "../config";

export function buildBootstrapHtml(config: ClientConfig, href: string): string {
    const src = config.apiBaseURL + config.source;
    // The written document has its own referrer: its creator's URL.
    const { referrer: _creatorsOwn, ...childConfig } = config;
    void _creatorsOwn;
    const nonce = config.nonce ? ` nonce="${config.nonce.replace(/[^A-Za-z0-9+/_=-]/g, "")}"` : "";
    return (
        `<script${nonce} src="${src}"></script>` +
        `<script${nonce}>window.$rewriter=window.$rewriter_init(window,${htmlSafeJson(childConfig)}).inject();` +
        `$rewriter.set_location(${jsStringLiteral(href)});` +
        // Both bootstrap scripts leave the document once they have run (Go: inject.go).
        `(function(s,p){p=s.previousElementSibling;if(p&&p.src&&p.tagName==="SCRIPT")p.remove();s.remove()})(document.currentScript);</script>`
    );
}

// A double-quoted JS string literal safe inside a <script> block: escapes
// \, ", control characters, and < (no </script> breakout).
function jsStringLiteral(s: string): string {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        const c = s[i]!;
        if (c === "\\") { out += "\\\\"; }
        else if (c === '"') { out += '\\"'; }
        else if (c === "\n") { out += "\\n"; }
        else if (c === "\r") { out += "\\r"; }
        else if (c === "\t") { out += "\\t"; }
        else if (c === "<") { out += "\\x3c"; }
        else if (code < 0x20) { out += "\\u00" + code.toString(16).padStart(2, "0"); }
        else { out += c; }
    }
    return out + '"';
}

// JSON with HTML-safe escaping, as Go's json.Marshal (<, >, & escaped).
function htmlSafeJson(obj: unknown): string {
    return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
