// Client-side CSS rewriter.
//
// Mirrors go/src/internal/cssrewrite/. Only two URL-carrying constructs need
// rewriting:
//   - `url(...)` function values     (e.g. `background: url("img.png")`)
//   - `@import "..."` / `@import url(...)`  (stylesheet imports)
//
// We use regex-based scanning rather than a full CSS tokenizer. The two
// patterns above are well-bounded; the cost of a real tokenizer (css-tree
// is ~80 KB unminified) outweighs its correctness gain for this narrow task.
// Edge cases the regex flags as out-of-scope:
//   - URLs containing closing parentheses inside escaped sequences. Real CSS
//     escapes are rare in URL contexts; the regex matches up to the next `)`
//     which is what every browser does anyway.
//   - data: URLs are routed through the rewriter, which the URL-containment
//     layer recognizes and passes through unchanged.
//
// Used by:
//   - `patches/dynamic-html.ts` for inline `<style>` content and the
//     `style="..."` attribute.
//   - `patches/css-rules.ts` for `CSSStyleSheet.insertRule`.

// `url(...)` matcher:
//   `url(`      literal
//   `\s*`       optional whitespace
//   then either:
//     `"<contents>"` or `'<contents>'`  — quoted, with escape support
//     `<contents>`                       — unquoted, no whitespace or `)`
//   `\s*\)`     optional whitespace, closing paren
//
// Captures: [1] double-quoted, [2] single-quoted, [3] unquoted. Exactly one
// of the three is set on each match.
const URL_FUNCTION_RE = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)\s]+))\s*\)/g;

// `@import "..."` matcher (excludes the `@import url(...)` form, which is
// already matched by URL_FUNCTION_RE in the first pass).
//
// Captures: [1] double-quoted, [2] single-quoted.
const IMPORT_STRING_RE = /@import\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g;

/**
 * Rewrites every URL embedded in a CSS source string. Returns the input
 * unchanged when:
 *   - input is empty or non-string,
 *   - no URLs are found.
 *
 * Quoting (`"foo"`, `'foo'`, bare `foo`) is preserved on each rewritten URL.
 */
export function rewriteCssText(
    src: string,
    rewriteOne: (url: string) => string,
): string {
    if (typeof src !== "string" || src.length === 0) return src;

    // Pass 1: rewrite all url(...) values, preserving the original quoting.
    const afterUrlPass = src.replace(URL_FUNCTION_RE, (
        _match: string,
        doubleQuoted?: string,
        singleQuoted?: string,
        unquoted?: string,
    ): string => {
        if (doubleQuoted !== undefined) {
            return `url("${rewriteOne(doubleQuoted)}")`;
        }
        if (singleQuoted !== undefined) {
            return `url('${rewriteOne(singleQuoted)}')`;
        }
        // Unquoted form: rewriteOne might introduce characters that need
        // quoting in CSS (e.g. spaces or parens). Wrap in double quotes
        // defensively.
        return `url("${rewriteOne(unquoted ?? "")}")`;
    });

    // Pass 2: rewrite the `@import "..."` form (the `@import url(...)` form
    // was already handled by pass 1).
    const afterImportPass = afterUrlPass.replace(IMPORT_STRING_RE, (
        _match: string,
        doubleQuoted?: string,
        singleQuoted?: string,
    ): string => {
        if (doubleQuoted !== undefined) {
            return `@import "${rewriteOne(doubleQuoted)}"`;
        }
        return `@import '${rewriteOne(singleQuoted ?? "")}'`;
    });

    return afterImportPass;
}
