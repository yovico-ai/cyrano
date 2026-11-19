import { sEnds } from "../native/intrinsics";
// Spec-compliant srcset rewriter: a port of spec/Srcset.agda, which is the
// authority. Algorithm mirrors go/src/internal/htmlrewrite/srcset.go — keep
// all three in step.
//
// Per https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute
//   - A URL ends at ASCII whitespace (tab, LF, FF, CR, space). Commas inside it
//     (e.g. Cloudflare Image Resizing /cdn-cgi/image/width=640,quality=75/...)
//     are part of it.
//   - A URL that ends in commas ends its candidate: the commas separate it from
//     the next candidate ("a.jpg, b.jpg 2x").
//   - Otherwise the descriptor runs to the next comma outside parentheses.

const isWS = (ch: string): boolean =>
    ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";

export function rewriteSrcsetAttribute(
    srcset: string,
    rewriteOne: (url: string) => string,
): string {
    const out: string[] = [];
    const emit = (u: string, desc: string): void => {
        out.push(desc === "" ? rewriteOne(u) : `${rewriteOne(u)} ${desc}`);
    };
    const cs = [...srcset];
    let i = 0;
    while (i < cs.length) {
        // Between candidates: whitespace and commas.
        if (isWS(cs[i]!) || cs[i] === ",") {
            i++;
            continue;
        }
        // The URL: up to whitespace.
        let start = i;
        while (i < cs.length && !isWS(cs[i]!)) i++;
        const u = cs.slice(start, i).join("");
        if (sEnds(u, ",")) {
            emit(u.replace(/,+$/, ""), "");
            continue;
        }
        // The descriptor: up to a comma outside parentheses.
        while (i < cs.length && isWS(cs[i]!)) i++;
        start = i;
        let paren = false;
        while (i < cs.length && (paren || cs[i] !== ",")) {
            if (cs[i] === "(") paren = true;
            else if (cs[i] === ")") paren = false;
            i++;
        }
        let end = i;
        while (end > start && isWS(cs[end - 1]!)) end--;
        emit(u, cs.slice(start, end).join(""));
    }
    return out.join(", ");
}
