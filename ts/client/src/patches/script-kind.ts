// What a <script> is (HTML "prepare the script element"): spec/Html.agda
// scriptKind, which is the authority (checked against Chromium); Go:
// htmlrewrite.ScriptKindFor. The JavaScript MIME type match is made on the
// type with ASCII whitespace stripped; module, importmap and
// speculationrules on the type as written (case aside).

export type ScriptKind = "classic" | "module" | "importmap" | "speculationrules" | "data";

const JS_ESSENCES = new Set([
    "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
    "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
    "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
    "text/x-ecmascript", "text/x-javascript",
]);

const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const strip = (s: string): string => s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");

/** The kind of a script with these type and language attributes (null: absent). */
export function scriptKind(type: string | null, language: string | null): ScriptKind {
    if (type === "" || (type === null && (language === null || language === ""))) return "classic";
    if (type === null) return JS_ESSENCES.has(lower(strip("text/" + language))) ? "classic" : "data";
    if (JS_ESSENCES.has(lower(strip(type)))) return "classic";
    const t = lower(type);
    if (t === "module" || t === "importmap" || t === "speculationrules") return t;
    return "data";
}

/** The kind of this script element. */
export function scriptKindOf(el: Element): ScriptKind {
    return scriptKind(el.getAttribute("type"), el.getAttribute("language"));
}
