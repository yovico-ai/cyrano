import { sIncludes } from "../native/intrinsics";
// Invertible edits.
//
// The JS rewriters do not re-print a script: they splice their changes into
// its text, each change written as
//
//     /*␡ORIGINAL*/NEW/*␡*/
//
// where ␡ stands for U+007F (DELETE: one ASCII byte, so the format is the same
// in every ASCII-compatible charset a script may be served in, and a
// character scripts do not contain), NEW is the inserted code and ORIGINAL
// the text it replaces (empty for a pure insertion). Everything
// outside these fragments is the page's own bytes, untouched — so removing
// the fragments and putting each ORIGINAL back gives the script exactly as
// the origin sent it. That is what Function.prototype.toString, a script
// element's text and anything else that shows source to the page answer
// with (`original`), and why line numbers in stack traces stay true: a
// fragment never adds a line.
//
// A fragment is never split by a function's source range, except that the
// closing marker after the last token of an arrow function's expression
// body falls outside it; `original` treats a fragment cut short there as
// ending with the text.
//
// The marker character may occur in a script (obfuscated string tables use
// every byte); what must not is the sequence `/*␡` or `*␡/`, which would
// read as a marker of ours. Such a script — none has been seen — is
// rewritten without markers (`canMark`), and its source reads back
// rewritten.
//
// Go: internal/jsrewrite/marks.go.

export const MARK = "\x7f";
const OPEN = "/*" + MARK;
const CLOSE = OPEN + "*/";

/** Whether `src` can carry marked fragments: it has nothing that reads as one. */
export function canMark(src: string): boolean {
    return !sIncludes(src, OPEN) && !sIncludes(src, "*" + MARK + "/");
}

/**
 * One edit as text: `replaced` is what the page had there ("" for an
 * insertion). `afterSlash`: the source character before it is `/` — a
 * division, which would join the fragment's `/*` into `//`, a line
 * comment. The fragment then starts with a space, and says so with a
 * doubled marker so that the space is taken out again.
 */
export function fragment(inserted: string, replaced: string, afterSlash = false): string {
    return (afterSlash ? " " + OPEN + MARK : OPEN) + replaced.split("*/").join("*" + MARK + "/") + "*/" + inserted + CLOSE;
}

/** The script as the page wrote it: every fragment replaced by its original text. */
export function original(text: string): string {
    let a = text.indexOf(OPEN);
    if (a < 0) return text;
    let out = "";
    let i = 0;
    while (a >= 0) {
        let from = a + OPEN.length;
        let upTo = a;
        if (text.charAt(from) === MARK) { // a doubled marker: the space before it is ours
            from++;
            if (upTo > i && text.charAt(upTo - 1) === " ") upTo--;
        }
        const b = text.indexOf("*/", from);
        if (b < 0) break;
        out += text.slice(i, upTo) + text.slice(from, b).split("*" + MARK + "/").join("*/");
        const c = text.indexOf(CLOSE, b + 2);
        if (c < 0) return out; // cut short: the fragment runs to the end
        i = c + CLOSE.length;
        a = text.indexOf(OPEN, i);
    }
    return out + text.slice(i);
}

/** The rewritten code without its markers (what runs, minus comments): for tests and logs. */
export function unmarked(text: string): string {
    let a = text.indexOf(OPEN);
    if (a < 0) return text;
    let out = "";
    let i = 0;
    while (a >= 0) {
        const b = text.indexOf("*/", a + OPEN.length);
        if (b < 0) break;
        out += text.slice(i, a);
        i = b + 2;
        a = text.indexOf(OPEN, i);
    }
    return out + text.slice(i);
}
