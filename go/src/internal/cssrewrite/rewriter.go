// Package cssrewrite rewrites every URL embedded in a CSS document so it
// points back at the proxy. Two URL-carrying constructs:
//
//   - url(...) function values     — `background: url("img.png")`, etc.
//   - @import "..."  / @import url(...)  — stylesheet imports
//
// Token-based via github.com/tdewolff/parse/v2/css. We don't need the full
// grammar — just to identify URL/String tokens and re-emit everything else
// verbatim. Streams cleanly: O(input size), bounded memory.
package cssrewrite

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/url"
	"strings"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/css"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Options configures one rewrite call.
type Options struct {
	BaseURL *url.URL
	Proxy   urlrewrite.ProxyConfig
	Logger  *slog.Logger // optional; logs lex/decode failures at debug level
}

// Rewrite returns a copy of src with every embedded URL routed through
// the proxy via urlrewrite.Rewrite. Returns src unchanged on lex errors,
// matching the JS rewriter's "fail open" policy — never break a page.
func Rewrite(src []byte, opts Options) []byte {
	if opts.BaseURL == nil {
		return src
	}
	l := css.NewLexer(parse.NewInputBytes(src))
	var out bytes.Buffer
	out.Grow(len(src) + len(src)/8) // rewrites grow URLs; ~12% headroom keeps allocations down

	// State: did the previous non-whitespace token open an @import? If so,
	// the next String token is the import target and needs rewriting.
	importPending := false

	for {
		tt, data := l.Next()
		if tt == css.ErrorToken {
			if err := l.Err(); err != nil && err != io.EOF {
				if opts.Logger != nil {
					opts.Logger.LogAttrs(context.Background(), slog.LevelDebug,
						"css lex failed; returning original",
						slog.String("err", err.Error()),
					)
				}
				return src
			}
			return out.Bytes()
		}

		switch tt {
		case css.URLToken:
			rewriteURLToken(&out, data, opts)
			importPending = false

		case css.StringToken:
			if importPending {
				rewriteStringToken(&out, data, opts)
				importPending = false
			} else {
				out.Write(data)
			}

		case css.AtKeywordToken:
			out.Write(data)
			importPending = strings.EqualFold(string(data), "@import")

		case css.WhitespaceToken, css.CommentToken:
			// Whitespace between @import and its string is fine — keep state.
			out.Write(data)

		default:
			out.Write(data)
			importPending = false
		}
	}
}

// rewriteURLToken transforms `url(<contents>)` — `<contents>` may be quoted
// (`url("x")`, `url('x')`) or bare (`url(x)`). We isolate the URL string,
// run it through urlrewrite.Rewrite, and re-emit with the same quoting.
func rewriteURLToken(w *bytes.Buffer, raw []byte, opts Options) {
	// Strip the `url(` prefix and `)` suffix (always present in a URLToken).
	inner := raw
	if !bytes.HasPrefix(inner, []byte("url(")) || !bytes.HasSuffix(inner, []byte(")")) {
		// Defensive — shouldn't happen for URLToken, but if it does, leave alone.
		w.Write(raw)
		return
	}
	inner = inner[4 : len(inner)-1]

	// Trim surrounding whitespace inside the parens.
	leading, trailing := splitWS(inner)
	inner = bytes.TrimSpace(inner)

	// Detect quoting and strip if present, remembering which quote to put back.
	quote := byte(0)
	if len(inner) >= 2 {
		switch inner[0] {
		case '"', '\'':
			if inner[len(inner)-1] == inner[0] {
				quote = inner[0]
				inner = inner[1 : len(inner)-1]
			}
		}
	}

	rewritten := urlrewrite.Rewrite(string(inner), opts.BaseURL, opts.Proxy)

	w.WriteString("url(")
	w.WriteString(leading)
	if quote != 0 {
		w.WriteByte(quote)
	}
	w.WriteString(rewritten)
	if quote != 0 {
		w.WriteByte(quote)
	}
	w.WriteString(trailing)
	w.WriteByte(')')
}

// rewriteStringToken handles the @import "..." case. The string token
// retains its quotes; we strip, rewrite, re-emit with the same quote char.
func rewriteStringToken(w *bytes.Buffer, raw []byte, opts Options) {
	if len(raw) < 2 {
		w.Write(raw)
		return
	}
	q := raw[0]
	if (q != '"' && q != '\'') || raw[len(raw)-1] != q {
		w.Write(raw)
		return
	}
	inner := raw[1 : len(raw)-1]
	rewritten := urlrewrite.Rewrite(string(inner), opts.BaseURL, opts.Proxy)
	w.WriteByte(q)
	w.WriteString(rewritten)
	w.WriteByte(q)
}

// splitWS returns the leading and trailing whitespace runs of s as strings.
// Used to preserve the original spacing inside `url( http://x )` etc.
func splitWS(s []byte) (leading, trailing string) {
	i := 0
	for i < len(s) && isWS(s[i]) {
		i++
	}
	leading = string(s[:i])
	j := len(s)
	for j > i && isWS(s[j-1]) {
		j--
	}
	trailing = string(s[j:])
	return
}

func isWS(b byte) bool { return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\f' }
