// XSLTProcessor: a stylesheet's own loads — xsl:import, xsl:include, the
// document() function — are the browser's, by URLs resolved against the
// stylesheet, and its XSLT loader takes the proxy's origin only: an
// absolute URL to the origin was refused, the transform failed where
// directly it ran (spec/XmlDoc.agda rewriteXsl; xslt-processor-vs-chromium).
// importStylesheet is given a copy with those proxified (xml/rewriter.ts
// rewriteXsl), the page's own node when none changed. What the transform
// makes is inserted by the page through the runtime's insertion paths.

import { nR, ncall, nO } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";
import { rewriteXsl } from "../xml/rewriter";

export function patchXslt(targetWindow: Window, rewriteOne: (url: string) => string, unwrapOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const P = g["XSLTProcessor"]?.prototype as { importStylesheet?: unknown } | undefined;
    const Ser = g["XMLSerializer"] as (new () => { serializeToString(n: Node): string }) | undefined;
    const Parser = g["DOMParser"] as (new () => { parseFromString(s: string, t: string): Document }) | undefined;
    if (!P || typeof P.importStylesheet !== "function" || !Ser || !Parser) return;
    const serialize = Ser.prototype.serializeToString;
    const parse = Parser.prototype.parseFromString;
    const baseOf = nO.getOwnPropertyDescriptor(g["Node"]?.prototype ?? {}, "baseURI")?.get as ((this: Node) => string) | undefined;
    wrapMethod<(...a: unknown[]) => unknown>(P as object, "importStylesheet", (native, self, args) => {
        const node = args[0] as Node | null | undefined;
        let given: unknown = node;
        try {
            if (node && typeof node === "object" && (node.nodeType === 9 || node.nodeType === 1)) {
                const text = String(ncall(serialize, new Ser(), node));
                const base = unwrapOne(baseOf ? String(ncall(baseOf, node)) : "");
                const now = rewriteXsl(text, (u) => {
                    try { return rewriteOne(new URL(u, base).href); } catch { return u; }
                });
                if (now !== text) {
                    const doc = ncall(parse, new Parser(), now, "application/xml") as Document;
                    given = node.nodeType === 9 ? doc : doc.documentElement;
                }
            }
        } catch { given = node; }
        return nR.apply(native, self, [given, ...args.slice(1)]);
    });
}
