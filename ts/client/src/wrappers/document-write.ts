// Wrapper for `*.write` / `*.writeln` calls.
//
// IMPORTANT: the server's WRAP_DOCUMENT_WRITE rule fires on ANY `.write` /
// `.writeln` member-access — not just `document.write`. The transformation is
//   obj.write(...args)  →  $rewriter.wrap_document_write({obj: obj}).write(...args)
// regardless of what `obj` is. The runtime can't know at AST-rewrite time
// whether the target is the document, a Node.js-style Writable stream, a
// WebSocket-ish wrapper, or some library's own object.
//
// So this wrapper has two jobs:
//   1. When `obj` is a Document — rewrite HTML through the mini-rewriter
//      before passing it to the document parser (the case that matters for
//      URL containment).
//   2. Otherwise — forward the args verbatim. The caller didn't mean
//      Document.write semantics; corrupting their data (e.g. a binary write
//      to a stream) would be catastrophic.
//
// We type `arg.obj` as `unknown` and gate behavior on a runtime Document
// check (`nodeType === 9`, the spec value for DOCUMENT_NODE). Cross-realm
// safe — doesn't depend on `instanceof Document` against this realm's class.

import { rewriteHtmlString } from "../patches/html-rewriter";

export interface DocumentWriteWrapper {
    write: (...args: unknown[]) => unknown;
    writeln: (...args: unknown[]) => unknown;
}

interface WriteCapable {
    write?: (...args: unknown[]) => unknown;
    writeln?: (...args: unknown[]) => unknown;
    nodeType?: number;
}

const DOCUMENT_NODE = 9;

function isDocumentLike(obj: unknown): obj is Document {
    return obj !== null
        && typeof obj === "object"
        && (obj as { nodeType?: number }).nodeType === DOCUMENT_NODE;
}

export function wrapDocumentWrite(
    arg: { obj: unknown },
    rewriteOne: (url: string) => string,
): DocumentWriteWrapper {
    const target = arg.obj as WriteCapable | null;

    return {
        write: (...args: unknown[]): unknown => {
            if (!target || typeof target.write !== "function") return undefined;
            if (isDocumentLike(target) && allStrings(args)) {
                const joined = (args as string[]).join("");
                return target.write(rewriteHtmlString(joined, rewriteOne));
            }
            // Not a document, or not all-string args — forward verbatim.
            return target.write(...args);
        },
        writeln: (...args: unknown[]): unknown => {
            if (!target || typeof target.writeln !== "function") return undefined;
            if (isDocumentLike(target) && allStrings(args)) {
                const joined = (args as string[]).join("");
                return target.writeln(rewriteHtmlString(joined, rewriteOne));
            }
            return target.writeln(...args);
        },
    };
}

function allStrings(args: unknown[]): boolean {
    for (const a of args) {
        if (typeof a !== "string") return false;
    }
    return true;
}
