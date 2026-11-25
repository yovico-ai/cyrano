// The runtime's bootstrap as HTML, for documents created from markup at
// run time (document.write, an iframe's srcdoc): the same two scripts the
// server puts at the top of every page (Go: htmlrewrite/inject.go).
//
// Each window builds its own (native/internals.ts `bootstrapHtml`): the
// written document's base URL is its creator's, so the builder of the
// window that writes it is the right one.

import { sPadStart } from "../native/intrinsics";
import type { ClientConfig } from "../config";
import { xmlBootstrap, type XmlNs } from "../xml/rewriter";

// The runtime did not load (its request failed): the document stops
// loading, so none of its scripts runs without the runtime and reaches an
// origin outside the proxy. Go: htmlrewrite.FailClosed (the same text).
export const FAIL_CLOSED = 'if(!window.$rewriter_init){window.stop();throw new Error("cyrano: runtime not loaded")}';

export function buildBootstrapHtml(config: ClientConfig, href: string, srcdocRef?: string | null): string {
    const src = config.apiBaseURL + config.source;
    // The written document has its own referrer: a srcdoc one its creator's
    // URL by the creator's policy (spec srcdocReferrer), others the browser's.
    const { referrer: _creatorsOwn, ...rest } = config;
    void _creatorsOwn;
    const childConfig = srcdocRef === undefined ? rest : { ...rest, referrer: srcdocRef ?? "" };
    const nonce = config.nonce ? ` nonce="${config.nonce.replace(/[^A-Za-z0-9+/_=-]/g, "")}"` : "";
    if (config.xb) {
        // No inline script runs under the page's policy: the second step is
        // served as a script too (Go: htmlrewrite.BootPath).
        const boot = `${config.apiBaseURL}/cyrano-boot.js?c=${encodeURIComponent(JSON.stringify(childConfig))}&u=${encodeURIComponent(href)}`;
        return `<script${nonce} src="${src}"></script><script${nonce} src="${boot.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></script>`;
    }
    return (
        `<script${nonce} src="${src}"></script>` +
        `<script${nonce}>${FAIL_CLOSED}window.$rewriter=window.$rewriter_init(window,${htmlSafeJson(childConfig)}).inject();` +
        `$rewriter.set_location(${jsStringLiteral(href)});` +
        // Both bootstrap scripts leave the document once they have run (Go: inject.go).
        `(function(s,p){p=s.previousElementSibling;if(p&&p.src&&p.tagName==="SCRIPT")p.remove();s.remove()})(document.currentScript);</script>`
    );
}

/**
 * The bootstrap for an XML document (SVG, XHTML root) at `href`: the same
 * two steps as script elements of the root's namespace (Go XMLBootstrap).
 */
export function buildXmlBootstrap(config: ClientConfig, ns: XmlNs, href: string): string {
    const { referrer: _creatorsOwn, ...childConfig } = config;
    void _creatorsOwn;
    const init = `${FAIL_CLOSED}window.$rewriter=window.$rewriter_init(window,${htmlSafeJson(childConfig)}).inject();` +
        `$rewriter.set_location(${jsStringLiteral(href)});` +
        `(function(s,p){p=s.previousElementSibling;if(p&&p.localName==="script")p.remove();s.remove()})(document.currentScript);`;
    return xmlBootstrap(ns, config.apiBaseURL + config.source, init);
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
        else if (code < 0x20) { out += "\\u00" + sPadStart(code.toString(16), 2, "0"); }
        else { out += c; }
    }
    return out + '"';
}

// JSON with HTML-safe escaping, as Go's json.Marshal (<, >, & escaped).
function htmlSafeJson(obj: unknown): string {
    return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
