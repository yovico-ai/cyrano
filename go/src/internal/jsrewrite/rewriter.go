// Package jsrewrite rewrites JavaScript: it routes the accesses a script
// makes to the things cyrano stands in for (location, the window tree,
// document.write, eval, module specifiers, workers) through the client
// runtime's `$rewriter` helpers.
//
// The script is not re-printed. A recognizer (recognizer.go: our own
// recursive-descent parser, building no tree) finds where each rule
// applies, and the changes are spliced into the script's own text as
// marked, invertible edits (marks.go). Outside the edits every byte is the
// origin's; the client takes the edits out again wherever the page can see
// source — Function.prototype.toString, a script's text — and line numbers
// in stack traces stay true.
//
// The rules (R1…R11) are stated once, in the TS reference rewriter
// (ts/client/src/js/rewriter.ts), which the client uses for code the
// server never sees. The two are held together by the shared cases in
// spec/js-rewrite/cases.json and by an edit-for-edit comparison on a
// corpus of real scripts (splice_corpus_test.go).
//
// A script that does not parse is passed through (with its import
// specifiers proxified by a byte scan); one already rewritten is left
// alone.
package jsrewrite

import (
	"bytes"
	"context"
	"log/slog"
	"net/url"
	"strings"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

// Options toggle individual transformation rules. Defaults (zero value)
// disable everything; the caller picks the set they want.
type Options struct {
	WrapGetLocation      bool
	WrapSetLocation      bool
	WrapLocation         bool
	WrapGetTopWindow     bool
	WrapTopWindow        bool
	WrapGetParentWindow  bool
	WrapParentWindow     bool
	WrapDocumentWrite    bool
	WrapPostMessage      bool
	WrapEval             bool
	WrapEvalArg          bool
	WrapEvalMemexp       bool
	WrapMemberExpression bool
	WrapImportArg        bool
	WrapImportMetaUrl    bool
	WrapStaticImport     bool
	WrapNewWorker        bool
	// StripDebugger replaces `debugger` statements with empty ones (R12):
	// a no-op unless DevTools is open, where scripts use it to detect and
	// stall an inspector.
	StripDebugger bool

	// DebugR5At, when set, limits R5 to the accesses whose `[` is at an
	// offset it accepts (development aid: bisecting a script's edits).
	DebugR5At func(pos int) bool

	// BaseURL is the URL of the script being rewritten. When set together
	// with ProxifyURL:
	//   - WrapImportArg: string-literal import() specifiers are resolved
	//     against this URL and proxified statically at rewrite time, bypassing
	//     the client-side wrap_import_arg.
	//   - WrapStaticImport: static `import … from "…"` and `export … from "…"`
	//     specifiers are resolved and proxified inline. This fixes ES-module
	//     chunk loading where relative specifiers would otherwise resolve to
	//     the proxy origin instead of the original module base URL.
	//   - WrapImportMetaUrl: import.meta.url is replaced with a string literal
	//     containing this URL, so ES-module entry points that compute chunk
	//     paths relative to import.meta.url see the original URL.
	BaseURL    *url.URL
	ProxifyURL func(rawURL string, base *url.URL) string

	// Logger receives parse-failure and template-graft diagnostic events
	// at debug level. nil disables logging — keeps the rewriter usable
	// from tests without plumbing a logger through every call site.
	Logger *slog.Logger
}

// DefaultOptions enables every rewrite rule.
func DefaultOptions() Options {
	return Options{
		WrapGetLocation:      true,
		WrapSetLocation:      true,
		WrapLocation:         true,
		WrapGetTopWindow:     true,
		WrapTopWindow:        true,
		WrapGetParentWindow:  true,
		WrapParentWindow:     true,
		WrapDocumentWrite:    true,
		WrapPostMessage:      true,
		WrapEval:             true,
		WrapEvalArg:          true,
		WrapEvalMemexp:       true,
		WrapMemberExpression: true,
		WrapImportArg:        true,
		WrapImportMetaUrl:    true,
		WrapStaticImport:     true,
		WrapNewWorker:        true,
		StripDebugger:        true,
	}
}

// Rewrite applies the enabled rules to src and returns the rewritten
// source. If src does not parse or is already rewritten it is returned
// unchanged, so the proxy never breaks a page it cannot safely transform.
func Rewrite(src []byte, opts Options) []byte {
	if alreadyRewritten(src) {
		return src
	}
	edits, ok := jsEdits(src, &opts)
	if !ok {
		if opts.Logger != nil {
			// A warning: the script then runs unrewritten and sees the proxy.
			opts.Logger.LogAttrs(context.Background(), slog.LevelWarn, "js parse failed; passing through",
				slog.Int("size", len(src)),
				slog.String("snippet", snippet(src, 120)),
			)
		}
		// Still proxify static import/export specifiers, by a byte scan:
		// the browser would otherwise resolve them against the proxy.
		if opts.WrapStaticImport && opts.BaseURL != nil && opts.ProxifyURL != nil {
			return rewriteImportSpecifiersFallback(src, opts)
		}
		return src
	}
	return applyEdits(src, edits)
}

// Prettify parses src as JavaScript and re-emits it with statement-level
// newlines and block indentation, making minified bundles readable in
// DevTools. No semantic changes are made — only whitespace is added.
// If parsing fails, src is returned unchanged (fail-open like Rewrite).
func Prettify(src []byte) []byte {
	a, err := js.Parse(parse.NewInputBytes(src), js.Options{})
	if err != nil {
		return src
	}
	var buf bytes.Buffer
	a.JS(&buf)
	return buf.Bytes()
}

// snippet returns up to n leading bytes of src as a string with newlines
// flattened — useful for log lines.
func snippet(src []byte, n int) string {
	if len(src) > n {
		src = src[:n]
	}
	s := string(src)
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", "")
	if len(src) == n {
		s += "…"
	}
	return s
}

// alreadyRewritten short-circuits on already-rewritten input. Cheap substring scan.
func alreadyRewritten(src []byte) bool {
	return bytes.Contains(src, []byte("$rewriter.wrap_")) ||
		bytes.Contains(src, []byte("$rewriter_init("))
}

// rewriteImportSpecifiersFallback is a best-effort byte-scan fallback for
// modules that fail AST parsing. It finds `from "url"` / `from 'url'` patterns
// (including bare `import "url"` side-effect imports and export-from) and
// rewrites the specifier through ProxifyURL, leaving everything else unchanged.
//
// The scan is conservative: it only rewrites inside the first contiguous block
// of import/export statements at the top of the file (stopping at the first
// non-whitespace byte that isn't one of those keywords). This prevents false
// rewrites inside string literals or comments elsewhere in the file.
func rewriteImportSpecifiersFallback(src []byte, opts Options) []byte {
	var out []byte
	n := len(src)
	flushed := 0 // how much of src has been copied to out
	i := 0

	// flush copies src[flushed:end] to out, ensuring out is initialised.
	flush := func(end int) {
		if out == nil {
			out = make([]byte, 0, len(src)+256)
		}
		out = append(out, src[flushed:end]...)
		flushed = end
	}

	// readQuoted reads one quoted string starting at pos, returning the quote
	// char, the inner bytes, and the position after the closing quote.
	// Returns 0, nil, pos on failure.
	readQuoted := func(pos int) (byte, []byte, int) {
		if pos >= n {
			return 0, nil, pos
		}
		q := src[pos]
		if q != '"' && q != '\'' {
			return 0, nil, pos
		}
		start := pos + 1
		for p := start; p < n; p++ {
			c := src[p]
			if c == '\\' {
				p++
				continue
			}
			if c == q {
				return q, src[start:p], p + 1
			}
		}
		return 0, nil, pos // unterminated — give up
	}

	// rewriteSpecifier rewrites the quoted specifier at quotePos using
	// ProxifyURL. If the URL is unchanged, leaves src untouched.
	rewriteSpecifier := func(quotePos int) (newI int, ok bool) {
		q, inner, after := readQuoted(quotePos)
		if q == 0 {
			return quotePos, false
		}
		specifier := string(inner)
		proxified := opts.ProxifyURL(specifier, opts.BaseURL)
		if proxified == specifier {
			// URL unchanged — skip, but advance past the quoted string.
			return after, false
		}
		flush(quotePos) // copy everything up to the opening quote
		if out == nil {
			out = make([]byte, 0, len(src)+256)
		}
		out = append(out, q)
		out = append(out, proxified...)
		out = append(out, q)
		flushed = after
		return after, true
	}

	for i < n {
		// Skip whitespace and semicolons between statements.
		for i < n && (src[i] == ' ' || src[i] == '\t' || src[i] == '\r' || src[i] == '\n' || src[i] == ';') {
			i++
		}
		if i >= n {
			break
		}

		// We only touch `import` and `export` keywords.
		keyword := ""
		if i+6 <= n && string(src[i:i+6]) == "import" && (i+6 >= n || !isIdentChar(src[i+6])) {
			keyword = "import"
		} else if i+6 <= n && string(src[i:i+6]) == "export" && (i+6 >= n || !isIdentChar(src[i+6])) {
			keyword = "export"
		} else {
			// Non-import/export statement — stop scanning.
			break
		}

		i += len(keyword)

		// Scan to end of statement: find `from "url"` or a side-effect
		// `import "url"`, stopping at `;` or newline as a bail-out.
		for i < n && src[i] != ';' && src[i] != '\n' {
			// Side-effect `import "url"` — quote immediately follows import keyword+space.
			if (src[i] == '"' || src[i] == '\'') && keyword == "import" {
				i, _ = rewriteSpecifier(i)
				break
			}
			// `from "url"` or `from 'url'`
			if i+4 <= n && string(src[i:i+4]) == "from" && (i+4 >= n || !isIdentChar(src[i+4])) {
				j := i + 4
				for j < n && (src[j] == ' ' || src[j] == '\t') {
					j++
				}
				if j < n && (src[j] == '"' || src[j] == '\'') {
					i, _ = rewriteSpecifier(j)
					break
				}
			}
			i++
		}
	}

	if out == nil {
		return src
	}
	// Flush remaining src (from last rewritten specifier to end).
	out = append(out, src[flushed:]...)
	return out
}

// isIdentChar reports whether c can appear inside a JS identifier.
func isIdentChar(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '$'
}
